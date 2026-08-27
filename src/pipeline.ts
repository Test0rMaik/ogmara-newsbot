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
import { capText, fenceUntrusted, loadTemplate, newFenceMarker, renderTemplate } from './ai/prompt.js';
import type { Config } from './config.js';
import { isNearDuplicate } from './dedup.js';
import { buildTags } from './hashtags.js';
import { Ledger } from './ledger.js';
import { uploadImage, validateImageOnly } from './media.js';
import { MAX_TITLE_BYTES, type ComposedPost, type OgmaraPublisher } from './ogmara.js';
import type { PostQueue } from './queue.js';
import { readFileSync } from 'node:fs';
import type { Candidate, Source, SourceKind } from './sources/types.js';

/** What happened during one pipeline run. */
export type RunOutcome =
  | { status: 'posted'; title: string; msgId: string; fromQueue: boolean }
  | { status: 'dry-run'; post: ComposedPost }
  | { status: 'nothing-new'; polled: number }
  | { status: 'refused'; title: string; category?: string | undefined }
  | { status: 'compose-failed'; title: string; reason: string }
  | {
      status: 'deferred';
      /** Why publication was deferred, for an accurate operator message. */
      cause: 'local-budget' | 'node-rate-limit' | 'transport';
      retryAfterMs: number;
      queued: number;
      detail?: string | undefined;
    };

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
  // Start at `budget` rather than the full length: every code point encodes to
  // at least one UTF-8 byte, so no prefix longer than `budget` characters can
  // fit in `budget` bytes. Without this the loop re-encodes the whole prefix on
  // every step and is quadratic — 50k chars took 11.8 s, which a local model
  // stuck in a repetition loop reaches easily. (Audit 2026-08-26, M18.)
  let end = Math.min(chars.length, budget);
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
 * How many consecutive compose failures to tolerate for one item before
 * marking it seen and moving on.
 *
 * Bounded so a poisoned item cannot monopolise every run, but not 1, because
 * this path also carries transient failures and giving up immediately would
 * discard legitimate items on a blip.
 */
export const MAX_COMPOSE_FAILURES = 3;

/** Outcome of composing one candidate. */
export type ComposeOutcome =
  | { status: 'ok'; post: ComposedPost }
  | { status: 'refused'; category?: string | undefined; explanation?: string | undefined };

/**
 * Compose a post from a candidate using the configured AI provider.
 *
 * Returns a `refused` outcome — carrying the provider's category — when the
 * model declined the item. Expected periodically on a general news feed, and
 * handled by skipping rather than retrying, since a retry would decline again.
 *
 * This previously returned `null`, which discarded the category all three
 * providers went to the trouble of extracting and made the documented
 * `Model declined … (cyber)` message structurally impossible to produce.
 * (Audit 2026-08-26, CODE-W9.)
 *
 * The attribution link is appended *after* composition rather than asked for in
 * the prompt: models reword URLs, and a subtly mangled source link is worse
 * than no link.
 */
