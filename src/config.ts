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
 * Conservative default for the node's per-wallet news rate limit.
 *
 * The reference l2-node currently allows 5 news posts/hour/wallet, enforced at
 * the ingress node only. That value is being reworked upstream (tiered by
 * on-chain registration, with burst + sustained windows), and it is *not*
 * discoverable over the API — so it lives here as an operator-tunable number
 * rather than a hardcoded constant. Point the bot at a node with a higher
 * ceiling and raise this to match; there is no code change involved.
 */
export const DEFAULT_NODE_NEWS_LIMIT_PER_HOUR = 5;

/** Protocol caps on a news post payload (spec §3.5). */
export const MAX_TITLE_BYTES = 256;
export const MAX_CONTENT_CHARS = 65536;

const contentRating = z.enum(['general', 'teen', 'mature', 'explicit']);

const nodeSchema = z.object({
  /** Base URL of the Ogmara L2 node to post through. */
  url: z.url({ protocol: /^https?$/ }),
  /** Must match the node's network or every signature is rejected. */
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
    /** Bot's own posting cadence ceiling. Validated against `nodeNewsLimitPerHour`. */
    maxPostsPerHour: z.number().positive().max(100).default(1),
    /** What the node will actually allow; see DEFAULT_NODE_NEWS_LIMIT_PER_HOUR. */
    nodeNewsLimitPerHour: z
      .int()
      .positive()
      .max(10_000)
      .default(DEFAULT_NODE_NEWS_LIMIT_PER_HOUR),
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
  .refine((p) => p.maxPostsPerHour <= p.nodeNewsLimitPerHour * 0.8, {
    // Staying under the node's ceiling rather than at it leaves room for
    // retries and for posts made by the same wallet outside the bot. Running
    // flush against the limit means the first retry is rejected.
    message:
      'posting.maxPostsPerHour must be at most 80% of posting.nodeNewsLimitPerHour — ' +
      'leave headroom for retries, or raise nodeNewsLimitPerHour if your node allows more',
    path: ['maxPostsPerHour'],
  });

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
  storage: storageSchema.prefault({}),
});

/** Fully validated bot configuration (secrets excluded). */
export type Config = z.infer<typeof configSchema>;

/** Secrets, sourced from the environment rather than the config file. */
export interface Secrets {
  /**
   * Bot wallet private key, 64 hex chars.
   *
   * Use a wallet dedicated to the bot. This key can sign as, and therefore
   * *is*, the identity every post is attributed to.
   */
  walletKeyHex: string;
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
  return { walletKeyHex: key.toLowerCase() };
}
