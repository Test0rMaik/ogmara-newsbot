/**
 * Google Gemini provider.
 *
 * Uses `responseJsonSchema` with `responseMimeType: 'application/json'`, which
 * accepts the same plain JSON Schema the other providers use — so the shared
 * {@link composeSchema} needs no Gemini-specific translation.
 *
 * Gemini reports safety blocks in two different places depending on which side
 * tripped: `promptFeedback.blockReason` when the *input* was blocked, and a
 * candidate `finishReason` when the *output* was. Both are refusals for our
 * purposes, and both must be checked — reading `response.text` without them
 * yields `undefined` and looks like an empty model reply.
 */

import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import {
  AiConfigError,
  AiResponseError,
  composeSchema,
  parseComposeResult,
  type AiProvider,
  type ComposeRequest,
  type ComposeResult,
} from './types.js';

/** Options for {@link GeminiProvider}. */
export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
}

/** Candidate finish reasons that mean the model declined, not that it failed. */
const REFUSAL_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini' as const;
  readonly model: string;
  readonly supportsVision = true;

  readonly #client: GoogleGenAI;
  readonly #maxTokens: number;

  constructor(options: GeminiProviderOptions) {
    if (options.apiKey.length === 0) {
      throw new AiConfigError('GEMINI_API_KEY is empty');
    }
    this.#client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model;
    this.#maxTokens = options.maxTokens;
  }

  async compose(request: ComposeRequest): Promise<ComposeResult> {
    let response: GenerateContentResponse;
    try {
      response = await this.#client.models.generateContent({
        model: this.model,
        contents:
          request.image === undefined
            ? request.prompt
            : [
                {
                  role: 'user',
                  parts: [
                    {
                      inlineData: {
                        mimeType: request.image.mimeType,
                        data: Buffer.from(request.image.data).toString('base64'),
                      },
                    },
                    { text: request.prompt },
                  ],
                },
              ],
        config: {
          maxOutputTokens: this.#maxTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: composeSchema(request.maxTags),
        },
      });
    } catch (err) {
      throw translateGeminiError(err);
    }

    // Input-side block: the prompt itself was rejected, so there are no
    // candidates at all.
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason !== undefined) {
      return {
        status: 'refused',
        category: String(blockReason),
        ...(response.promptFeedback?.blockReasonMessage !== undefined
          ? { explanation: response.promptFeedback.blockReasonMessage }
          : {}),
      };
    }

    // Output-side block: a candidate exists but stopped for a safety reason.
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason !== undefined && REFUSAL_FINISH_REASONS.has(String(finishReason))) {
      return { status: 'refused', category: String(finishReason) };
    }
    if (String(finishReason) === 'MAX_TOKENS') {
      throw new AiResponseError(
        `model hit the ${this.#maxTokens}-token cap before finishing — raise ai.maxTokens`,
      );
    }

    const text = response.text;
    if (text === undefined || text.length === 0) {
      throw new AiResponseError(
        `Gemini returned no text (finishReason: ${String(finishReason ?? 'unknown')})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AiResponseError('Gemini returned text that is not valid JSON');
    }
    return parseComposeResult(parsed);
  }
}

/**
 * Map Gemini errors to a permanent config error, or rethrow transient ones.
 *
 * The Gemini SDK does not export typed error classes the way Anthropic and
 * OpenAI do, so this inspects the status code where available and falls back to
 * message matching. Matching is deliberately narrow: an unrecognized error is
 * rethrown as transient, because misclassifying a blip as permanent would make
 * an unattended bot stop retrying.
 */
function translateGeminiError(err: unknown): unknown {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return new AiConfigError(`Gemini rejected the API key (${status}) — check GEMINI_API_KEY`);
    }
    if (status === 404) {
      return new AiConfigError('Gemini returned 404 — the configured model name is probably wrong');
    }
    if (status === 400) {
      return new AiConfigError(`Gemini rejected the request (400): ${String(err)}`);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/api[_ ]key|unauthenticated|permission denied/i.test(message)) {
    return new AiConfigError(`Gemini authentication failed — check GEMINI_API_KEY (${message})`);
  }
  return err;
}
