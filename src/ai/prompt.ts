/**
 * Prompt template loading and rendering.
 *
 * Templates live in `prompts/` as editable Markdown rather than string
 * literals in the source. That is deliberate: the prompt is where an operator
 * gives their bot its voice and editorial rules, and asking them to patch
 * TypeScript to change a sentence would put it out of reach for most people
 * running this.
 *
 * Substitution is intentionally dumb — `{{NAME}}` placeholders, no logic, no
 * expressions. A template language here would be a code-execution surface fed
 * by files the operator edits, for no real gain.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigError } from '../config.js';

/**
 * Wrap untrusted text in a fence the model is told to treat as data.
 *
 * Feed titles and summaries are authored by whoever can post to the feed —
 * which for an aggregator (a subreddit's `.rss`, a Google News query feed, a
 * link-aggregator feed) is any internet user. Splicing that text straight into
 * the prompt lets it read as instructions, and the resulting post is signed
 * with the operator's wallet and gossiped to a mesh where it cannot be
 * unpublished. Structured output constrains the *shape* of the reply, not its
 * content, so it is no defence here.
 *
 * The delimiter is random per call and stripped from the payload, so the text
 * cannot close its own fence and resume as instructions — a fixed marker
 * would be guessable from the public source of this repo. This raises the cost
 * of an injection considerably; combined with capping the fields and putting
 * the rules *after* the data, it is the practical mitigation. It is not a
 * proof, which is why dry-run review and the disclosure tag still matter.
 *
 * (Audit 2026-08-26, M1.)
 */
export function fenceUntrusted(text: string, marker: string): string {
  // Strip the bare keyword outright rather than only its `KEYWORD_suffix`
  // form: the closing delimiter is `MARKER_UNTRUSTED_SOURCE>>>`, where the
  // keyword is a *suffix*, so a pattern anchored on a trailing underscore
  // misses it entirely and leaves a forgeable fence in the payload. Removing
  // every occurrence of the keyword — and of the marker — means no arrangement
  // of feed text can close the fence and resume as instructions.
  const escaped = text.replaceAll(marker, '').replaceAll('UNTRUSTED_SOURCE', '');
  return `<<<UNTRUSTED_SOURCE_${marker}\n${escaped}\n${marker}_UNTRUSTED_SOURCE>>>`;
}

/** Generate a per-call fence marker. Random so feed text cannot predict it. */
export function newFenceMarker(): string {
  return randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Truncate to a character budget, marking the cut so the model knows. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [truncated]`;
}

/** Values available to a template. */
export type PromptVars = Readonly<Record<string, string | number>>;

/**
 * Render a template, substituting `{{NAME}}` placeholders.
 *
 * Unknown placeholders are a hard error rather than being left in place or
 * silently blanked: a typo'd `{{PUBLISER}}` would otherwise ship to the model
 * as literal text, and the resulting post would look subtly wrong with no
 * indication why.
 */
export function renderTemplate(template: string, vars: PromptVars): string {
  const missing: string[] = [];
  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      missing.push(name);
      return '';
    }
    return String(value);
  });

  if (missing.length > 0) {
    throw new ConfigError(
      `prompt template references unknown placeholder(s): ${[...new Set(missing)].join(', ')}`,
    );
  }
  return rendered;
}

/** Load a prompt template from disk. */
export function loadTemplate(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `could not read prompt template "${path}": ${reason}\n` +
        'Prompt templates live in prompts/ — check ai.promptPath in your config.',
    );
  }
}
