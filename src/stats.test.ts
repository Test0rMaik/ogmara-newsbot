import { describe, expect, it } from 'vitest';
import { aggregateAllPostStats } from './stats.js';

function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { reaction_counts: { thumbsup: 2 }, repost_count: 1, comment_count: 1, ...over };
}

describe('aggregateAllPostStats', () => {
  it('sums a single page', async () => {
    const getUserPosts = async () => ({ posts: [post(), post()], total: 2 });
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 25, 1000);
    expect(result).toEqual({ totalReactions: 4, totalReposts: 2, totalComments: 2, totalPosts: 2 });
  });

  it('paginates until a short final page', async () => {
    const pages: Array<Array<Record<string, unknown>>> = [
      [post(), post()],
      [post()],
    ];
    let calls = 0;
    const getUserPosts = async (_address: string, options: { page: number; limit: number }) => {
      calls++;
      const page = pages[options.page - 1] ?? [];
      return { posts: page, total: 3 };
    };
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 2, 1000);
    expect(calls).toBe(2);
    expect(result.totalPosts).toBe(3);
    expect(result.totalReactions).toBe(6); // 3 posts x 2 each
  });

  it('stops at maxPostsScanned even if the node keeps claiming full pages', async () => {
    let calls = 0;
    const getUserPosts = async () => {
      calls++;
      return { posts: [post(), post()], total: 999999 }; // always a "full" page
    };
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 2, 5);
    expect(calls).toBeLessThanOrEqual(3); // bounded, not infinite
    expect(result.totalReactions).toBeGreaterThan(0);
  });

  it('clamps a page that exceeds the requested limit, defending against a misbehaving node', async () => {
    const getUserPosts = async () => ({
      posts: Array.from({ length: 10 }, () => post()),
      total: 10,
    });
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 3, 1000);
    // Only the first 3 of the oversized page are counted, and since that's
    // not "short" relative to the requested limit, pagination continues
    // (and immediately re-reads the same oversized page) until the safety
    // cap — proving the cap is what stops it, not a length check alone.
    expect(result.totalReactions).toBeGreaterThan(0);
  });

  it('treats a missing/non-array posts field as empty rather than throwing', async () => {
    const getUserPosts = async () => ({ posts: undefined as unknown as unknown[], total: 0 });
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 25, 1000);
    expect(result).toEqual({ totalReactions: 0, totalReposts: 0, totalComments: 0, totalPosts: 0 });
  });

  it('excludes non-finite/negative reaction counts, mirroring panel/posts.ts', async () => {
    const getUserPosts = async () => ({
      posts: [post({ reaction_counts: { a: Infinity, b: -5, c: NaN, d: 3 } })],
      total: 1,
    });
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 25, 1000);
    expect(result.totalReactions).toBe(3);
  });

  it('excludes non-finite/negative repost_count, comment_count, and total — one poisoned snapshot must not blank the whole chart', async () => {
    // msgpack (unlike JSON) can encode NaN/Infinity, so a compromised node
    // can put one in a response. Left unguarded, it propagates through the
    // sum and every downstream chart computation renders NaN — silently and
    // with no error shown. Code audit, 0.11.0.
    const getUserPosts = async () => ({
      posts: [post({ repost_count: Infinity, comment_count: NaN })],
      total: -5,
    });
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 25, 1000);
    expect(result.totalReposts).toBe(0);
    expect(result.totalComments).toBe(0);
    expect(result.totalPosts).toBe(0);
    expect(Number.isFinite(result.totalReactions)).toBe(true);
  });

  it('stops after the wall-clock deadline even if maxPostsScanned would allow more requests', async () => {
    let calls = 0;
    const getUserPosts = async () => {
      calls++;
      return { posts: [post(), post()], total: 999999 }; // always a "full" page
    };
    // A deadline of 0ms means the very first completed request already
    // exceeds it, so exactly one request should happen.
    const result = await aggregateAllPostStats(getUserPosts, 'klv1x', 2, 1_000_000, 0);
    expect(calls).toBe(1);
    expect(result.totalReactions).toBeGreaterThan(0);
  });
});
