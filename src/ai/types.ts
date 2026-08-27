/**
 * The AI provider abstraction.
 *
 * Every provider takes the same {@link ComposeRequest} and returns the same
 * {@link ComposeResult}, so switching between Claude, GPT, Gemini and a local
 * model is a config change rather than a code change.
 *
 * Two rules hold across all providers:
 *
 * 1. **Structured output, never prose parsing.** Each provider uses its own
 *    native JSON-schema mode. Regex over free text is the single largest
 *    source of flakiness in bots like this, and it fails silently — a subtly
 *    malformed post gets published rather than rejected.
 * 2. **A refusal is a normal outcome, not an error.** A bot ingesting arbitrary
 *    world news will periodically hand a model a story it declines to write
 *    about. That must skip the item and continue, not crash an unattended
 *    process. See {@link ComposeRefusal}.
 */

/** An image handed to a vision-capable model. */
export interface ComposeImage {
  /** Raw image bytes. */
  data: Uint8Array;
  /** MIME type, e.g. `image/jpeg`. */
  mimeType: string;
}

/** What the composer is being asked to write about. */
export interface ComposeRequest {
  /** Rendered prompt — instructions plus the source material. */
  prompt: string;
  /**
   * Image to describe, for the image-directory source.
   *
   * When set, the provider must send it alongside the prompt. Providers that
   * cannot do vision throw {@link AiConfigError} rather than silently
   * composing from the prompt alone — a caption invented without ever seeing
   * the picture is worse than an error, because it looks like it worked.
   */
  image?: ComposeImage | undefined;
  /** Upper bound for the title, in bytes (protocol cap is 256). */
  maxTitleBytes: number;
  /** Rough target for body length, in characters. Guidance, not enforced. */
  targetContentChars: number;
  /** How many tags to ask for. The protocol caps the final list at 10. */
  maxTags: number;
}

/** A successfully composed post, before tag normalization. */
export interface ComposeSuccess {
  status: 'ok';
  title: string;
  content: string;
  tags: string[];
}

/**
 * The model declined to write about this item.
 *
 * Expected periodically on a general news feed: safety classifiers on current
 * models cover cybersecurity and life-sciences topics, and ordinary news
 * routinely brushes against both. The caller should skip the candidate and
 * move on rather than retrying, which would just decline again.
 */
export interface ComposeRefusal {
  status: 'refused';
  /** Provider-reported category, when one is given. */
  category?: string | undefined;
  /** Human-readable explanation, when one is given. */
  explanation?: string | undefined;
}

export type ComposeResult = ComposeSuccess | ComposeRefusal;

/** Identifier for a configured provider. */
export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openai-compatible';

/** A configured AI provider. */
export interface AiProvider {
  readonly id: ProviderId;
  /** Model identifier in use, for logging. */
  readonly model: string;
  /**
   * Whether this provider can accept an image.
   *
   * Reported rather than assumed: the frontier models of all three cloud
   * providers do vision, but an `openai-compatible` endpoint may be serving a
   * text-only local model, so the bot must fail clearly at startup rather
   * than at the first image post.
   */
  readonly supportsVision: boolean;
  compose(request: ComposeRequest): Promise<ComposeResult>;
}

/**
 * Raised when a provider fails in a way retrying won't fix — a bad API key, an
 * unknown model, a malformed request. Distinct from transient errors, which
 * are rethrown as-is so the caller can back off and retry.
 */
export class AiConfigError extends Error {
  override readonly name = 'AiConfigError';
}

/** Raised when a provider returns output that doesn't match the schema. */
export class AiResponseError extends Error {
  override readonly name = 'AiResponseError';
}

/**
 * The JSON shape every provider asks its model to produce.
 *
 * Kept as a plain object rather than a library-specific schema so each provider
 * can hand it to its own structured-output API without translation.
 */
export function composeSchema(maxTags: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Headline for the post. Plain text, no markdown, no surrounding quotes.',
      },
      content: {
        type: 'string',
        description:
          'Body of the post in markdown. Do not include the title, and do not include a source link — the bot appends attribution itself.',
      },
      tags: {
        type: 'array',
        description:
          'Topic tags, lowercase, no leading "#". Prefer specific topics over generic ones like "news".',
        items: { type: 'string' },
        maxItems: maxTags,
      },
    },
    required: ['title', 'content', 'tags'],
    additionalProperties: false,
  };
}

/**
 * Validate and normalize a provider's parsed JSON into a {@link ComposeSuccess}.
 *
 * Shared by every provider: they differ in how they obtain JSON, not in what
 * counts as a valid result. Throws {@link AiResponseError} rather than
 * returning something half-valid — a post with an empty title would fail
 * protocol validation later anyway, and failing here names the real cause.
 */
export function parseComposeResult(value: unknown): ComposeSuccess {
  if (value === null || typeof value !== 'object') {
    throw new AiResponseError('model returned a non-object result');
  }
  const obj = value as Record<string, unknown>;

  const title = typeof obj['title'] === 'string' ? obj['title'].trim() : '';
  const content = typeof obj['content'] === 'string' ? obj['content'].trim() : '';
  if (title.length === 0) throw new AiResponseError('model returned an empty title');
  if (content.length === 0) throw new AiResponseError('model returned empty content');

  const rawTags = Array.isArray(obj['tags']) ? obj['tags'] : [];
  const tags = rawTags.filter((t): t is string => typeof t === 'string');

  return { status: 'ok', title, content, tags };
}
