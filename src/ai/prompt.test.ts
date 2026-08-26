import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import { renderTemplate } from './prompt.js';

describe('renderTemplate', () => {
  it('substitutes placeholders', () => {
    expect(renderTemplate('Hello {{NAME}}, you are {{AGE}}', { NAME: 'Ada', AGE: 36 })).toBe(
      'Hello Ada, you are 36',
    );
  });

  it('substitutes every occurrence', () => {
    expect(renderTemplate('{{X}} and {{X}}', { X: 'a' })).toBe('a and a');
  });

  it('throws on an unknown placeholder rather than leaving or blanking it', () => {
    // A typo'd {{PUBLISER}} would otherwise reach the model as literal text and
    // produce a subtly wrong post with no indication why.
    expect(() => renderTemplate('Hi {{PUBLISER}}', { PUBLISHER: 'x' })).toThrow(ConfigError);
    expect(() => renderTemplate('Hi {{PUBLISER}}', { PUBLISHER: 'x' })).toThrow(/PUBLISER/);
  });

  it('reports each unknown placeholder once', () => {
    expect(() => renderTemplate('{{A}} {{A}} {{B}}', {})).toThrow(/A, B/);
  });

  it('leaves non-matching braces alone', () => {
    // Lowercase and mixed-case braces are not placeholders — markdown and code
    // samples in a prompt should survive untouched.
    expect(renderTemplate('{{lowercase}} and { single }', {})).toBe('{{lowercase}} and { single }');
  });

  it('handles a template with no placeholders', () => {
    expect(renderTemplate('plain text', {})).toBe('plain text');
  });
});
