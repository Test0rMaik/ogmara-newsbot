import { describe, expect, it } from 'vitest';
import { AiResponseError, composeSchema, parseComposeResult } from './types.js';

describe('composeSchema', () => {
  it('requires the three post fields and forbids extras', () => {
    const schema = composeSchema(5) as Record<string, unknown>;
    expect(schema['required']).toEqual(['title', 'content', 'tags']);
    // Strict structured-output modes reject schemas without this.
    expect(schema['additionalProperties']).toBe(false);
  });

  it('caps the tag array at the requested maximum', () => {
    const props = (composeSchema(3) as { properties: Record<string, { maxItems?: number }> })
      .properties;
    expect(props['tags']?.maxItems).toBe(3);
  });
});

describe('parseComposeResult', () => {
  it('accepts a well-formed result', () => {
    expect(
      parseComposeResult({ title: 'T', content: 'C', tags: ['a', 'b'] }),
    ).toEqual({ status: 'ok', title: 'T', content: 'C', tags: ['a', 'b'] });
  });

  it('trims surrounding whitespace', () => {
    const r = parseComposeResult({ title: '  T  ', content: '\nC\n', tags: [] });
    expect(r.title).toBe('T');
    expect(r.content).toBe('C');
  });

  it('rejects a non-object', () => {
    expect(() => parseComposeResult('a string')).toThrow(AiResponseError);
    expect(() => parseComposeResult(null)).toThrow(AiResponseError);
  });

  it('rejects an empty or whitespace-only title', () => {
    // Would fail protocol validation later anyway; failing here names the cause.
    expect(() => parseComposeResult({ title: '', content: 'C', tags: [] })).toThrow(/empty title/);
    expect(() => parseComposeResult({ title: '   ', content: 'C', tags: [] })).toThrow(/empty title/);
  });

  it('rejects empty content', () => {
    expect(() => parseComposeResult({ title: 'T', content: '', tags: [] })).toThrow(/empty content/);
  });

  it('tolerates a missing or malformed tags array', () => {
    // Tags are recoverable — the bot always adds its own required tags, so a
    // model that omits them still yields a publishable post.
    expect(parseComposeResult({ title: 'T', content: 'C' }).tags).toEqual([]);
    expect(parseComposeResult({ title: 'T', content: 'C', tags: 'nope' }).tags).toEqual([]);
  });

  it('drops non-string entries from tags', () => {
    expect(parseComposeResult({ title: 'T', content: 'C', tags: ['a', 7, null, 'b'] }).tags).toEqual(
      ['a', 'b'],
    );
  });
});
