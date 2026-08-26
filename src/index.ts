#!/usr/bin/env node
/**
 * ogmara-newsbot CLI entry point.
 *
 * Two modes: `--once` executes a single pipeline run and exits (good for cron,
 * systemd timers and testing), while the default runs the configured schedules
 * until interrupted.
 */

import { statSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { AiConfigError, createProvider } from './ai/index.js';
import { loadTemplate } from './ai/prompt.js';
import { ConfigError, loadConfig, loadSecrets, type Config, type Secrets } from './config.js';
import { Ledger } from './ledger.js';
import { LockError, acquireDataLock } from './lock.js';
import {
  InvalidPostError,
  NetworkMismatchError,
  OgmaraPublisher,
  type ComposedPost,
} from './ogmara.js';
import { PostQueue } from './queue.js';
import { runOnce, type RunOutcome } from './pipeline.js';
import { schedule, type ScheduledJob } from './scheduler.js';
import { RssSource } from './sources/rss.js';
import type { Source } from './sources/types.js';

interface CliArgs {
  configPath: string;
  /** Force dry-run regardless of config. Cannot be used to force live posting. */
  forceDryRun: boolean;
  /** Run the pipeline once and exit instead of scheduling. */
  once: boolean;
  showHelp: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    configPath: 'config.yaml',
    forceDryRun: false,
    once: false,
    showHelp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') args.showHelp = true;
    else if (arg === '--dry-run') args.forceDryRun = true;
    else if (arg === '--once') args.once = true;
    else if (arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined) throw new ConfigError('--config requires a path argument');
      args.configPath = next;
      i++;
    } else if (arg.startsWith('--config=')) {
      args.configPath = arg.slice('--config='.length);
    } else {
      throw new ConfigError(`unknown argument "${arg}" (try --help)`);
    }
  }
  return args;
}

const HELP = `ogmara-newsbot — publish AI-composed posts to the Ogmara News Feed

Usage: ogmara-newsbot [options]

Options:
  --once            Run the pipeline once and exit (default: run on schedule)
  --config <path>   Config file to use (default: config.yaml)
  --dry-run         Compose and print without publishing, overriding config
  -h, --help        Show this help

Secrets come from the environment (or a .env file), never the config file:
  OGMARA_WALLET_KEY   Bot wallet private key, 64 hex characters

Note: --dry-run can only ever make the bot safer. Live posting requires
setting posting.dryRun: false in the config file, deliberately.`;

/**
 * Strip terminal control sequences from text before printing it.
 *
 * Anything derived from a feed or from AI output can carry ANSI escapes. That
 * matters here more than in most CLIs: dry-run review is this project's stated
 * primary safety control, and an attacker who can repaint the pane could show
 * the operator a benign post while a different one is what publishes. Removes
 * C0/C1 controls (keeping \n and \t) and CSI/OSC sequences.
 * (Audit 2026-08-26, SEC-W7.)
 */
export function stripControlSequences(text: string): string {
  return (
    text
      // OSC: ESC ] ... terminated by BEL or ST (ESC \\)
      .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
      // CSI and other ESC-introduced sequences
      .replace(/\u001B[@-_][0-?]*[ -/]*[@-~]?/g, '')
      // Bare C0 controls except \t and \n, plus DEL and the C1 range
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
  );
}

/**
 * Warn when `.env` is readable by anyone but its owner.
 *
 * The README and `.env.example` both tell operators to `chmod 600`, and
 * nothing checked it. That file holds a key that IS the bot's posting
 * identity, and the audience for this project is people who may not think to
 * verify. (Audit 2026-08-26, SEC-N3.)
 */
function warnIfEnvReadable(): void {
  try {
    const mode = statSync('.env').mode & 0o077;
    if (mode !== 0) {
      console.warn(
        `Warning: .env is accessible to other users on this machine (mode ${(mode | 0o600).toString(8)}).\n` +
          '         It holds your wallet key. Run: chmod 600 .env',
      );
    }
  } catch {
    // No .env (env vars set directly) — nothing to check.
  }
}

/** Render a composed post for human review — the dry-run output. */
function renderPost(post: ComposedPost, address: string): void {
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`DRY RUN — not published   as ${address}`);
  console.log('─'.repeat(68));
  console.log(`Title:   ${stripControlSequences(post.title)}`);
  console.log(
    `Tags:    ${post.tags.length > 0 ? post.tags.map((t) => `#${t}`).join(' ') : '(none)'}`,
  );
  console.log('─'.repeat(68));
  console.log(stripControlSequences(post.content));
  console.log(`${'─'.repeat(68)}\n`);
}

/** Build the enabled sources from config. */
function buildSources(config: Config): Source[] {
  const sources: Source[] = [];
  const rss = config.sources.rss;
  if (rss.enabled) {
    if (rss.feeds.length === 0) {
      console.warn('Warning: sources.rss is enabled but no feeds are configured.');
    } else {
      sources.push(
        new RssSource({
          feeds: rss.feeds,
          timeoutMs: rss.timeoutMs,
          maxBytes: rss.maxBytes,
          maxAgeDays: rss.maxAgeDays,
        }),
      );
    }
  }
  return sources;
}

