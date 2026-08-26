/**
 * The run pipeline: poll → filter → compose → publish → record.
 *
 * One run posts at most one item. That is deliberate — the bot's whole failure
 * mode is volume, and "one item per scheduled tick" makes cadence a scheduling
 * question the operator controls with a cron expression, rather than an
 * emergent property of how many items a feed happened to publish.
 */

import type { Config } from './config.js';
import { isNearDuplicate } from './dedup.js';
import { buildTags } from './hashtags.js';
import { Ledger } from './ledger.js';
import type { ComposedPost, OgmaraPublisher } from './ogmara.js';
import type { Candidate, Source } from './sources/types.js';

/** What happened during one pipeline run. */
export type RunOutcome =
  | { status: 'posted'; title: string; msgId: string }
  | { status: 'dry-run'; post: ComposedPost }
  | { status: 'nothing-new'; polled: number }
  | { status: 'rate-limited'; retryAfterMs: number };

/**
 * Compose a post from a candidate.
 *
 * Placeholder for the AI composer arriving in P2. It already produces the
 * final post *shape* — attribution included, tags normalized — so swapping in
 * a real composer changes how the prose is written, not how posts are built.
 */
export function composeFromCandidate(candidate: Candidate, config: Config): ComposedPost {
  const parts: string[] = [];
  if (candidate.summary !== undefined && candidate.summary.length > 0) {
    parts.push(candidate.summary);
  }

  // Attribution is not optional for feed-derived posts: republishing someone
  // else's reporting without a link is both rude and a copyright problem.
  if (config.posting.includeSourceLink && candidate.url !== undefined) {
    const via = candidate.publisher !== undefined ? `${candidate.publisher}` : 'source';
    parts.push(`\nvia [${via}](${candidate.url})`);
  }

  const content = parts.join('\n');
  const required = [...config.posting.alwaysTags];
  if (config.posting.disclosureTag !== null) required.unshift(config.posting.disclosureTag);

  return {
    title: truncateTitle(candidate.title),
    content: content.length > 0 ? content : candidate.title,
    tags: buildTags({ required, title: candidate.title, content }),
  };
}

/**
 * Trim a headline to the protocol's 256-byte title cap.
 *
 * Cuts on a word boundary where possible — a headline severed mid-word reads
 * like a bug. Operates on bytes because the cap is bytes, and headlines contain
 * plenty of non-ASCII.
 */
export function truncateTitle(title: string, maxBytes = 256): string {
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

/** Dependencies for {@link runOnce}. */
export interface PipelineDeps {
  config: Config;
  sources: readonly Source[];
  ledger: Ledger;
  publisher: OgmaraPublisher;
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
  const { config, sources, ledger, publisher } = deps;
  const now = deps.now ?? Date.now;

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
    (c) => !ledger.has(c.dedupKey) && !isNearDuplicate(c.title, recentTitles),
  );

  if (fresh === undefined) {
    return { status: 'nothing-new', polled: candidates.length };
  }

  const post = composeFromCandidate(fresh, config);
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
      return { status: 'posted', title: post.title, msgId: result.msgId };

    case 'rate-limited':
      return { status: 'rate-limited', retryAfterMs: result.retryAfterMs };
  }
}
