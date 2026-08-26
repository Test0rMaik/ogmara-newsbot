#!/usr/bin/env node
/**
 * ogmara-newsbot CLI entry point.
 *
 * P0 scope: load and validate config, connect to a node, compose a post from a
 * placeholder source, and render it. Real sources and AI composition arrive in
 * later phases; the publish path below is the final one.
 */

import { config as loadDotenv } from 'dotenv';
import { ConfigError, loadConfig, loadSecrets, type Config, type Secrets } from './config.js';
import { buildTags } from './hashtags.js';
import { InvalidPostError, OgmaraPublisher, type ComposedPost } from './ogmara.js';

interface CliArgs {
  configPath: string;
  /** Force dry-run regardless of config. Cannot be used to force live posting. */
  forceDryRun: boolean;
  showHelp: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { configPath: 'config.yaml', forceDryRun: false, showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.showHelp = true;
    else if (arg === '--dry-run') args.forceDryRun = true;
    else if (arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined) throw new ConfigError('--config requires a path argument');
      args.configPath = next;
      i++;
    } else if (arg !== undefined && arg.startsWith('--config=')) {
      args.configPath = arg.slice('--config='.length);
    } else if (arg !== undefined) {
      throw new ConfigError(`unknown argument "${arg}" (try --help)`);
    }
  }
  return args;
}

const HELP = `ogmara-newsbot — publish AI-composed posts to the Ogmara News Feed

Usage: ogmara-newsbot [options]

Options:
  --config <path>   Config file to use (default: config.yaml)
  --dry-run         Compose and print without publishing, overriding config
  -h, --help        Show this help

Secrets come from the environment (or a .env file), never the config file:
  OGMARA_WALLET_KEY   Bot wallet private key, 64 hex characters

Note: --dry-run can only ever make the bot safer. Live posting requires
setting posting.dryRun: false in the config file, deliberately.`;

/** Render a composed post for human review — the dry-run output. */
function renderPost(post: ComposedPost, address: string, dryRun: boolean): void {
  const banner = dryRun ? 'DRY RUN — not published' : 'PUBLISHING';
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`${banner}   as ${address}`);
  console.log('─'.repeat(68));
  console.log(`Title:   ${post.title}`);
  console.log(`Tags:    ${post.tags.length > 0 ? post.tags.map((t) => `#${t}`).join(' ') : '(none)'}`);
  console.log('─'.repeat(68));
  console.log(post.content);
  console.log(`${'─'.repeat(68)}\n`);
}

/**
 * Placeholder composer standing in for the source + AI pipeline.
 *
 * It exercises the real tag-building and validation path, so the P0 dry-run
 * proves the publish plumbing end to end. Replaced in P1/P2.
 */
function composePlaceholder(config: Config): ComposedPost {
  const title = 'Ogmara NewsBot is configured correctly';
  const content = [
    'This is a placeholder post produced by `ogmara-newsbot` during setup.',
    '',
    'If you are seeing this as a dry run, your config, wallet key and node',
    'connection are all working. Configure a source and an AI provider to',
    'start composing real posts.',
  ].join('\n');

  const required = [...config.posting.alwaysTags];
  if (config.posting.disclosureTag !== null) required.unshift(config.posting.disclosureTag);

  return {
    title,
    content,
    tags: buildTags({ required, suggested: ['ogmara', 'setup'], title, content }),
  };
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
  console.log(`Health:  v${health.version}, ${health.peers} peers, media ${health.mediaUploads ? 'available' : 'UNAVAILABLE'}`);

  if (effective.posting.dryRun) {
    console.log('Mode:    dry run — nothing will be published');
  } else {
    console.log(`Mode:    LIVE — posting up to ${effective.posting.maxPostsPerHour}/hour`);
  }

  const post = composePlaceholder(effective);
  renderPost(post, publisher.address, effective.posting.dryRun);

  const result = await publisher.publish(post);
  switch (result.status) {
    case 'dry-run':
      console.log('Dry run complete. Set posting.dryRun: false to publish for real.');
      return 0;
    case 'published':
      console.log(`Published. msg_id: ${result.msgId}`);
      return 0;
    case 'rate-limited':
      console.log(`Rate limited — next slot in ${Math.ceil(result.retryAfterMs / 1000)}s.`);
      return 0;
  }
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