/** Report a run outcome to the console. */
function reportOutcome(outcome: RunOutcome, address: string): void {
  switch (outcome.status) {
    case 'dry-run':
      renderPost(outcome.post, address);
      console.log('Dry run — set posting.dryRun: false to publish for real.');
      break;
    case 'posted':
      console.log(
        `Published${outcome.fromQueue ? ' (from queue)' : ''} "${outcome.title}" — msg_id ${outcome.msgId}`,
      );
      break;
    case 'nothing-new':
      console.log(`Nothing new to post (${outcome.polled} candidates, all seen).`);
      break;
    case 'refused':
      console.log(
        `Model declined to write about "${outcome.title}"` +
          `${outcome.category !== undefined ? ` (${outcome.category})` : ''} — skipping it.`,
      );
      break;
    case 'compose-failed':
      console.log(`Could not compose "${outcome.title}" — will retry. (${outcome.reason})`);
      break;
    case 'deferred': {
      // Name the actual cause. The previous message said "Rate limited" for
      // all three, which pointed operators at their node even when the bot's
      // own cadence budget was the reason.
      const wait = `${Math.ceil(outcome.retryAfterMs / 1000)}s`;
      const why =
        outcome.cause === 'local-budget'
          ? `Holding to your configured cadence — next slot in ${wait}`
          : outcome.cause === 'node-rate-limit'
            ? `Node rate-limited this wallet — retrying in ${wait}`
            : `Node unreachable (${outcome.detail ?? 'unknown'}) — retrying in ${wait}`;
      console.log(`${why}. ${outcome.queued} post(s) queued.`);
      break;
    }
  }
}

async function run(args: CliArgs): Promise<number> {
  const config: Config = loadConfig(args.configPath);
  const secrets: Secrets = loadSecrets();

  const effective: Config = args.forceDryRun
    ? { ...config, posting: { ...config.posting, dryRun: true } }
    : config;

  const publisher = await OgmaraPublisher.create(effective, secrets);
  console.log(`Wallet:  ${publisher.address}`);
  console.log(`Node:    ${effective.node.url} (${effective.node.network})`);

  // health.version comes from the node, so it is remote text like any other.
  const health = await publisher.health();
  console.log(
    `Health:  v${stripControlSequences(health.version)}, ${health.peers} peers, ` +
      `media ${health.mediaUploads ? 'available' : 'UNAVAILABLE'}`,
  );

  // Before touching the ledger: two instances sharing a data directory
  // overwrite each other's records and republish items.
  acquireDataLock(effective.storage.ledgerPath);

  const ledger = Ledger.load(effective.storage.ledgerPath, effective.storage.retentionDays);
  console.log(`Ledger:  ${effective.storage.ledgerPath} (${ledger.size} entries)`);

  const queue = PostQueue.load(
    effective.queue.path,
    effective.queue.maxAttempts,
    effective.queue.maxAgeHours,
  );
  console.log(`Queue:   ${effective.queue.path} (${queue.size} pending)`);

  const provider = await createProvider(effective.ai, secrets);
  console.log(`AI:      ${provider.id} / ${provider.model}`);

  const template = loadTemplate(effective.ai.promptPath);

  const sources = buildSources(effective);
  if (sources.length === 0) {
    console.error(
      '\nNo sources are enabled. Enable at least one under `sources:` in your config.',
    );
    return 2;
  }
  console.log(`Sources: ${sources.map((s) => s.name).join(', ')}`);
  console.log(
    effective.posting.dryRun
      ? 'Mode:    dry run — nothing will be published'
      : `Mode:    LIVE — up to ${effective.posting.maxPostsPerHour} post(s)/hour`,
  );

  const deps = { config: effective, sources, ledger, queue, publisher, provider, template };

  if (args.once) {
    reportOutcome(await runOnce(deps), publisher.address);
    return 0;
  }

  const jobs: ScheduledJob[] = [];
  const rss = effective.sources.rss;
  if (rss.enabled) {
    const job = schedule(rss.schedule, async () => {
      console.log(`\n[${new Date().toISOString()}] rss run`);
      reportOutcome(await runOnce(deps), publisher.address);
    });
    jobs.push(job);
    console.log(`Schedule: rss "${rss.schedule}" — next ${job.nextRun()?.toISOString() ?? 'never'}`);
  }

  console.log('\nRunning. Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      console.log('\nStopping…');
      for (const job of jobs) job.stop();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  warnIfEnvReadable();

  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (args.showHelp) {
    console.log(HELP);
    return;
  }

  try {
    process.exitCode = await run(args);
  } catch (err) {
    // Config and payload problems are the operator's to fix and deserve a
    // clean message; anything else is a genuine fault and keeps its stack.
    if (
      err instanceof ConfigError ||
      err instanceof InvalidPostError ||
      err instanceof AiConfigError ||
      err instanceof LockError ||
      err instanceof NetworkMismatchError
    ) {
      console.error(`\n${err.name}: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    // err.stack, not the object: Node's inspector appends an error's own
    // enumerable properties, which on SDK errors means attached response
    // metadata. This is the one unbounded, unattended output path.
    console.error('\nUnexpected error:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

await main();
