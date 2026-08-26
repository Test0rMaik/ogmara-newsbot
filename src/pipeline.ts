/**
 * The run pipeline: drain queue → poll → filter → compose → publish → record.
 *
 * One run publishes at most one post. That is deliberate — the bot's whole
 * failure mode is volume, and "one item per scheduled tick" makes cadence a
 * scheduling question the operator controls with a cron expression, rather than
 * an emergent property of how many items a feed happened to publish.
 *
 * The queue is drained *before* polling: a post that was composed earlier and
 * blocked on a rate limit has already been paid for, so publishing it takes
 * priority over composing something new.
 */

import type { AiProvider } from './ai/index.js';
import { loadTemplate, renderTemplate } from './ai/prompt.js';
import type { Config } from './config.js';
import { isNearDuplicate } from './dedup.js';
import { buildTags } from './hashtags.js';
import { Ledger } from './ledger.js';
import { MAX_TITLE_BYTES, type ComposedPost, type OgmaraPublisher } from './ogmara.js';
import type { PostQueue } from './queue.js';
import type { Candidate, Source } from './sources/types.js';

/** What happened during one pipeline run. */
export type RunOutcome =
  | { status: 'posted'; title: string; msgId: string; fromQueue: boolean }
  | { status: 'dry-run'; post: ComposedPost }
  | { status: 'nothing-new'; polled: number }
  | { status: 'refused'; title: string; category?: string | undefined }
  | { status: 'rate-limited'; retryAfterMs: number; queued: number };

/**
 * Trim a headline to the protocol's byte cap.
 *
 * Cuts on a word boundary where possible — a headline severed mid-word reads
 * like a bug. Operates on bytes because the cap is bytes, and headlines contain
 * plenty of non-ASCII.
 */
export function truncateTitle(title: string, maxBytes = MAX_TITLE_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(title).length <= maxBytes) return title;

  const ELLIPSIS = '…';
  // The ellipsis is 3 UTF-8 bytes, not 1 — reserving a single byte for it
  // produced titles that overshot the cap by exactly 2 bytes.
  const budget = maxBytes - encoder.encode(ELLIPSIS).length;

  // Iterate code points rather than UTF-16 units: slicing by unit can sever a
  // surrogate pair and emit a lone half, which is invalid UTF-8. Headlines do
  // contain emoji and astral-plane characters.
  const chars = Array.from(title);
  let end = chars.length;
  while (end > 0 && encoder.encode(chars.slice(0, end).join('')).length > budget) {
    end--;
  }
  let out = chars.slice(0, end).join('');

  // Prefer a word boundary, but only when it doesn't discard most of what fits
  // — with one very long word there is no good boundary and a mid-word cut
  // beats returning almost nothing.
  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > out.length * 0.6) out = out.slice(0, lastSpace);

  return `${out.trimEnd()}${ELLIPSIS}`;
}

/** Build the tag list an operator's config demands, ahead of AI suggestions. */
function requiredTags(config: Config): string[] {
  const required = [...config.posting.alwaysTags];
  if (config.posting.disclosureTag !== null) required.unshift(config.posting.disclosureTag);
  return required;
}

/** Append the attribution line to AI-written body text. */
function withAttribution(content: string, candidate: Candidate, config: Config): string {
  if (!config.posting.includeSourceLink || candidate.url === undefined) return content;
  const via = candidate.publisher ?? 'source';
  return `${content}\n\nvia [${via}](${candidate.url})`;
}

/**
 * Compose a post from a candidate using the configured AI provider.
 *
 * Returns `null` when the model declined the item — expected periodically on a
 * general news feed, and handled by skipping rather than retrying, since a
 * retry would decline again.
 *
 * The attribution link is appended *after* composition rather than asked for in
 * the prompt: models reword URLs, and a subtly mangled source link is worse
 * than no link.
 */
