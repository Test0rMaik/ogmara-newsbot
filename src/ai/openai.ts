/**
 * OpenAI provider, and by extension every OpenAI-compatible endpoint.
 *
 * One class serves both `openai` and `openai-compatible`: the wire protocol is
 * identical and only the base URL differs. That is what makes Ollama, LM
 * Studio, OpenRouter, Groq, vLLM and any other compatible server work without
 * further code — a self-hosted operator can run this bot entirely locally.
 *
 * Uses `json_schema` response format with `strict: true` so the model must
 * return schema-valid JSON. Compatible servers vary in how well they implement
 * strict mode, so the parse path still validates rather than trusting it.
 */

import OpenAI from 'openai';
import {
  AiConfigError,
  AiResponseError,
  composeSchema,
  parseComposeResult,
  type AiProvider,
  type ComposeRequest,
  type ComposeResult,
  type ProviderId,
} from './types.js';

/** Options for {@link OpenAiProvider}. */
export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** Override for OpenAI-compatible servers (Ollama, OpenRouter, vLLM, …). */
  baseUrl?: string | undefined;
  /** Whether the configured compatible model accepts images. Ignored for real OpenAI. */
  supportsVision?: boolean | undefined;
  maxTokens: number;
}

export class OpenAiProvider implements AiProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly supportsVision: boolean;

  readonly #client: OpenAI;
  readonly #maxTokens: number;

  constructor(options: OpenAiProviderOptions) {
    if (options.apiKey.length === 0) {
      throw new AiConfigError(
        'API key is empty — set OPENAI_API_KEY (local servers usually accept any non-empty value)',
      );
    }
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
    });
    this.id = options.baseUrl !== undefined ? 'openai-compatible' : 'openai';
    this.model = options.model;
    this.#maxTokens = options.maxTokens;
    // OpenAI's own frontier models are all vision-capable. A compatible
    // endpoint may be serving anything, so the operator declares it.
    this.supportsVision = options.baseUrl === undefined ? true : (options.supportsVision ?? false);
  }

  async compose(request: ComposeRequest): Promise<ComposeResult> {
    let completion;
    try {
      completion = await this.#client.chat.completions.create({
        model: this.model,
        max_completion_tokens: this.#maxTokens,
        messages: [{ role: 'user', content: buildContent(request) }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'ogmara_news_post',
            strict: true,
            schema: composeSchema(request.maxTags),
          },
        },
      });
    } catch (err) {
      throw translateOpenAiError(err);
    }

    const choice = completion.choices[0];
    if (choice === undefined) {
      throw new AiResponseError('model returned no choices');
    }

    // OpenAI surfaces a content-policy decline as a finish_reason rather than
    // an error, and some models populate a dedicated `refusal` field. Treat
    // either as a refusal so the bot skips the item instead of crashing.
    const refusal = (choice.message as { refusal?: string | null }).refusal;
    if (choice.finish_reason === 'content_filter' || (refusal != null && refusal.length > 0)) {
      return {
        status: 'refused',
        category: 'content_filter',
        ...(refusal != null && refusal.length > 0 ? { explanation: refusal } : {}),
      };
    }

    if (choice.finish_reason === 'length') {
      throw new AiResponseError(
        `model hit the ${this.#maxTokens}-token cap before finishing — raise ai.maxTokens`,
      );
    }

    const content = choice.message.content;
    if (content === null || content.length === 0) {
      throw new AiResponseError('model returned an empty message');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AiResponseError(
        'model returned text that is not valid JSON — this server may not support strict json_schema mode',
      );
    }
    return parseComposeResult(parsed);
  }
}

/** Build the user turn, attaching the image as a data URI when present. */
function buildContent(
  request: ComposeRequest,
): string | OpenAI.Chat.ChatCompletionContentPart[] {
  if (request.image === undefined) return request.prompt;
  const b64 = Buffer.from(request.image.data).toString('base64');
  return [
    { type: 'image_url', image_url: { url: `data:${request.image.mimeType};base64,${b64}` } },
    { type: 'text', text: request.prompt },
  ];
}

/** Map SDK errors to a permanent config error, or rethrow transient ones. */
function translateOpenAiError(err: unknown): unknown {
  if (err instanceof OpenAI.AuthenticationError) {
    return new AiConfigError('API key rejected (401) — check your key');
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return new AiConfigError('API key lacks permission for this model (403)');
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new AiConfigError('404 — the configured model name is probably wrong');
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new AiConfigError(
      `request rejected (400): ${err.message}\n` +
        'If this is an OpenAI-compatible server, it may not support strict json_schema mode.',
    );
  }
  return err;
}
