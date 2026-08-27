/**
 * Recent-posts and engagement stats for the control panel's dashboard.
 *
 * `GET /api/v1/users/:address/posts` (the l2-node handler behind
 * `OgmaraClient.getUserPosts`) already returns each post enriched
 * server-side with `reaction_counts`, `repost_count` and `comment_count` —
 * verified directly against the l2-node source (`get_user_posts` in
 * `src/api/routes.rs`), because @ogmara/sdk's own TypeScript declarations
 * don't tell the whole story here: they omit `repost_count`/`comment_count`
 * entirely, and type `payload` as `string` when the node actually returns it
 * as a raw byte array (a `Vec<u8>` serialized by `serde_json`). Both are
 * accessed here with a local, verified-correct shape rather than the
 * package's declared one.
 *
 * The trust boundary this module actually sits on: the *request* is
 * well-scoped (the bot's own address, never user-supplied), but the
 * *response* is entirely the node's word — there is no signature or
 * content-address check on what comes back, and `config.node.url` is
 * operator-configured with nothing pinning it to a trusted node. A
 * malicious, compromised, or simply buggy node can return arbitrary bytes
 * claiming to be "the bot's own posts", and this module has no way to tell.
 * Every parse below is written for that reality — not, as an earlier
 * version of this comment claimed, as unnecessary caution against data the
 * bot supposedly authored itself.
 */

import { decode } from '@msgpack/msgpack';

/** How many recent posts the dashboard tab shows. */
export const DASHBOARD_POST_LIMIT = 25;

/**
 * Caps for the msgpack decoder, matching the web client's own
 * (`web/src/lib/payload.ts`) — required, not optional insurance, given the
 * trust boundary above. `@msgpack/msgpack` defaults every `max*` option to
 * UINT32_MAX, so decoding without these could force gigabytes of allocation
 * from a single hostile payload before any check of ours runs.
 */
const SAFE_DECODE_OPTIONS = {
  maxStrLength: 1 << 20,
  maxBinLength: 1 << 16,
  maxArrayLength: 256,
  maxMapLength: 64,
  maxExtLength: 1 << 16,
};

/** Longest raw payload byte array this will even attempt to decode. */
const MAX_PAYLOAD_BYTES = SAFE_DECODE_OPTIONS.maxStrLength;

/** Longest title shown, and longest + most tags counted, per post. */
const MAX_TITLE_CHARS = 200;
const MAX_TAG_CHARS = 32;
const MAX_TAGS_PER_POST = 10;

/**
 * Unicode control and bidi-override codepoints, stripped from any node-
 * supplied text before display — same ranges the web client's `stripBidi`
 * uses (`web/src/lib/sanitize.ts`), reproduced locally since that's a
 * separate repo. A hostile node could otherwise craft a post title with a
 * U+202E override to visually reverse or spoof what's displayed; `.textContent`
 * already stops it from executing anything, this stops it from lying about
 * what it says.
 */
const CONTROL_AND_BIDI_RE = new RegExp(
  '[' +
    '\\u0000-\\u001F\\u007F-\\u009F' +
    '\\u200E\\u200F' +
    '\\u202A-\\u202E' +
    '\\u2066-\\u2069' +
    '\\u2028\\u2029' +
    '\\uFEFF' +
  ']',
  'g',
);

function cleanText(value: string, maxChars: number): string {
  return value.replace(CONTROL_AND_BIDI_RE, '').slice(0, maxChars);
}

/** One post as decoded and enriched for display. */
export interface RecentPost {
  msgId: string;
  /** Unix milliseconds. */
  timestamp: number;
  title: string;
  tags: string[];
  /** Sum across every reaction emoji — one number for "how much engagement", not a breakdown. */
  reactionCount: number;
  repostCount: number;
  commentCount: number;
}

/** Aggregate stats plus the post list, for the dashboard tab. */
export interface PostStats {
  posts: RecentPost[];
  /** Total ever published, per the node's own count — not limited by `limit`. */
  totalPublished: number;
  /** Hashtag → number of the fetched posts using it (not lifetime — see fetchPostStats). */
  hashtagCounts: Record<string, number>;
  /** Timestamp of the most recent post, or null if there are none yet. */
  lastPostedAt: number | null;
}

/** The subset of `OgmaraClient.getUserPosts` this module actually needs — see the DI note below. */
export type GetUserPosts = (
  address: string,
  options: { page: number; limit: number },
) => Promise<{ posts: unknown[]; total: number }>;

/**
 * Decode a raw msgpack payload defensively — anything unexpected, oversized,
 * or malformed yields empty fields, never a throw. `title`/`tags` are
 * cleaned and length-capped here too, since this is the one point every
 * post's text passes through regardless of caller.
 */