export async function composeWithAi(
  candidate: Candidate,
  config: Config,
  provider: AiProvider,
  template: string,
): Promise<ComposedPost | null> {
  const prompt = renderTemplate(template, {
    TITLE: candidate.title,
    SUMMARY: candidate.summary ?? '(no summary provided)',
    PUBLISHER: candidate.publisher ?? 'unknown',
    MAX_TITLE_BYTES: MAX_TITLE_BYTES,
    TARGET_CONTENT_CHARS: config.ai.targetContentChars,
    MAX_TAGS: config.ai.maxTags,
  });

  const result = await provider.compose({
    prompt,
    maxTitleBytes: MAX_TITLE_BYTES,
    targetContentChars: config.ai.targetContentChars,
    maxTags: config.ai.maxTags,
  });

  if (result.status === 'refused') return null;

  const content = withAttribution(result.content, candidate, config);
  return {
    // The model is asked to respect the cap, but it is guidance to a model, not
    // a guarantee — enforce it here where it is one.
    title: truncateTitle(result.title),
    content,
    tags: buildTags({
      required: requiredTags(config),
      suggested: result.tags,
      title: result.title,
      content: result.content,
    }),
  };
}

/** Dependencies for {@link runOnce}. */
export interface PipelineDeps {
  config: Config;
  sources: readonly Source[];
  ledger: Ledger;
  queue: PostQueue;
  publisher: OgmaraPublisher;
  provider: AiProvider;
  /** Pre-loaded prompt template, so a run doesn't re-read it from disk. */
  template: string;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Execute one pipeline run.
 *
 * Filtering order matters: the exact-key check runs before the similarity
 * check because it is O(1) and catches the common case (re-reading the same
 * feed), leaving the O(n) comparison for genuinely new items only.
 */
export async function runOnce(deps: PipelineDeps): Promise<RunOutcome> {
  const { config, sources, ledger, queue, publisher, provider, template } = deps;
  const now = deps.now ?? Date.now;

  // 1. A queued post has already cost an AI call — publish it before composing
  //    anything new.
  const queued = queue.next(now());
  if (queued !== undefined) {
    const result = await publisher.publish(queued.post);
    switch (result.status) {
      case 'dry-run':
        return { status: 'dry-run', post: queued.post };
      case 'published':
        queue.remove(queued.key);
        ledger.record({
          key: queued.key,
          title: queued.sourceTitle,
          msgId: result.msgId,
          postedAt: now(),
          kind: queued.kind,
        });
        return { status: 'posted', title: queued.post.title, msgId: result.msgId, fromQueue: true };
      case 'rate-limited':
        queue.recordAttempt(queued.key);
        return { status: 'rate-limited', retryAfterMs: result.retryAfterMs, queued: queue.size };
    }
  }

  // 2. Nothing queued — find something new.
  const candidates: Candidate[] = [];
  for (const source of sources) {
    try {
      candidates.push(...(await source.poll()));
    } catch (err) {
      console.error(`  source "${source.name}" failed:`, err instanceof Error ? err.message : err);
    }
  }

  const recentTitles = ledger.recentTitles();
  const fresh = candidates.find(
    (c) =>
      !ledger.has(c.dedupKey) && !queue.has(c.dedupKey) && !isNearDuplicate(c.title, recentTitles),
  );

  if (fresh === undefined) {
    return { status: 'nothing-new', polled: candidates.length };
  }

  const post = await composeWithAi(fresh, config, provider, template);
  if (post === null) {
    // Record the refusal in the ledger so the bot doesn't re-compose (and
    // re-pay for) the same declined item on every subsequent run.
    ledger.record({
      key: fresh.dedupKey,
      title: fresh.title,
      postedAt: now(),
      kind: fresh.kind,
    });
    return { status: 'refused', title: fresh.title };
  }

  const result = await publisher.publish(post);
  switch (result.status) {
    case 'dry-run':
      // Deliberately not recorded. A dry run must be repeatable — recording it
      // would mean the item is skipped once you go live, silently swallowing
      // the first real post.
      return { status: 'dry-run', post };

    case 'published':
      ledger.record({
        key: fresh.dedupKey,
        title: fresh.title,
        msgId: result.msgId,
        postedAt: now(),
        kind: fresh.kind,
      });
      return { status: 'posted', title: post.title, msgId: result.msgId, fromQueue: false };

    case 'rate-limited':
      // Park the composed post rather than discarding it: recomposing would
      // mean a second AI call for output already paid for, and the source item
      // may have scrolled out of the feed by the next run.
      queue.enqueue(
        { key: fresh.dedupKey, sourceTitle: fresh.title, kind: fresh.kind, post },
        now(),
      );
      return { status: 'rate-limited', retryAfterMs: result.retryAfterMs, queued: queue.size };
  }
}

export { loadTemplate };
