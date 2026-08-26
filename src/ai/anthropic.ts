/**
 * Anthropic (Claude) provider.
 *
 * Uses structured outputs (`output_config.format`) so the model returns
 * schema-valid JSON directly — no prose parsing, no repair loop.
 *
 * Two Claude-specific behaviours matter for a news bot and are handled here:
 *
 * - **Refusals are HTTP 200.** Current models return `stop_reason: "refusal"`
 *   with an empty or partial `content` rather than an error. Code that reads
 *   `content[0]` unconditionally crashes on those. A bot summarising world
 *   news brushes against the cybersecurity and life-sciences classifiers
 *   regularly, so this is a routine path, not an edge case.
 * - **Server-side fallbacks.** A declined request is automatically re-run on
 *   Anthropic's recommended fallback model inside the same call, which rescues
 *   exactly the posts a news bot would otherwise silently drop. Only the
 *   whole-chain refusal reaches {@link ComposeRefusal}.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AiConfigError,
  AiResponseError,
  composeSchema,
  parseComposeResult,
  type AiProvider,
  type ComposeRequest,
  type ComposeResult,
} from './types.js';

/** Options for {@link AnthropicProvider}. */
export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Thinking depth and token spend. Composing a post is a short, scoped task. */
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;

  readonly #client: Anthropic;
  readonly #effort: AnthropicProviderOptions['effort'];
  readonly #maxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    if (options.apiKey.length === 0) {
      throw new AiConfigError('ANTHROPIC_API_KEY is empty');
    }
    this.#client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model;
    this.#effort = options.effort;
    this.#maxTokens = options.maxTokens;
  }

  async compose(request: ComposeRequest): Promise<ComposeResult> {
    let response;
    try {
      response = await this.#client.beta.messages.create({
        model: this.model,
        max_tokens: this.#maxTokens,
        // Server-side fallback: on a policy decline the API re-runs the request
        // on Anthropic's recommended fallback model within the same call.
        // "default" routes by refusal category rather than pinning a model, so
        // this needs no maintenance when the recommended fallback changes.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: this.#effort,
          format: { type: 'json_schema', schema: composeSchema(request.maxTags) },
        },
        messages: [{ role: 'user', content: request.prompt }],
      } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    } catch (err) {
      throw translateAnthropicError(err);
    }

    // Check the stop reason before touching content: on a refusal, `content` is
    // empty (declined pre-output) or partial (declined mid-stream), and
    // indexing into it is exactly the crash this guard exists to prevent.
    if (response.stop_reason === 'refusal') {
      const details = response.stop_details;
      return {
        status: 'refused',
        ...(details?.category != null ? { category: String(details.category) } : {}),
        ...(details?.explanation != null ? { explanation: String(details.explanation) } : {}),
      };
    }

    const text = response.content.find(
      (block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text',
    );
    if (text === undefined) {
      throw new AiResponseError(
        `Claude returned no text block (stop_reason: ${response.stop_reason ?? 'unknown'})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      // Structured outputs guarantee schema-valid JSON, so this indicates the
      // request lost its output_config rather than a flaky model.
      throw new AiResponseError('Claude returned text that is not valid JSON');
    }
    return parseComposeResult(parsed);
  }
}

/**
 * Map SDK errors to either a permanent config error or a rethrow.
 *
 * Uses the SDK's typed error classes rather than string-matching messages, and
 * checks most-specific first. Transient failures (rate limits, 5xx, network)
 * are rethrown unchanged so the caller can back off — turning them into config
 * errors would make an unattended bot give up on a blip.
 */
function translateAnthropicError(err: unknown): unknown {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AiConfigError('Anthropic rejected the API key (401) — check ANTHROPIC_API_KEY');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AiConfigError('Anthropic API key lacks permission for this model (403)');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AiConfigError(
      'Anthropic returned 404 — the configured model name is probably wrong',
    );
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AiConfigError(`Anthropic rejected the request (400): ${err.message}`);
  }
  return err;
}
