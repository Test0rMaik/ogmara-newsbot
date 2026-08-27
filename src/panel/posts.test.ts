import { encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';
import { fetchPostStats, type GetUserPosts } from './posts.js';

/** Build a raw post object shaped exactly like l2-node's get_user_posts JSON. */
function rawPost(overrides: Partial<{
  msg_id: string;
  timestamp: number;
  payload: { title: string; tags: string[] };
  reaction_counts: Record<string, number>;
  repost_count: number;
  comment_count: number;
}> = {}): Record<string, unknown> {
  const payload = overrides.payload ?? { title: 'Untitled', tags: [] };
  return {
    msg_id: overrides.msg_id ?? 'abc123',
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
    // Real msgpack bytes, as an array of numbers — exactly how serde_json
    // serializes a Rust Vec<u8>, which is the actual wire shape (not the
    // `payload: string` the SDK's own types incorrectly declare).
    payload: Array.from(encode(payload)),
    reaction_counts: overrides.reaction_counts ?? {},
    repost_count: overrides.repost_count ?? 0,
    comment_count: overrides.comment_count ?? 0,
  };
}

describe('fetchPostStats', () => {
  it('decodes a real msgpack-encoded payload back to title and tags', async () => {
    const getUserPosts: GetUserPosts = async () => ({
      posts: [rawPost({ payload: { title: 'Klever news roundup', tags: ['klever', 'crypto'] } })],
      total: 1,
    });
    const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
    expect(stats.posts).toHaveLength(1);
    expect(stats.posts[0]!.title).toBe('Klever news roundup');
    expect(stats.posts[0]!.tags).toEqual(['klever', 'crypto']);
  });

  it('sums reaction_counts across every emoji into one engagement number', async () => {
    const getUserPosts: GetUserPosts = async () => ({
      posts: [rawPost({ reaction_counts: { '👍': 3, '❤️': 2, '🔥': 1 } })],
      total: 1,
    });
    const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
    expect(stats.posts[0]!.reactionCount).toBe(6);
  });

  it('carries repost_count and comment_count through even though the SDK does not declare them', async () => {
    const getUserPosts: GetUserPosts = async () => ({
      posts: [rawPost({ repost_count: 4, comment_count: 7 })],
      total: 1,
    });
    const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
    expect(stats.posts[0]!.repostCount).toBe(4);
    expect(stats.posts[0]!.commentCount).toBe(7);
  });

  it('tallies hashtag usage across every fetched post', async () => {
    const getUserPosts: GetUserPosts = async () => ({
      posts: [
        rawPost({ msg_id: '1', payload: { title: 'a', tags: ['klever', 'news'] } }),
        rawPost({ msg_id: '2', payload: { title: 'b', tags: ['klever'] } }),
        rawPost({ msg_id: '3', payload: { title: 'c', tags: [] } }),
      ],
      total: 3,
    });
    const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
    expect(stats.hashtagCounts).toEqual({ klever: 2, news: 1 });
  });

  it('reports totalPublished from the node, independent of the fetched page size', async () => {
    // The node's `total` reflects EVERY post ever, not just this page — a
    // dashboard asking for the last 25 must still show the true lifetime
    // count, not just "25".
    const getUserPosts: GetUserPosts = async () => ({
      posts: [rawPost()],
      total: 9001,
    });
    const stats = await fetchPostStats(getUserPosts, 'klv1bot', 1);
    expect(stats.totalPublished).toBe(9001);
  });

  it('reports lastPostedAt as the most recent timestamp regardless of array order', async () => {
    const getUserPosts: GetUserPosts = async () => ({
      posts: [
        rawPost({ msg_id: '1', timestamp: 1000 }),
        rawPost({ msg_id: '2', timestamp: 5000 }),
        rawPost({ msg_id: '3', timestamp: 3000 }),
      ],
      total: 3,
    });
    const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
    expect(stats.lastPostedAt).toBe(5000);
  });

  it('reports lastPostedAt as null with no posts, not 0 or NaN', async () => {
    const getUserPosts: GetUserPosts = async () => ({ posts: [], total: 0 });
    const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
    expect(stats.lastPostedAt).toBeNull();
    expect(stats.posts).toEqual([]);
    expect(stats.hashtagCounts).toEqual({});
  });

  describe('malformed or hostile payloads never throw', () => {
    it('falls back to a placeholder title when the payload is not valid msgpack', async () => {
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: [255, 255, 255, 255, 0, 1, 2] }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.title).toBe('(untitled)');
      expect(stats.posts[0]!.tags).toEqual([]);
    });

    it('handles a payload that is neither a byte array nor a Uint8Array', async () => {
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: 'not-bytes-at-all' }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.title).toBe('(untitled)');
    });

    it('handles a decoded payload whose tags field is not an array', async () => {
      const bytes = Array.from(encode({ title: 'ok', tags: 'not-an-array' }));
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: bytes }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.title).toBe('ok');
      expect(stats.posts[0]!.tags).toEqual([]);
    });

    it('filters out non-string entries from a mixed tags array rather than crashing', async () => {
      const bytes = Array.from(encode({ title: 'ok', tags: ['real', 123, null, 'also-real'] }));
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: bytes }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.tags).toEqual(['real', 'also-real']);
    });

    it('treats a non-numeric reaction_counts value as zero rather than NaN', async () => {
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), reaction_counts: { '👍': 'not-a-number' } }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.reactionCount).toBe(0);
    });

    it('treats missing msg_id/timestamp fields as safe defaults, not undefined leaking through', async () => {
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ payload: Array.from(encode({ title: 'x', tags: [] })) }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.msgId).toBe('');
      expect(stats.posts[0]!.timestamp).toBe(0);
    });
  });

  describe('the node response is not a trusted source, and is handled accordingly', () => {
    it('clamps the returned posts array to the requested limit rather than trusting the node', async () => {
      // An honest node clamps server-side; nothing stops a compromised one
      // returning more, which would otherwise run one synchronous msgpack
      // decode per extra post on the bot's single event loop.
      const getUserPosts: GetUserPosts = async () => ({
        posts: Array.from({ length: 500 }, (_, i) => rawPost({ msg_id: String(i) })),
        total: 500,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts).toHaveLength(25);
    });

    it('never throws when posts is missing, null, or not an array', async () => {
      for (const posts of [undefined, null, 'not-an-array', 42, {}]) {
        const getUserPosts: GetUserPosts = async () =>
          ({ posts, total: 0 }) as unknown as { posts: unknown[]; total: number };
        const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
        expect(stats.posts).toEqual([]);
      }
    });

    it('falls back to posts.length when the node omits or mistypes total', async () => {
      for (const total of [undefined, null, 'not-a-number']) {
        const getUserPosts: GetUserPosts = async () =>
          ({ posts: [rawPost(), rawPost({ msg_id: '2' })], total }) as unknown as {
            posts: unknown[];
            total: number;
          };
        const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
        expect(stats.totalPublished).toBe(2);
      }
    });

    it('does not overflow the call stack computing lastPostedAt from a very large post list', async () => {
      // The array itself is node-controlled and not necessarily bounded by
      // `limit` at the point lastPostedAt would be computed if it were naive
      // — this exercises the actual reduce implementation at a size that
      // would blow Math.max(...array) but must not blow a reduce.
      const getUserPosts: GetUserPosts = async () => ({
        posts: Array.from({ length: 200_000 }, (_, i) => rawPost({ msg_id: String(i), timestamp: i })),
        total: 200_000,
      });
      // Limit still clamps the decoded set to 25 (previous test), so give a
      // large limit here specifically to exercise the reduce over the full
      // returned array before clamping would normally apply downstream.
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 200_000);
      expect(stats.lastPostedAt).toBe(199_999);
    });

    it('rejects an oversized raw payload before attempting to scan or decode it', async () => {
      const huge = new Array(2_000_000).fill(0);
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: huge }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.title).toBe('(untitled)');
    });

    it('rejects a payload array containing out-of-byte-range or non-integer values', async () => {
      for (const payload of [[1, 2, 256], [1, 2, -1], [1, 2, 1.5], [1, 2, NaN]]) {
        const getUserPosts: GetUserPosts = async () => ({
          posts: [{ ...rawPost(), payload }],
          total: 1,
        });
        const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
        expect(stats.posts[0]!.title).toBe('(untitled)');
      }
    });

    it('strips bidi-override and control characters from title and tags', async () => {
      // U+202E (RIGHT-TO-LEFT OVERRIDE) could otherwise make a title display
      // reversed/spoofed even though .textContent alone stops it executing.
      const evil = 'safe\u202Etitle';
      const bytes = Array.from(encode({ title: evil, tags: [evil] }));
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: bytes }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.title).toBe('safetitle');
      expect(stats.posts[0]!.tags).toEqual(['safetitle']);
    });

    it('caps an absurdly long title and tag rather than rendering it in full', async () => {
      const longTitle = 'x'.repeat(10_000);
      const longTag = 'y'.repeat(10_000);
      const bytes = Array.from(encode({ title: longTitle, tags: [longTag] }));
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: bytes }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.title.length).toBeLessThanOrEqual(200);
      expect(stats.posts[0]!.tags[0]!.length).toBeLessThanOrEqual(32);
    });

    it('caps the number of tags counted per post', async () => {
      const manyTags = Array.from({ length: 50 }, (_, i) => 'tag' + i);
      const bytes = Array.from(encode({ title: 'x', tags: manyTags }));
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: bytes }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.tags.length).toBeLessThanOrEqual(10);
    });

    it('a hashtag literally named "constructor" is counted as data, not as an inherited property', async () => {
      const bytes = Array.from(encode({ title: 'x', tags: ['constructor', 'toString'] }));
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: bytes }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.hashtagCounts['constructor']).toBe(1);
      expect(stats.hashtagCounts['toString']).toBe(1);
      expect(typeof stats.hashtagCounts['constructor']).toBe('number');
    });

    it('counts a tag once per post even if it appears twice in that post\'s tag list', async () => {
      const bytes = Array.from(encode({ title: 'x', tags: ['klever', 'klever'] }));
      const getUserPosts: GetUserPosts = async () => ({
        posts: [{ ...rawPost(), payload: bytes }],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.hashtagCounts['klever']).toBe(1);
    });

    it('treats Infinity, NaN, and negative reaction counts as excluded, not corrupting the total', async () => {
      const getUserPosts: GetUserPosts = async () => ({
        posts: [
          { ...rawPost(), reaction_counts: { a: Infinity, b: -Infinity, c: NaN, d: -5, e: 3 } },
        ],
        total: 1,
      });
      const stats = await fetchPostStats(getUserPosts, 'klv1bot', 25);
      expect(stats.posts[0]!.reactionCount).toBe(3);
      expect(Number.isFinite(stats.posts[0]!.reactionCount)).toBe(true);
    });
  });
});
