#!/usr/bin/env node
/**
 * ogmara-newsbot CLI entry point.
 *
 * Two modes: `--once` executes a single pipeline run and exits (good for cron,
 * systemd timers and testing), while the default runs the configured schedules
 * until interrupted.
 */

import { statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { WalletSigner } from '@ogmara/sdk';
import { config as loadDotenv } from 'dotenv';
import { AiConfigError, createProvider } from './ai/index.js';
import { loadTemplate } from './ai/prompt.js';
import {
  ensureConfigFile,
  ensureWalletKey,
  readWalletKeyFromFile,
  type WalletBootstrapResult,
} from './bootstrap.js';
import { ConfigError, loadConfig, loadSecrets, type Config, type Secrets } from './config.js';
import { applyProfile, checkRegistration, registerWallet } from './identity.js';
import { KleverError, REGISTRATION_COST_KLV } from './klever.js';
import { Ledger } from './ledger.js';
import { LockError, acquireDataLock } from './lock.js';
import {
  InvalidPostError,
  NetworkMismatchError,
  OgmaraPublisher,
  type ComposedPost,
} from './ogmara.js';
import { PanelAuth } from './panel/auth.js';
import { TrustedProxies } from './panel/clientip.js';
import { startPanel, type Panel } from './panel/server.js';
import { PostQueue } from './queue.js';
import { runOnce, type RunOutcome } from './pipeline.js';
import { schedule, type ScheduledJob } from './scheduler.js';
import { ImageDirSource } from './sources/imagedir.js';
import { RssSource } from './sources/rss.js';
import { TopicsSource } from './sources/topics.js';
import type { Source } from './sources/types.js';
import { WALLET_BACKUP_PATH, acknowledgeBackup, isBackupPending } from './walletBackup.js';

interface CliArgs {
  configPath: string;
  /** Force dry-run regardless of config. Cannot be used to force live posting. */
  forceDryRun: boolean;
  /** Run the pipeline once and exit instead of scheduling. */
  once: boolean;
  /** Publish the configured profile and exit. */
  setProfile: boolean;
  /** Register the wallet on-chain and exit. Spends KLV. */
  register: boolean;
  /** Skip the interactive confirmation on --register. For scripted use. */
  assumeYes: boolean;
  showHelp: boolean;
  /** Scaffold config.yaml / generate a wallet key, then exit. Never overwrites either. */
  init: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    configPath: 'config.yaml',
    forceDryRun: false,
    once: false,
    setProfile: false,
    register: false,
    assumeYes: false,
    showHelp: false,
    init: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') args.showHelp = true;
    else if (arg === '--dry-run') args.forceDryRun = true;
    else if (arg === '--once') args.once = true;
    else if (arg === '--set-profile') args.setProfile = true;
    else if (arg === '--register') args.register = true;
    else if (arg === '--init') args.init = true;
    else if (arg === '--yes' || arg === '-y') args.assumeYes = true;
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

First run:
  --init            Create config.yaml (from config.example.yaml) and, if run
                    interactively, offer to generate a wallet key — then
                    exit so you can review both before running for real.
                    Never overwrites an existing config.yaml or key. Also
                    runs automatically (without needing this flag) whenever
                    config.yaml is missing or no wallet key is configured.

Identity:
  --set-profile     Publish the display name / bio from your config, then exit
  --register        Register this wallet on-chain, then exit. SPENDS ~4.4 KLV
                    and cannot be undone. Raises the node's daily posting
                    ceiling from 50 to 300. Asks for confirmation first.
  -y, --yes         Skip that confirmation (for scripted use)

Control panel:
  Set panel.enabled: true in the config to serve a small web UI for changing
  the display name and registering the wallet, while the bot runs on its
  schedule. The bot always signs with its own wallet; panel.adminWallets
  names the SEPARATE operator wallets allowed to log in and drive it — same
  model as the l2-node dashboard. Always reachable with no login from
  localhost; add panel.adminWallets to allow signed-in remote access.

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
  if (post.attachments !== undefined && post.attachments.length > 0) {
    for (const a of post.attachments) {
      const note =
        a.cid === 'dry-run-not-uploaded'
          ? '(validated, not uploaded — dry run)'
          : `cid ${a.cid}`;
      console.log(`Image:   ${a.filename ?? '(unnamed)'} ${note}`);
    }
  }
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

  const topics = config.sources.topics;
  if (topics.enabled) {
    if (topics.topics.length === 0) {
      console.warn('Warning: sources.topics is enabled but no topics are configured.');
    } else {
      sources.push(
        new TopicsSource({ topics: topics.topics, minIntervalHours: topics.minIntervalHours }),
      );
    }
  }

  const imagedir = config.sources.imagedir;
  if (imagedir.enabled) {
    if (imagedir.directories.length === 0) {
      console.warn('Warning: sources.imagedir is enabled but no directories are configured.');
    } else {
      sources.push(
        new ImageDirSource({ directories: imagedir.directories, maxBytes: imagedir.maxBytes }),
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

/** Longest a `confirm()` prompt waits before treating silence as "no". */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/**
 * Ask the operator to confirm a consequential action (spending KLV,
 * generating a wallet key).
 *
 * Returns false rather than assuming consent whenever nobody can plausibly
 * be there to answer:
 * - Neither stdin nor stdout is a TTY (cron, systemd, a pipe). Checking
 *   both, not just stdin, matters — a session with input attached but output
 *   redirected elsewhere (or vice versa) is exactly as unattended as one
 *   with neither, and treating it as interactive would print a prompt that
 *   silently blocks forever with nobody able to see or answer it.
 * - The prompt sits unanswered for {@link CONFIRM_TIMEOUT_MS}: a TTY can be
 *   attached to a session nobody is actually watching (a detached tmux pane,
 *   an `-it` container under a restart policy), and a wallet-generation or
 *   fund-spending prompt must eventually give up rather than wedge the
 *   process indefinitely.
 *
 * Scripted callers opt in explicitly with --yes rather than relying on this.
 */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Not an interactive terminal — refusing to assume consent.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const answer = await rl.question(`${question} [y/N] `, { signal: controller.signal });
    return /^y(es)?$/i.test(answer.trim());
  } catch (err) {
    if (controller.signal.aborted) {
      console.error('\nNo response — assuming no.');
      return false;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

/** `--set-profile`: publish the configured display name / bio. */
async function runSetProfile(config: Config, secrets: Secrets): Promise<number> {
  const publisher = await OgmaraPublisher.create(config, secrets);
  await publisher.health(); // also enforces the network match
  console.log(`Wallet:  ${publisher.address}`);

  const result = await applyProfile(publisher.client, {
    displayName: config.profile.displayName,
    bio: config.profile.bio,
    avatarCid: config.profile.avatarCid,
  });

  if (result.status === 'nothing-to-do') {
    console.error(
      '\nNothing to publish: set profile.displayName (and optionally bio, avatarCid) ' +
        'in your config first.',
    );
    return 2;
  }
  console.log(`Profile updated${result.displayName !== undefined ? ` — display name is now "${result.displayName}"` : ''}.`);
  return 0;
}

/** `--register`: register the wallet on-chain after explicit confirmation. */
async function runRegister(config: Config, secrets: Secrets, assumeYes: boolean): Promise<number> {
  const publisher = await OgmaraPublisher.create(config, secrets);
  const network = config.node.network;
  console.log(`Wallet:  ${publisher.address}`);
  console.log(`Network: ${network}\n`);

  const status = await checkRegistration(network, publisher.address);
  if (status.registered) {
    const when = new Date(status.registeredAt * 1000).toISOString().slice(0, 10);
    console.log(`Already registered (since ${when}). Nothing to do.`);
    console.log(
      `Daily posting ceiling: ${config.posting.nodeDailyRegistered} ` +
        `(vs ${config.posting.nodeDailyUnverified} unregistered).`,
    );
    return 0;
  }

  console.log('This wallet is NOT registered on-chain.\n');
  console.log(`  Cost:     ~${REGISTRATION_COST_KLV} KLV, non-refundable`);
  console.log(`  Balance:  ${status.balanceKlv.toFixed(4)} KLV`);
  console.log(
    `  Unlocks:  ${config.posting.nodeDailyRegistered} posts/day instead of ` +
      `${config.posting.nodeDailyUnverified}, and ` +
      `${config.posting.nodeBurstRegistered} per 10 min instead of ` +
      `${config.posting.nodeBurstUnverified}\n`,
  );

  if (!status.canAfford) {
    console.error(
      `Insufficient funds: need ~${REGISTRATION_COST_KLV} KLV, wallet holds ` +
        `${status.balanceKlv.toFixed(4)}. Send KLV to ${publisher.address} and retry.`,
    );
    return 2;
  }

  if (!assumeYes && !(await confirm('Register this wallet on-chain?'))) {
    console.log('Cancelled. Nothing was spent.');
    return 0;
  }

  console.log('\nSubmitting registration…');
  const result = await registerWallet(network, publisher.signer, hexToKey(secrets.walletKeyHex));
  switch (result.status) {
    case 'already-registered':
      console.log('Already registered — nothing was spent.');
      return 0;
    case 'insufficient-funds':
      console.error(`Insufficient funds: need ${result.requiredKlv} KLV, have ${result.balanceKlv}.`);
      return 2;
    case 'registered':
      console.log(`Registered. Transaction: ${result.txHash}`);
      console.log(`  ${result.explorerUrl}`);
      console.log(
        '\nThe node picks this up via its chain scanner, usually within a minute. ' +
          'Raise posting.maxPostsPerHour in your config to use the higher ceiling.',
      );
      return 0;
  }
}

/** Decode the operator's 64-char hex wallet key to raw bytes. */
function hexToKey(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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

  // Registration decides the node's ceiling for this wallet (6x on the daily
  // limit), so the publisher must know it before modelling any budget. A
  // failure here is non-fatal — the chain being unreachable should not stop
  // the bot posting at the conservative unregistered rate.
  try {
    const reg = await checkRegistration(effective.node.network, publisher.address);
    publisher.setRegistered(reg.registered);
    console.log(
      `Wallet:  ${reg.registered ? 'REGISTERED' : 'unregistered'} on-chain — ` +
        `node allows ${publisher.dailyLimit}/day, ${publisher.burstLimit}/10min` +
        `${reg.registered ? '' : '  (run --register to raise this 6x)'}`,
    );
  } catch (err) {
    console.warn(
      `  warning: could not check on-chain registration (${err instanceof Error ? err.message : err}); ` +
        'assuming unregistered limits.',
    );
  }

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

  if (effective.profile.applyOnStart) {
    const result = await applyProfile(publisher.client, {
      displayName: effective.profile.displayName,
      bio: effective.profile.bio,
      avatarCid: effective.profile.avatarCid,
    });
    if (result.status === 'updated') console.log('Profile: published from config');
  }

  const templates = {
    rss: loadTemplate(effective.ai.promptPath),
    topics: loadTemplate(effective.ai.topicPromptPath),
    imagedir: loadTemplate(effective.ai.imagePromptPath),
  };

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

  // Fail here rather than at the first image post: a text-only model would
  // otherwise caption a picture it never saw, which looks like it worked.
  if (effective.sources.imagedir.enabled && !provider.supportsVision) {
    console.error(
      `\nsources.imagedir is enabled but the configured model (${provider.id}/${provider.model}) ` +
        'cannot accept images.\nUse a vision-capable model, or set ' +
        'ai.compatibleSupportsVision: true if your local model does support them.',
    );
    return 2;
  }

  if (effective.sources.imagedir.enabled && !health.mediaUploads) {
    console.error(
      '\nsources.imagedir is enabled but the node reports media uploads are unavailable ' +
        '(its IPFS backend is offline).\nStart IPFS on the node, or point the bot at a ' +
        'media-capable node.',
    );
    return 2;
  }

  const deps = { config: effective, sources, ledger, queue, publisher, provider, templates };

  if (args.once) {
    reportOutcome(await runOnce(deps), publisher.address);
    return 0;
  }

  // The panel only makes sense for a long-running instance — `--once` exits
  // immediately, which would start a server nobody could ever reach.
  let panel: Panel | undefined;
  if (effective.panel.enabled) {
    panel = await startControlPanel(effective, secrets, publisher);
  }

  // One job per enabled source, each on its own cron. They share the run
  // pipeline, and the scheduler's overlap guard is per-job, so two sources
  // firing on the same minute run sequentially rather than racing the ledger.
  const jobs: ScheduledJob[] = [];
  const schedules: Array<{ name: string; cron: string }> = [];
  if (effective.sources.rss.enabled) {
    schedules.push({ name: 'rss', cron: effective.sources.rss.schedule });
  }
  if (effective.sources.topics.enabled) {
    schedules.push({ name: 'topics', cron: effective.sources.topics.schedule });
  }
  if (effective.sources.imagedir.enabled) {
    schedules.push({ name: 'imagedir', cron: effective.sources.imagedir.schedule });
  }

  for (const { name, cron } of schedules) {
    const job = schedule(cron, async () => {
      console.log(`\n[${new Date().toISOString()}] ${name} run`);
      reportOutcome(await runOnce(deps), publisher.address);
    });
    jobs.push(job);
    console.log(`Schedule: ${name} "${cron}" — next ${job.nextRun()?.toISOString() ?? 'never'}`);
  }

  console.log('\nRunning. Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      // Both SIGINT and SIGTERM can arrive in the same forceful kill; without
      // this guard a second signal re-stops already-stopped jobs, prints
      // "Stopping…" twice, and calls panel.close() a second time.
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nStopping…');
      for (const job of jobs) job.stop();
      if (panel === undefined) {
        resolve();
        return;
      }
      // close() cannot reject today (its callback ignores its error
      // argument), but guarding it costs nothing and removes the dependence
      // on that staying true.
      panel.close().catch(() => {}).finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

/**
 * Start the control panel, translating config validation errors and bind
 * failures into the same "fail loudly at startup" style as the rest of `run`.
 */
async function startControlPanel(
  config: Config,
  secrets: Secrets,
  publisher: OgmaraPublisher,
): Promise<Panel> {
  let trustedProxies: TrustedProxies;
  try {
    trustedProxies = new TrustedProxies(config.panel.trustedProxies);
  } catch (err) {
    // Reachable in principle even though the schema also validates CIDR shape
    // (config.ts's superRefine): keeping the check here too means a future
    // schema change can't silently drop it and leave this constructor as the
    // only backstop against a malformed trusted-proxy list.
    throw new ConfigError(
      `invalid panel.trustedProxies: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const auth = new PanelAuth({
    adminWallets: config.panel.adminWallets,
    botAddress: publisher.address,
    network: config.node.network,
    sessionTtlHours: config.panel.sessionTtlHours,
  });

  const panel = await startPanel(config.panel.bind, config.panel.port, {
    auth,
    trustedProxies,
    network: config.node.network,
    client: publisher.client,
    signer: publisher.signer,
    botAddress: publisher.address,
    walletKeyHex: secrets.walletKeyHex,
    dailyLimitFn: () => publisher.dailyLimit,
    burstLimitFn: () => publisher.burstLimit,
    dryRunFn: () => config.posting.dryRun,
    checkRegistration,
    applyProfile,
    registerWallet,
    allowedHosts: config.panel.allowedHosts,
    requireLogin: config.panel.requireLogin,
    isWalletBackupPending: () => isBackupPending(WALLET_BACKUP_PATH),
    acknowledgeWalletBackup: () => acknowledgeBackup(WALLET_BACKUP_PATH),
  });

  console.log(
    `Panel:   http://${config.panel.bind}:${panel.port} ` +
      `(${auth.remoteLoginEnabled ? `${config.panel.adminWallets.length} wallet(s) authorised` : 'localhost-only, no remote login configured'})`,
  );
  if (!auth.remoteLoginEnabled && !config.panel.requireLogin) {
    console.log(
      '  Anyone able to reach this port from 127.0.0.1 gets full access with no login — ' +
        'that includes a reverse proxy on this host that forwards WITHOUT setting ' +
        'X-Forwarded-For. If you front this panel, either configure that header or set ' +
        'panel.requireLogin: true.',
    );
  }
  return panel;
}

/**
 * First-run convenience: scaffold `config.yaml` if it's missing, and — only
 * when a human is actually present to see and back it up — offer to
 * generate a wallet key if none is configured.
 *
 * @returns whether a summary was printed. When true, the caller should stop
 *          here: either something was just created (worth reviewing before
 *          a real run) or `--init` was passed explicitly as a status check.
 */
async function runBootstrap(args: CliArgs): Promise<boolean> {
  const configCreated = ensureConfigFile(args.configPath);

  const currentKey = process.env['OGMARA_WALLET_KEY'];
  const alreadyConfigured = currentKey !== undefined && currentKey.trim() !== '';

  let walletResult: WalletBootstrapResult = { generated: false };
  if (!alreadyConfigured) {
    // `--init` is itself the explicit ask; a bare run at a real terminal
    // still confirms first, since generating a wallet mints a real identity
    // and shouldn't happen as a side effect nobody consciously agreed to.
    // Neither path is taken for an unattended process (no TTY, no --init) —
    // that keeps today's behavior (a clear ConfigError) exactly as it was.
    const shouldGenerate =
      args.init ||
      (process.stdin.isTTY === true &&
        (await confirm('No wallet key is configured for this bot. Generate a new one now?')));
    if (shouldGenerate) {
      walletResult = await ensureWalletKey('.env', currentKey, WALLET_BACKUP_PATH);
    }
  }

  const hasNews = configCreated || walletResult.generated || walletResult.writeError !== undefined;
  if (!hasNews && !args.init) return false;

  console.log('');
  console.log(
    configCreated
      ? `Created ${args.configPath} from config.example.yaml — edit it before running for real.`
      : `${args.configPath} already exists.`,
  );

  if (walletResult.writeError !== undefined) {
    // Deliberately no key material here — see bootstrap.ts's WalletBootstrapResult
    // doc comment for why a freshly generated, unfunded key is discarded
    // rather than printed as a "last resort".
    console.log(
      `\nCould not save a new wallet key to "${walletResult.writeError.path}": ` +
        `${walletResult.writeError.message}`,
    );
    console.log('Fix that (permissions, disk space, path exists), then run --init again.');
  } else if (walletResult.generated) {
    console.log(`\nGenerated a new bot wallet: ${walletResult.address}`);
    console.log('Saved to .env.');
    console.log(
      '\n*** BACK UP YOUR .env FILE. This key is the only copy of this identity and\n' +
        '*** cannot be recovered if lost — anyone who obtains it can post as this\n' +
        '*** bot. The control panel will keep reminding you until you confirm the\n' +
        '*** backup there (panel.enabled: true).',
    );
  } else {
    // `process.env` can disagree with the file — that disagreement is
    // exactly what ensureWalletKey guards against (see bootstrap.ts's module
    // comment), and it means `alreadyConfigured` alone isn't trustworthy for
    // reporting either. Fall back to reading the file directly before ever
    // telling the operator "no key configured", so a refused-but-safe
    // generation attempt (the whole point of that guard) can't ALSO look
    // like the key went missing.
    const fileKey = alreadyConfigured ? currentKey : readWalletKeyFromFile('.env');
    if (fileKey !== undefined) {
      let address = 'unknown — check OGMARA_WALLET_KEY';
      try {
        address = (await WalletSigner.fromHex(fileKey)).address;
      } catch {
        // Leave the placeholder; loadSecrets will explain the real problem
        // in detail the next time something actually needs the key.
      }
      console.log(`\nWallet key already configured (${address}).`);
    } else {
      console.log(
        '\nNo wallet key configured yet. Run this again from a terminal to be asked, ' +
          'or set OGMARA_WALLET_KEY in .env yourself.',
      );
    }
  }

  console.log(
    `\nNext: edit ${args.configPath} (enable at least one source under sources:), ` +
      'add an AI provider key to .env, then run again.',
  );
  return true;
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
    if (await runBootstrap(args)) return;

    if (args.setProfile || args.register) {
      const config = loadConfig(args.configPath);
      const secrets = loadSecrets();
      process.exitCode = args.setProfile
        ? await runSetProfile(config, secrets)
        : await runRegister(config, secrets, args.assumeYes);
      return;
    }
    process.exitCode = await run(args);
  } catch (err) {
    // Config and payload problems are the operator's to fix and deserve a
    // clean message; anything else is a genuine fault and keeps its stack.
    if (
      err instanceof ConfigError ||
      err instanceof InvalidPostError ||
      err instanceof AiConfigError ||
      err instanceof LockError ||
      err instanceof KleverError ||
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