export async function composeWithAi(
  candidate: Candidate,
  config: Config,
  provider: AiProvider,
  templates: Templates,
): Promise<ComposeOutcome> {
  const common = {
    MAX_TITLE_BYTES: MAX_TITLE_BYTES,
    TARGET_CONTENT_CHARS: config.ai.targetContentChars,
    MAX_TAGS: config.ai.maxTags,
  };

  let prompt: string;
  let image: { data: Uint8Array; mimeType: string } | undefined;

  switch (candidate.kind) {
    case 'rss': {
      // Cap, then fence. Both untrusted fields go inside one fence with a
      // per-call random marker; the publisher name is bot-side config or the
      // feed's own <title>, so it stays outside. See fenceUntrusted for why.
      const marker = newFenceMarker();
      const item = [
        `Headline: ${capText(candidate.title, config.ai.maxSourceTitleChars)}`,
        '',
        'Summary:',
        capText(candidate.summary ?? '(no summary provided)', config.ai.maxSourceSummaryChars),
      ].join('\n');
      prompt = renderTemplate(templates.rss, {
        ...common,
        FENCED_ITEM: fenceUntrusted(item, marker),
        PUBLISHER: capText(candidate.publisher ?? 'unknown', 200),
      });
      break;
    }

    case 'topics':
      // No fence: the topic is the operator's own text, not remote input.
      prompt = renderTemplate(templates.topics, { ...common, TOPIC: candidate.title });
      break;

    case 'imagedir': {
      if (candidate.imagePath === undefined || candidate.imageMimeType === undefined) {
        throw new Error('image candidate is missing its path or MIME type');
      }
      image = { data: readFileSync(candidate.imagePath), mimeType: candidate.imageMimeType };
      // No untrusted text at all — the model sees only the picture and the
      // operator's own prompt.
      prompt = renderTemplate(templates.imagedir, common);
      break;
    }
  }

  const result = await provider.compose({
    prompt,
    ...(image !== undefined ? { image } : {}),
    maxTitleBytes: MAX_TITLE_BYTES,
    targetContentChars: config.ai.targetContentChars,
    maxTags: config.ai.maxTags,
  });

  if (result.status === 'refused') {
    return {
      status: 'refused',
      ...(result.category !== undefined ? { category: result.category } : {}),
      ...(result.explanation !== undefined ? { explanation: result.explanation } : {}),
    };
  }

  // Attribution is for feed items only: a topic post has no source, and an
  // image from a local folder has no publisher to credit.
  const content =
    candidate.kind === 'rss' ? withAttribution(result.content, candidate, config) : result.content;
  return {
    status: 'ok',
    post: {
      // The model is asked to respect the cap, but it is guidance to a model,
      // not a guarantee — enforce it here where it is one.
      title: truncateTitle(result.title),
      content,
      tags: buildTags({
        required: requiredTags(config),
        suggested: result.tags,
        title: result.title,
        content: result.content,
      }),
    },
  };
}

/** Prompt templates, one per source kind, pre-loaded at startup. */
export type Templates = Readonly<Record<SourceKind, string>>;

/** Dependencies for {@link runOnce}. */
export interface PipelineDeps {
  config: Config;
  sources: readonly Source[];
  ledger: Ledger;
  queue: PostQueue;
  publisher: OgmaraPublisher;
  provider: AiProvider;
  /** Pre-loaded prompt templates, so a run doesn't re-read them from disk. */
  templates: Templates;
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
  const { config, sources, ledger, queue, publisher, provider, templates } = deps;
  const now = deps.now ?? Date.now;

  const runStartedAt = now();

  // 1. A queued post has already cost an AI call — publish it before composing
  //    anything new.
  const queued = queue.next(runStartedAt);
  if (queued !== undefined) {
    const result = await publisher.publish(queued.post, runStartedAt);
    switch (result.status) {
      case 'dry-run':
        // Drop it from the queue even in dry run: otherwise the same parked
        // post is re-rendered on every tick and the operator never sees a new
        // composition until it expires. (Audit 2026-08-26.)
        queue.remove(queued.key);
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
      case 'throttled-locally':
        // NOT an attempt. This is the bot declining to publish yet, not a
        // failure — counting it would drop a valid paid-for post after N
        // ticks of a cadence the operator chose. (Audit 2026-08-26, M8.)
        return deferred('local-budget', result.retryAfterMs, queue.size);
      case 'rate-limited':
        queue.recordAttempt(queued.key);
        return deferred('node-rate-limit', result.retryAfterMs, queue.size);
      case 'transport-error':
        queue.recordAttempt(queued.key);
        return deferred('transport', result.retryAfterMs, queue.size, result.reason);
    }
  }

