/**
 * Provider construction from config + secrets.
 *
 * Only the configured provider's key is required, so an operator running a
 * local model never needs to hold a cloud API key at all.
 */

import type { AiConfig } from '../config.js';
import { AiConfigError, type AiProvider } from './types.js';

/** API keys, one per provider. Only the configured one is needed. */
export interface AiSecrets {
  anthropicApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  geminiApiKey?: string | undefined;
  openaiCompatibleApiKey?: string | undefined;
}

/**
 * Build the configured provider, or explain exactly which key is missing.
 *
 * Providers are imported dynamically so only the configured one is ever
 * loaded. With static imports, every module-init path in all three cloud SDKs
 * ran on every start — 67 production packages, including transitive code that
 * probes the cloud metadata endpoint — inside the process that holds the
 * wallet key. An operator running a purely local model now loads none of it.
 * (Audit 2026-08-26, M16.)
 */
export async function createProvider(config: AiConfig, secrets: AiSecrets): Promise<AiProvider> {
  switch (config.provider) {
    case 'anthropic': {
      const { AnthropicProvider } = await import('./anthropic.js');
      return new AnthropicProvider({
        apiKey: requireKey(secrets.anthropicApiKey, 'ANTHROPIC_API_KEY', 'anthropic'),
        model: config.model,
        effort: config.effort,
        maxTokens: config.maxTokens,
      });
    }

    case 'openai': {
      const { OpenAiProvider } = await import('./openai.js');
      return new OpenAiProvider({
        apiKey: requireKey(secrets.openaiApiKey, 'OPENAI_API_KEY', 'openai'),
        model: config.model,
        maxTokens: config.maxTokens,
      });
    }

    case 'gemini': {
      const { GeminiProvider } = await import('./gemini.js');
      return new GeminiProvider({
        apiKey: requireKey(secrets.geminiApiKey, 'GEMINI_API_KEY', 'gemini'),
        model: config.model,
        maxTokens: config.maxTokens,
      });
    }

    case 'openai-compatible': {
      if (config.baseUrl === undefined) {
        throw new AiConfigError(
          'ai.provider is "openai-compatible" but ai.baseUrl is not set.\n' +
            'Set it to your server\'s endpoint, e.g. http://localhost:11434/v1 for Ollama.',
        );
      }
      const { OpenAiProvider } = await import('./openai.js');
      return new OpenAiProvider({
        // Deliberately NOT secrets.openaiApiKey: this endpoint may be a third
        // party, and forwarding a real OpenAI credential to it is a leak. Local
        // servers ignore the value, so a placeholder is fine.
        apiKey: secrets.openaiCompatibleApiKey ?? 'not-needed',
        model: config.model,
        baseUrl: config.baseUrl,
        supportsVision: config.compatibleSupportsVision,
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
