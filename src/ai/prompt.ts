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

import { readFileSync } from 'node:fs';
import { ConfigError } from '../config.js';

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
