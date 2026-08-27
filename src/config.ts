/**
 * Configuration loading and validation.
 *
 * Config comes from two places, deliberately split:
 *
 * - **`config.yaml`** — everything non-secret. Committed by the operator if
 *   they want, safe to share when asking for help.
 * - **environment / `.env`** — secrets only (wallet key, AI API keys). Never
 *   written to the YAML, so a pasted config can't leak a wallet.
 *
 * Validation is strict and happens once at startup. A bot that posts to a
 * public, un-retractable feed should refuse to start on a questionable config
 * rather than discover the problem after publishing.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isValidCron } from './scheduler.js';

/**
 * The node's per-wallet news limits, as of l2-node 0.122.0.
 *
 * Two windows, both enforced — a post is rejected if EITHER is exceeded — and
 * both tiered by on-chain registration. Registering the bot's wallet raises
 * the daily ceiling 6x, which is the single biggest lever on how much this bot
 * can publish.
 *
 * Not discoverable over the API, so these are operator-tunable rather than
 * hardcoded: point the bot at a node with a different `[api.rate_limits]`
 * config and change these to match, with no code change.
 *
 * (Earlier versions modelled a single 5/hour window. That was the pre-0.122.0
 * shape and is no longer what any current node enforces.)
 */
export const NODE_LIMITS = {
  burstWindowMinutes: 10,
  burstUnverified: 5,
  burstRegistered: 20,
  dailyUnverified: 50,
  dailyRegistered: 300,
} as const;

/**
 * Protocol caps on a news post payload (spec §3.5).
 *
 * Both are BYTES. The spec prose says "chars" at §3.5 but §3.7 and the node's
 * own validator use byte length, and the node is authoritative.
 */
export const MAX_TITLE_BYTES = 256;
export const MAX_CONTENT_BYTES = 65536;

const contentRating = z.enum(['general', 'teen', 'mature', 'explicit']);

const nodeSchema = z.object({
  /** Base URL of the Ogmara L2 node to post through. */
  url: z.url({ protocol: /^https?$/ }),
  /**
   * Which network you intend to publish to.
   *
   * Checked against the node's `/api/v1/health` at startup; a mismatch aborts.
   * Note this is an *intent* declaration, not a binding: the SDK makes every
   * signature adopt whatever network the node reports, so without the startup
   * check a wrong value here would silently publish to the other chain rather
   * than being rejected. (Audit 2026-08-26, M3.)
   */
  network: z.enum(['testnet', 'mainnet']).default('testnet'),
  /** Request timeout in milliseconds. */
  timeoutMs: z.int().min(1000).max(300_000).default(30_000),
});

const postingSchema = z
  .object({
    /**
     * When true (the default) nothing is ever published — composed posts are
     * printed instead. Going live is an explicit, deliberate act.
     */
    dryRun: z.boolean().default(true),
    contentRating: contentRating.default('general'),
    /** Bot's own posting cadence ceiling. Validated against the node's limits. */
    maxPostsPerHour: z.number().positive().max(100).default(1),
    /**
     * What the node allows per wallet. Mirrors `[api.rate_limits]` in
     * `ogmara.toml`; see NODE_LIMITS for the l2-node 0.122.0 defaults.
     *
     * The bot picks the unverified or registered row based on the wallet's
     * actual on-chain status, checked at startup.
     */
    nodeBurstUnverified: z.int().positive().max(10_000).default(NODE_LIMITS.burstUnverified),
    nodeBurstRegistered: z.int().positive().max(10_000).default(NODE_LIMITS.burstRegistered),
    nodeDailyUnverified: z.int().positive().max(100_000).default(NODE_LIMITS.dailyUnverified),
    nodeDailyRegistered: z.int().positive().max(100_000).default(NODE_LIMITS.dailyRegistered),
    /**
     * Tag marking posts as bot-authored. Transparency by default — readers of a
     * decentralized feed should be able to tell automated posts apart. Set to
     * null only if you disclose in some other way.
     */
    disclosureTag: z.string().nullable().default('bot'),
    /** Tags added to every post, ahead of AI suggestions. */
    alwaysTags: z.array(z.string()).max(10).default([]),
    /** Always append the source article link for feed-derived posts. */
    includeSourceLink: z.boolean().default(true),
  })
  .refine(
    // Check against the UNVERIFIED daily ceiling, which is the tier every
    // wallet starts in — a config that only works once registered would let
    // the bot start and then fail against the node. 80% rather than 100%
    // leaves room for retries and for posts made by the same wallet elsewhere.
    (p) => p.maxPostsPerHour * 24 <= p.nodeDailyUnverified * 0.8,
    {
      message:
        'posting.maxPostsPerHour x 24h exceeds 80% of posting.nodeDailyUnverified. ' +
        'Every wallet starts unverified, so a higher cadence would fail against the node ' +
        'until you register (see `--register`, which raises the daily ceiling 6x)',
      path: ['maxPostsPerHour'],
    },
  );

const feedSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  /** Overrides the publisher name taken from the feed's own title. */
  publisher: z.string().min(1).optional(),
});

const rssSourceSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Cron expression for how often to poll and post. Validated here so a typo
   * stops startup instead of silently never firing.
   */
  schedule: z
    .string()
    .default('0 * * * *')
    .refine(isValidCron, { message: 'not a valid cron expression' }),
  feeds: z.array(feedSchema).default([]),
  /** Ignore items older than this many days. 0 disables the check. */
  maxAgeDays: z.int().min(0).max(365).default(2),
  /** Per-feed fetch timeout. */
  timeoutMs: z.int().min(1000).max(120_000).default(20_000),
  /** Reject a feed response larger than this. Guards against a runaway feed. */
  maxBytes: z.int().min(1024).max(50 * 1024 * 1024).default(5 * 1024 * 1024),
});

const sourcesSchema = z.object({
  rss: rssSourceSchema.prefault({}),
});

const aiSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'gemini', 'openai-compatible']).default('anthropic'),
    /**
     * Model identifier. Provider-specific — see docs/AI-PROVIDERS.md.
     * Defaults to Claude Opus 5; change it to trade capability for cost.
     */
    model: z.string().min(1).default('claude-opus-5'),
    /**
     * Endpoint override, required for `openai-compatible`. This is what makes
     * Ollama, OpenRouter, vLLM and other local servers work.
     */
    baseUrl: z.url({ protocol: /^https?$/ }).optional(),
    /**
     * Thinking depth and token spend (Anthropic only; ignored elsewhere).
     * Composing a post from a supplied summary is a short, scoped task, so the
     * default is `low` — raise it if posts read shallowly.
     */
    effort: z.enum(['low', 'medium', 'high']).default('low'),
    /** Output cap. A post is small; this is generous headroom, not a target. */
    maxTokens: z.int().min(256).max(64_000).default(4096),
    /** Prompt template used for feed-derived posts. */
    promptPath: z.string().min(1).default('prompts/news.md'),
    /** Rough body-length target handed to the model as guidance. */
    targetContentChars: z.int().min(100).max(10_000).default(600),
    /**
     * Hard caps on the untrusted feed fields before they enter the prompt.
     *
     * Feed `title`/`summary` are attacker-influenceable and were previously
     * unbounded up to the 5 MB feed cap. That is three problems at once: a
     * ~600 KB summary is ~150k tokens (~$2.25 per call, hourly, forever); an
     * oversized prompt returns a provider 400 that stalls the pipeline; and an
     * unbounded field can bury the prompt's own instructions. Real summaries
     * are a few hundred characters. (Audit 2026-08-26, M5.)
     */
    maxSourceTitleChars: z.int().min(50).max(2_000).default(500),
    maxSourceSummaryChars: z.int().min(100).max(50_000).default(4_000),
    /** How many tags to request. The protocol caps the final list at 10. */
    maxTags: z.int().min(1).max(10).default(5),
  })
  .refine((a) => a.provider !== 'openai-compatible' || a.baseUrl !== undefined, {
    message: 'ai.baseUrl is required when ai.provider is "openai-compatible"',
    path: ['baseUrl'],
  });

const profileSchema = z.object({
  /** Display name shown on the bot's posts. Omit to leave unchanged. */
  displayName: z.string().min(1).max(64).optional(),
  /** Short bio. Omit to leave unchanged. */
  bio: z.string().max(500).optional(),
  /** IPFS CID of an avatar image. Omit to leave unchanged. */
  avatarCid: z.string().min(1).optional(),
  /**
   * Publish the profile on every startup.
   *
   * Off by default: it is a signed message and so cheap but not free, and an
   * operator who edits their profile elsewhere should not have the bot
   * silently revert it on the next restart. Use `--set-profile` instead.
   */
  applyOnStart: z.boolean().default(false),
});

