/**
 * Provider construction from config + secrets.
 *
 * Only the configured provider's key is required, so an operator running a
 * local model never needs to hold a cloud API key at all.
 */

import type { AiConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAiProvider } from './openai.js';
import { AiConfigError, type AiProvider } from './types.js';

/** API keys, one per provider. Only the configured one is needed. */
export interface AiSecrets {
  anthropicApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  geminiApiKey?: string | undefined;
}

/** Build the configured provider, or explain exactly which key is missing. */
export function createProvider(config: AiConfig, secrets: AiSecrets): AiProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: requireKey(secrets.anthropicApiKey, 'ANTHROPIC_API_KEY', 'anthropic'),
        model: config.model,
        effort: config.effort,
        maxTokens: config.maxTokens,
      });

    case 'openai':
      return new OpenAiProvider({
        apiKey: requireKey(secrets.openaiApiKey, 'OPENAI_API_KEY', 'openai'),
        model: config.model,
        maxTokens: config.maxTokens,
      });

    case 'gemini':
      return new GeminiProvider({
        apiKey: requireKey(secrets.geminiApiKey, 'GEMINI_API_KEY', 'gemini'),
        model: config.model,
        maxTokens: config.maxTokens,
      });

    case 'openai-compatible': {
      if (config.baseUrl === undefined) {
        throw new AiConfigError(
          'ai.provider is "openai-compatible" but ai.baseUrl is not set.\n' +
            'Set it to your server\'s endpoint, e.g. http://localhost:11434/v1 for Ollama.',
        );
      }
      return new OpenAiProvider({
        // Local servers ignore the key but the SDK requires a non-empty value.
        apiKey: secrets.openaiApiKey ?? 'not-needed',
        model: config.model,
        baseUrl: config.baseUrl,
        maxTokens: config.maxTokens,
      });
    }
  }
}

function requireKey(value: string | undefined, envName: string, provider: string): string {
  const key = value?.trim() ?? '';
  if (key.length === 0) {
    throw new AiConfigError(
      `${envName} is not set, but ai.provider is "${provider}".\n` +
        `Add ${envName} to your .env file, or switch ai.provider in your config.`,
    );
  }
  return key;
}

export { AiConfigError, AiResponseError } from './types.js';
export type { AiProvider, ComposeRequest, ComposeResult } from './types.js';
