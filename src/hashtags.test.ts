import { describe, expect, it } from 'vitest';
import { MAX_TAGS, MAX_TAG_BYTES, buildTags, extractHashtags, normalizeTag } from './hashtags.js';

describe('normalizeTag', () => {
  it('lowercases and strips a leading hash', () => {
    expect(normalizeTag('#Breaking')).toBe('breaking');
    expect(normalizeTag('WORLD')).toBe('world');
  });

  it('folds diacritics instead of hyphenating them', () => {
    // "m-nchen" would fragment one word into two meaningless stems and split
    // the tag index for any non-English feed.
    expect(normalizeTag('München')).toBe('munchen');
    expect(normalizeTag('café')).toBe('cafe');
  });

  it('converts word separators to hyphens', () => {
    expect(normalizeTag('climate change')).toBe('climate-change');
    expect(normalizeTag('climate_change')).toBe('climate-change');
  });

  it('drops illegal characters without fracturing the word', () => {
    expect(normalizeTag('AT&T')).toBe('att');
    expect(normalizeTag('c++')).toBe('c');
  });

  it('collapses and trims hyphens', () => {
    expect(normalizeTag('--a---b--')).toBe('a-b');
  });

  it('returns null when nothing legal survives', () => {
    expect(normalizeTag('###')).toBeNull();
    expect(normalizeTag('!!!')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('')).toBeNull();
  });

  it('truncates to the protocol byte cap', () => {
    const tag = normalizeTag('a'.repeat(100));
    expect(tag).not.toBeNull();
    expect(new TextEncoder().encode(tag!).length).toBe(MAX_TAG_BYTES);
  });

  it('never leaves a trailing hyphen after truncation', () => {
    // 63 chars then a hyphen: a naive slice(0, 64) would end on the hyphen.
    const tag = normalizeTag(`${'a'.repeat(63)}-bbbb`);
    expect(tag).toBe('a'.repeat(63));
  });

  it('emits pure ASCII, so the byte cap can be applied by character slice', () => {
    // Guards the assumption documented in normalizeTag's truncation branch.
    for (const input of ['München', '日本語ニュース', 'naïve café', '🚀rocket']) {
      const tag = normalizeTag(input);
      if (tag === null) continue;
      expect(new TextEncoder().encode(tag).length).toBe(tag.length);
      expect(tag).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('extractHashtags', () => {
  it('finds hashtags in free text', () => {
    expect(extractHashtags('Big news about #climate and #energy today')).toEqual([
      'climate',
      'energy',
    ]);
  });

  it('does not match a hash inside a word', () => {
    expect(extractHashtags('the C#7 spec and issue#42')).toEqual([]);
  });

  it('de-duplicates, preserving first-appearance order', () => {
    expect(extractHashtags('#b #a #b #A')).toEqual(['b', 'a']);
  });

  it('handles unicode hashtags via folding', () => {
    expect(extractHashtags('report from #München')).toEqual(['munchen']);
  });

  it('returns empty for text with no hashtags', () => {
    expect(extractHashtags('nothing to see here')).toEqual([]);
    expect(extractHashtags('')).toEqual([]);
  });
});

describe('buildTags', () => {
  it('merges required, suggested and inline tags in priority order', () => {
    expect(
      buildTags({
        required: ['bot'],
        suggested: ['world-news'],
        title: 'A #headline',
        content: 'body with #detail',
      }),
    ).toEqual(['bot', 'world-news', 'headline', 'detail']);
  });

  it('caps at the protocol maximum', () => {
    const suggested = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    expect(buildTags({ suggested })).toHaveLength(MAX_TAGS);
  });

  it('keeps required tags when the cap is hit', () => {
    // An enthusiastic model returning 20 tags must not be able to push the
    // bot-disclosure tag off the post.
    const suggested = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const tags = buildTags({ required: ['bot', 'ogmara'], suggested });
    expect(tags).toHaveLength(MAX_TAGS);
    expect(tags[0]).toBe('bot');
    expect(tags[1]).toBe('ogmara');
  });

  it('de-duplicates across all sources after normalization', () => {
    const tags = buildTags({
      required: ['Bot'],
      suggested: ['#bot', 'BOT'],
      content: 'text #bot',
    });
    expect(tags).toEqual(['bot']);
  });

  it('drops entries that normalize to nothing', () => {
    expect(buildTags({ suggested: ['###', 'ok', '!!!'] })).toEqual(['ok']);
  });

  it('returns an empty list for empty input', () => {
    expect(buildTags({})).toEqual([]);
  });

  it('always emits protocol-legal tags', () => {
    const tags = buildTags({
      required: ['Bot Disclosure'],
      suggested: ['AT&T', 'München', 'x'.repeat(90)],
      content: 'and #Breaking_News',
    });
    expect(tags.length).toBeLessThanOrEqual(MAX_TAGS);
    for (const tag of tags) {
      expect(tag).toMatch(/^[a-z0-9-]+$/);
      expect(new TextEncoder().encode(tag).length).toBeLessThanOrEqual(MAX_TAG_BYTES);
    }
  });
});