const queueSchema = z.object({
  /** Where composed-but-unpublished posts wait. */
  path: z.string().min(1).default('data/queue.json'),
  /** Give up on a post after this many failed publish attempts. */
  maxAttempts: z.int().min(1).max(50).default(5),
  /** Discard queued posts older than this — stale news is worse than none. */
  maxAgeHours: z.int().min(1).max(720).default(24),
});

const storageSchema = z.object({
  /** Where the posted-items ledger lives. */
  ledgerPath: z.string().min(1).default('data/ledger.json'),
  /** Entries older than this are pruned. */
  retentionDays: z.int().min(1).max(3650).default(90),
});

const configSchema = z.object({
  node: nodeSchema,
  // `prefault` rather than `default`: Zod 4's `.default()` takes an *output*
  // value, which for a schema this defaulted would mean restating every field.
  // `prefault` feeds `{}` through parsing instead, so the field defaults above
  // remain the single source of truth. Lets an operator omit the whole block.
  posting: postingSchema.prefault({}),
  sources: sourcesSchema.prefault({}),
  ai: aiSchema.prefault({}),
  profile: profileSchema.prefault({}),
  queue: queueSchema.prefault({}),
  storage: storageSchema.prefault({}),
});

/** Fully validated bot configuration (secrets excluded). */
export type Config = z.infer<typeof configSchema>;

/** The `ai` section, extracted for the provider factory. */
export type AiConfig = Config['ai'];

/** Secrets, sourced from the environment rather than the config file. */
export interface Secrets {
  /**
   * Bot wallet private key, 64 hex chars.
   *
   * Use a wallet dedicated to the bot. This key can sign as, and therefore
   * *is*, the identity every post is attributed to.
   */
  walletKeyHex: string;
  /** AI provider keys. Only the configured provider's key is required. */
  anthropicApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  geminiApiKey?: string | undefined;
  /**
   * Key for `openai-compatible` endpoints, kept separate from the real
   * OpenAI credential.
   *
   * Reusing OPENAI_API_KEY meant an operator who had used OpenAI and then
   * switched to a third-party endpoint — OpenRouter is recommended in our own
   * docs — silently shipped a live credential to that operator on every
   * request. (Audit 2026-08-26, M10.)
   */
  openaiCompatibleApiKey?: string | undefined;
}

/** Raised when config or secrets are invalid. Message is operator-facing. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Parse and validate a YAML config file. */
export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `could not read config file "${path}": ${reason}\n` +
        'Copy config.example.yaml to config.yaml to get started.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`"${path}" is not valid YAML: ${reason}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`invalid configuration in "${path}":\n${issues}`);
  }

  return result.data;
}

/**
 * Read secrets from the environment.
 *
 * The key is validated for shape here so a typo surfaces as a clear config
 * error at startup rather than an opaque signing failure later.
 */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const key = env['OGMARA_WALLET_KEY']?.trim();
  if (!key) {
    throw new ConfigError(
      'OGMARA_WALLET_KEY is not set.\n' +
        'Copy .env.example to .env and set the bot wallet private key (64 hex chars).\n' +
        'Use a wallet dedicated to this bot — never your personal wallet.',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new ConfigError(
      `OGMARA_WALLET_KEY must be exactly 64 hex characters (got ${key.length}). ` +
        'This is the raw Ed25519 private key, not a mnemonic or a klv1... address.',
    );
  }
  return {
    walletKeyHex: key.toLowerCase(),
    // Read unconditionally; the provider factory enforces that the configured
    // provider's key is present. Reading them all here means an operator can
    // switch providers in the config without touching .env.
    anthropicApiKey: env['ANTHROPIC_API_KEY']?.trim(),
    openaiApiKey: env['OPENAI_API_KEY']?.trim(),
    geminiApiKey: env['GEMINI_API_KEY']?.trim(),
    openaiCompatibleApiKey: env['OPENAI_COMPATIBLE_API_KEY']?.trim(),
  };
}