  // 2. Nothing queued — find something new.
  const candidates: Candidate[] = [];
  for (const source of sources) {
    try {
      const result = await source.poll();
      // push() rather than push(...spread): spreading passes every item as an
      // argument and throws RangeError on a pathologically large feed.
      for (const c of result.candidates) candidates.push(c);
      for (const w of result.warnings) console.warn(`  warning: ${w}`);
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

  let composed: ComposeOutcome;
  try {
    composed = await composeWithAi(fresh, config, provider, templates);
  } catch (err) {
    // A compose failure must not abort the run and leave the item unrecorded:
    // candidates are sorted newest-first, so `find` would return the same
    // poisoned item on every tick, publishing nothing and billing an API call
    // each time — indefinitely, since a future-dated item never ages out.
    //
    // But it must not be ledgered outright either. This path also carries
    // transient failures (a flaky JSON parse, a rethrown 5xx), and the ledger
    // has no un-record operation, so recording here would silently and
    // permanently drop legitimate items. A bounded per-item failure count is
    // the middle ground. (Audit 2026-08-26, M6.)
    const reason = err instanceof Error ? err.message : String(err);
    const failures = ledger.recordFailure(fresh.dedupKey, now());
    console.error(
      `  compose failed for "${fresh.title.slice(0, 60)}" ` +
        `(attempt ${failures}/${MAX_COMPOSE_FAILURES}): ${reason}`,
    );
    if (failures >= MAX_COMPOSE_FAILURES) {
      console.error('  giving up on this item and marking it seen.');
      ledger.record({ key: fresh.dedupKey, title: fresh.title, postedAt: now(), kind: fresh.kind });
    }
    return { status: 'compose-failed', title: fresh.title, reason };
  }

  if (composed.status === 'refused') {
    // Record the refusal in the ledger so the bot doesn't re-compose (and
    // re-pay for) the same declined item on every subsequent run.
    ledger.record({
      key: fresh.dedupKey,
      title: fresh.title,
      postedAt: now(),
      kind: fresh.kind,
    });
    return {
      status: 'refused',
      title: fresh.title,
      ...(composed.category !== undefined ? { category: composed.category } : {}),
    };
  }
  const post = composed.post;

  // Upload after composing, not before: if the model refuses or the compose
  // fails, an upload would have pinned bytes to IPFS for a post that never
  // exists. Composition is also the likelier of the two to fail.
  if (fresh.imagePath !== undefined && fresh.imageMimeType !== undefined) {
    try {
      // Dry run validates the image but does not upload it. Pinning bytes to
      // IPFS for a post that is never published is a real side effect, and
      // "dry run" promises none. Everything except the network write is still
      // exercised, and the render says the upload was skipped so the operator
      // is not left thinking it was proven.
      const attachment = config.posting.dryRun
        ? await validateImageOnly(fresh.imagePath, fresh.imageMimeType, config.sources.imagedir.maxBytes)
        : await uploadImage(
            publisher.client,
            fresh.imagePath,
            fresh.imageMimeType,
            config.sources.imagedir.maxBytes,
          );
      post.attachments = [attachment];
      const rating = config.sources.imagedir.contentRating;
      if (rating !== undefined) post.contentRating = rating;
    } catch (err) {
      // Publishing an image post with no image would be worse than skipping
      // it — the caption references a picture the reader cannot see.
      const reason = err instanceof Error ? err.message : String(err);
      const failures = ledger.recordFailure(fresh.dedupKey, now());
      console.error(`  image upload failed (attempt ${failures}/${MAX_COMPOSE_FAILURES}): ${reason}`);
      if (failures >= MAX_COMPOSE_FAILURES) {
        console.error('  giving up on this image and marking it seen.');
        ledger.record({ key: fresh.dedupKey, title: fresh.title, postedAt: now(), kind: fresh.kind });
      }
      return { status: 'compose-failed', title: fresh.title, reason };
    }
  }

  // Park the composed post rather than discarding it on any deferral:
  // recomposing means a second AI call for output already paid for, and the
  // source item may have scrolled out of the feed by the next run.
  const park = (): void => {
    queue.enqueue({ key: fresh.dedupKey, sourceTitle: fresh.title, kind: fresh.kind, post }, now());
  };

  const result = await publisher.publish(post, runStartedAt);
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

    case 'throttled-locally':
      park();
      return deferred('local-budget', result.retryAfterMs, queue.size);

    case 'rate-limited':
      park();
      return deferred('node-rate-limit', result.retryAfterMs, queue.size);

    case 'transport-error':
      // Previously this threw and escaped before the post could be queued,
      // discarding output an AI call had already been paid for.
      park();
      return deferred('transport', result.retryAfterMs, queue.size, result.reason);
  }
}

/** Build a `deferred` outcome. */
function deferred(
  cause: 'local-budget' | 'node-rate-limit' | 'transport',
  retryAfterMs: number,
  queued: number,
  detail?: string,
): RunOutcome {
  return { status: 'deferred', cause, retryAfterMs, queued, ...(detail !== undefined ? { detail } : {}) };
}

export { loadTemplate };
