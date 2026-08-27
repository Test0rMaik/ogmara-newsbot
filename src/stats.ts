/**
 * Full-history engagement aggregation, for the dashboard's history chart.
 *
 * `panel/posts.ts`'s `fetchPostStats` only ever reads the most recent
 * `DASHBOARD_POST_LIMIT` posts (the "Recent posts" list doesn't need more).
 * A chart snapshot needs a real lifetime total, so this paginates through
 * the bot's *entire* post history via the same `getUserPosts` endpoint —
 * bounded by `maxPostsScanned` as a safety cap, since the response is the
 * node's word (see `panel/posts.ts`'s trust-boundary note, which applies
 * here identically) and nothing stops a compromised or simply very active
 * node from returning far more than expected.
 */

import { sumReactionCounts, type GetUserPosts } from './panel/posts.js';

/** Aggregate engagement across (up to) a wallet's entire post history. */
export interface AggregatedStats {
  totalReactions: number;
  totalReposts: number;
  totalComments: number;
  /** The node's own lifetime post count, from the first page's `total` — not clamped by `maxPostsScanned`. */
  totalPosts: number;
}

/**
 * How long one aggregation pass is allowed to run before it stops early with
 * whatever it has scanned so far, rather than continuing indefinitely.
 *
 * `maxPostsScanned` bounds request *count*, not wall-clock time — a node
 * that stalls each request near its own timeout can still stretch even a
 * modest page count arbitrarily, and this now runs unattended (a scheduled
 * job, plus once at startup — see `index.ts`), with no operator watching to
 * notice a stuck run. (Security + code audits, 0.11.0.)
 */
export const DEFAULT_SCAN_DEADLINE_MS = 60_000;

/**
 * A non-negative finite number from node-controlled data, or 0.
 *
 * Mirrors `panel/posts.ts`'s `sumReactionCounts`, which already rejects
 * non-finite/negative values for exactly this reason — a bad or compromised
 * node can encode `NaN`/`Infinity` in a msgpack payload (impossible in JSON,
 * which is why this is easy to miss), and an unguarded arithmetic sum
 * propagates it through every downstream computation. The chart in
 * particular renders completely blank, with no error, if a single snapshot
 * ever contains one. (Code audit, 0.11.0.)
 */
function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Sum reactions/reposts/comments across every post the node reports, page by
 * page, stopping at whichever comes first: a short final page,
 * `maxPostsScanned`, or `deadlineMs` of wall-clock time. `totalPosts` in the
 * result is the node's own reported total from the first page — independent
 * of the scan cap — so it stays accurate even for an account with more
 * history than one aggregation pass will walk.
 */
export async function aggregateAllPostStats(
  getUserPosts: GetUserPosts,
  address: string,
  pageSize: number,
  maxPostsScanned: number,
  deadlineMs: number = DEFAULT_SCAN_DEADLINE_MS,
): Promise<AggregatedStats> {
  let totalReactions = 0;
  let totalReposts = 0;
  let totalComments = 0;
  let scanned = 0;
  let totalPosts = 0;
  let page = 1;
  const startedAt = Date.now();

  for (;;) {
    const response = await getUserPosts(address, { page, limit: pageSize });
    if (page === 1) totalPosts = finiteCount(response.total);

    const posts = Array.isArray(response.posts)
      ? (response.posts.slice(0, pageSize) as Array<Record<string, unknown>>)
      : [];
    if (posts.length === 0) break;

    for (const raw of posts) {
      totalReactions += sumReactionCounts(raw['reaction_counts']);
      totalReposts += finiteCount(raw['repost_count']);
      totalComments += finiteCount(raw['comment_count']);
      scanned++;
    }

    if (posts.length < pageSize) break; // last page
    if (scanned >= maxPostsScanned) break; // safety cap on request count
    if (Date.now() - startedAt >= deadlineMs) break; // safety cap on wall-clock time
    page++;
  }

  return { totalReactions, totalReposts, totalComments, totalPosts };
}