function decodePayload(payload: unknown): { title?: string | undefined; tags?: string[] | undefined } {
  let bytes: Uint8Array;
  if (payload instanceof Uint8Array) {
    if (payload.length > MAX_PAYLOAD_BYTES) return {};
    bytes = payload;
  } else if (Array.isArray(payload)) {
    // Length-capped BEFORE the scan/conversion below — otherwise an
    // oversized array pays for a full `.every()` pass and a full-size
    // `Uint8Array` copy before the decoder's own caps ever get a chance to
    // reject it.
    if (payload.length > MAX_PAYLOAD_BYTES) return {};
    if (!payload.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) {
      return {};
    }
    bytes = new Uint8Array(payload);
  } else {
    return {};
  }

  try {
    const decoded = decode(bytes, SAFE_DECODE_OPTIONS);
    if (typeof decoded !== 'object' || decoded === null) return {};
    const obj = decoded as Record<string, unknown>;

    const title = typeof obj['title'] === 'string' ? cleanText(obj['title'], MAX_TITLE_CHARS) : undefined;
    const tags = Array.isArray(obj['tags'])
      ? obj['tags']
          .filter((t): t is string => typeof t === 'string')
          .map((t) => cleanText(t, MAX_TAG_CHARS))
          .filter((t) => t.length > 0)
          .slice(0, MAX_TAGS_PER_POST)
      : undefined;

    return { title, tags };
  } catch {
    return {};
  }
}

/**
 * Sum every emoji's count in a `{emoji: count}` map into one total.
 *
 * Reaction/repost/comment counts are the one field in this module NOT
 * derived from the bot's own content — they're aggregated by the node from
 * third parties reacting to a post — so a value here reflects the node's
 * bookkeeping (or a misbehaving node), not anything the bot ever wrote.
 * Rejecting non-finite/negative values stops a bad node turning this into
 * `Infinity` or `NaN` on the dashboard.
 */
function sumReactionCounts(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  let total = 0;
  for (const count of Object.values(value as Record<string, unknown>)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

/**
 * Fetch the bot's most recent posts and tally engagement + hashtag usage
 * across them.
 *
 * `getUserPosts` is injected as a narrow function — the same pattern
 * `PanelDeps` already uses for `checkRegistration`/`applyProfile`/
 * `registerWallet` — so tests can supply fixture post data without
 * constructing a real `OgmaraClient` or reaching a live node.
 *
 * Hashtag counts are only across the fetched page, not the bot's lifetime —
 * accurate lifetime counts would need every post ever published, which is
 * a much larger fetch for a dashboard number. Labelled as such in the UI.
 */
export async function fetchPostStats(
  getUserPosts: GetUserPosts,
  address: string,
  limit: number,
): Promise<PostStats> {
  const response = await getUserPosts(address, { page: 1, limit });

  // The response envelope itself is node-controlled, same as every field
  // inside it — `posts` absent/null/wrong-shaped must not throw, and a count
  // far exceeding what was actually requested must not be trusted either
  // (an honest node clamps server-side; nothing stops a compromised one
  // returning more, which would otherwise run N synchronous decodes on the
  // bot's single event loop, stalling the scheduler and publisher for the
  // duration).
  const raw = Array.isArray(response.posts)
    ? (response.posts.slice(0, limit) as Array<Record<string, unknown>>)
    : [];

  const posts: RecentPost[] = raw.map((p) => {
    const decoded = decodePayload(p['payload']);
    return {
      msgId: typeof p['msg_id'] === 'string' ? p['msg_id'] : '',
      timestamp: typeof p['timestamp'] === 'number' ? p['timestamp'] : 0,
      title: decoded.title ?? '(untitled)',
      tags: decoded.tags ?? [],
      reactionCount: sumReactionCounts(p['reaction_counts']),
      repostCount: typeof p['repost_count'] === 'number' ? p['repost_count'] : 0,
      commentCount: typeof p['comment_count'] === 'number' ? p['comment_count'] : 0,
    };
  });

  // `Object.create(null)` rather than `{}`: a hostile node could put a tag
  // literally named "constructor" or "toString" in a post, and a plain
  // object literal would resolve that against `Object.prototype` instead of
  // treating it as a fresh key — visible as `hashtagCounts.constructor`
  // holding a bogus count in the JSON response and corrupting the sort on
  // the dashboard. `__proto__` itself is a no-op assignment target on a
  // plain object (verified) rather than actual prototype pollution, but
  // there's no reason to rely on that distinction when the fix is free.
  const hashtagCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const post of posts) {
    // Deduped per post: two identical tags on one post should count that
    // post once for that hashtag ("posts using it"), not twice.
    for (const tag of new Set(post.tags)) {
      hashtagCounts[tag] = (hashtagCounts[tag] ?? 0) + 1;
    }
  }

  return {
    posts,
    totalPublished: typeof response.total === 'number' ? response.total : posts.length,
    hashtagCounts,
    // The node documents get_user_posts as reverse-chronological, so posts[0]
    // is the newest — but re-deriving it rather than trusting that ordering
    // blindly costs nothing and survives that assumption ever drifting.
    // A reduce, not `Math.max(...posts.map(...))`: spreading into Math.max
    // blows the call stack once the array is large enough, and the array's
    // size is the node's choice, not this function's — see the `raw` comment
    // above for why that can't be assumed bounded by `limit` alone.
    lastPostedAt:
      posts.length > 0 ? posts.reduce((max, p) => Math.max(max, p.timestamp), 0) : null,
  };
}
