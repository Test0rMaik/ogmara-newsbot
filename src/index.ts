#!/usr/bin/env node
/**
 * ogmara-newsbot CLI entry point.
 *
 * Two modes: `--once` executes a single pipeline run and exits (good for cron,
 * systemd timers and testing), while the default runs the configured schedules
 * until interrupted.
 */

import { config as loadDotenv } from 'dotenv';
import { ConfigError, loadConfig, loadSecrets, type Config, type Secrets } from './config.js';
import { Ledger } from './ledger.js';
import { InvalidPostError, OgmaraPublisher, type ComposedPost } from './ogmara.js';
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

/** Render a composed post for human review — the dry-run output. */
function renderPost(post: ComposedPost, address: string): void {
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`DRY RUN — not published   as ${address}`);
  console.log('─'.repeat(68));
  console.log(`Title:   ${post.title}`);
  console.log(
    `Tags:    ${post.tags.length > 0 ? post.tags.map((t) => `#${t}`).join(' ') : '(none)'}`,
  );
  console.log('─'.repeat(68));
  console.log(post.content);
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
      console.log(`Published "${outcome.title}" — msg_id ${outcome.msgId}`);
      break;
    case 'nothing-new':
      console.log(`Nothing new to post (${outcome.polled} candidates, all seen).`);
      break;
    case 'rate-limited':
      console.log(`Rate limited — next slot in ${Math.ceil(outcome.retryAfterMs / 1000)}s.`);
      break;
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

  const health = await publisher.health();
  console.log(
    `Health:  v${health.version}, ${health.peers} peers, media ${health.mediaUploads ? 'available' : 'UNAVAILABLE'}`,
  );

  const ledger = Ledger.load(effective.storage.ledgerPath, effective.storage.retentionDays);
  console.log(`Ledger:  ${effective.storage.ledgerPath} (${ledger.size} entries)`);

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

  const deps = { config: effective, sources, ledger, publisher };

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
    if (err instanceof ConfigError || err instanceof InvalidPostError) {
      console.error(`\n${err.name}: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error('\nUnexpected error:');
    console.error(err);
    process.exitCode = 1;
  }
}

await main();
