import { describe, expect, it } from 'vitest';
import { TopicsSource } from './topics.js';

const HOUR = 3_600_000;

function source(topics: string[], minIntervalHours = 168, now = 0) {
  return new TopicsSource({ topics, minIntervalHours, now: () => now });
}

describe('TopicsSource', () => {
  it('yields one candidate per configured topic', async () => {
    const result = await source(['klever ecosystem', 'open-source privacy']).poll();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.title).sort()).toEqual([
      'klever ecosystem',
      'open-source privacy',
    ]);
  });

  it('marks candidates with the topics kind', async () => {
    const result = await source(['a topic']).poll();
    expect(result.candidates[0]!.kind).toBe('topics');
  });

  it('warns rather than failing when no topics are configured', async () => {
    const result = await source([]).poll();
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]).toMatch(/no topics are configured/);
  });

  it('gives a topic the same key within its interval', async () => {
    // Stable key = the ledger suppresses it, which is what enforces the gap.
    const a = await source(['x'], 168, 0).poll();
    const b = await source(['x'], 168, 100 * HOUR).poll();
    expect(a.candidates[0]!.dedupKey).toBe(b.candidates[0]!.dedupKey);
  });

  it('gives a topic a new key once the interval passes', async () => {
    const a = await source(['x'], 168, 0).poll();
    const b = await source(['x'], 168, 200 * HOUR).poll();
    expect(a.candidates[0]!.dedupKey).not.toBe(b.candidates[0]!.dedupKey);
  });

  it('gives different topics different keys', async () => {
    const result = await source(['first', 'second']).poll();
    expect(result.candidates[0]!.dedupKey).not.toBe(result.candidates[1]!.dedupKey);
  });

  it('is insensitive to case and surrounding whitespace', async () => {
    const a = await source(['  Klever Ecosystem '], 168, 0).poll();
    const b = await source(['klever ecosystem'], 168, 0).poll();
    expect(a.candidates[0]!.dedupKey).toBe(b.candidates[0]!.dedupKey);
  });

  it('rotates which topic leads across intervals', async () => {
    // The pipeline takes the first unseen candidate, so a fixed order would
    // let topic #1 win every time and starve the rest.
    const topics = ['alpha', 'beta', 'gamma'];
    const leaders = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const result = await source(topics, 1, i * HOUR).poll();
      leaders.add(result.candidates[0]!.title);
    }
    expect(leaders.size).toBe(3);
  });
});
