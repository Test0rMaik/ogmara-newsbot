import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  candidateKey,
  isNearDuplicate,
  normalizeTitle,
  titleSimilarity,
} from './dedup.js';

describe('canonicalizeUrl', () => {
  it('strips tracking parameters but keeps real ones', () => {
    expect(canonicalizeUrl('https://x.com/a?id=7&utm_source=news&fbclid=abc')).toBe(
      'https://x.com/a?id=7',
    );
  });

  it('treats the same article shared via different channels as one URL', () => {
    // The single most common cause of duplicate posts.
    const viaNewsletter = 'https://site.com/story?utm_source=newsletter&utm_medium=email';
    const viaTwitter = 'https://site.com/story?utm_source=twitter';
    expect(canonicalizeUrl(viaNewsletter)).toBe(canonicalizeUrl(viaTwitter));
  });

  it('normalizes host case and www', () => {
    expect(canonicalizeUrl('https://WWW.Example.com/a')).toBe('https://example.com/a');
  });

  it('drops the fragment and trailing slash', () => {
    expect(canonicalizeUrl('https://x.com/a/#section')).toBe('https://x.com/a');
  });

  it('preserves path case', () => {
    expect(canonicalizeUrl('https://x.com/Path/To')).toBe('https://x.com/Path/To');
  });

  it('sorts query parameters so ordering does not matter', () => {
    expect(canonicalizeUrl('https://x.com/a?b=2&a=1')).toBe(canonicalizeUrl('https://x.com/a?a=1&b=2'));
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
});

describe('candidateKey', () => {
  it('is stable across repeated polls', () => {
    const item = { url: 'https://x.com/a', title: 'Headline' };
    expect(candidateKey(item)).toBe(candidateKey({ ...item }));
  });

  it('prefers guid over url', () => {
    const a = candidateKey({ guid: 'tag:x.com,2026:1', url: 'https://x.com/a', title: 'T' });
    const b = candidateKey({ guid: 'tag:x.com,2026:1', url: 'https://x.com/moved', title: 'T' });
    expect(a).toBe(b);
  });

  it('canonicalizes a guid that is itself a URL', () => {
    const a = candidateKey({ guid: 'https://x.com/a?utm_source=rss', title: 'T' });
    const b = candidateKey({ guid: 'https://x.com/a', title: 'T' });
    expect(a).toBe(b);
  });

  it('falls back to the title when there is no guid or url', () => {
    expect(candidateKey({ title: 'Some Headline' })).toBe(candidateKey({ title: 'some headline!' }));
  });

  it('distinguishes genuinely different items', () => {
    expect(candidateKey({ url: 'https://x.com/a', title: 'A' })).not.toBe(
      candidateKey({ url: 'https://x.com/b', title: 'B' }),
    );
  });
});

describe('normalizeTitle', () => {
  it('drops stopwords, punctuation and short words', () => {
    expect(normalizeTitle('The Fed, in a surprise, will hold rates')).toEqual([
      'fed',
      'surprise',
      'hold',
      'rates',
    ]);
  });

  it('folds diacritics', () => {
    expect(normalizeTitle('Zürich café')).toEqual(['zurich', 'cafe']);
  });
});

describe('titleSimilarity', () => {
  it('scores syndicated variants of one story highly', () => {
    const a = 'Fed holds rates steady';
    const b = 'Fed holds rates steady, signals caution';
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it('scores unrelated headlines low', () => {
    expect(titleSimilarity('Fed holds rates steady', 'Volcano erupts in Iceland')).toBeLessThan(0.2);
  });

  it('is symmetric', () => {
    const a = 'Storm batters coastal towns';
    const b = 'Coastal towns battered by storm';
    expect(titleSimilarity(a, b)).toBeCloseTo(titleSimilarity(b, a));
  });

  it('returns 0 when a title has no significant words', () => {
    expect(titleSimilarity('the a of', 'Fed holds rates')).toBe(0);
  });
});

describe('isNearDuplicate', () => {
  it('catches the same story from another publisher', () => {
    const seen = ['Fed holds rates steady amid inflation concerns'];
    expect(isNearDuplicate('Fed holds rates steady despite inflation concerns', seen)).toBe(true);
  });

  it('lets genuinely new stories through', () => {
    const seen = ['Fed holds rates steady amid inflation concerns'];
    expect(isNearDuplicate('Volcano erupts in southern Iceland', seen)).toBe(false);
  });

  it('is false against an empty history', () => {
    expect(isNearDuplicate('Anything', [])).toBe(false);
  });
});
