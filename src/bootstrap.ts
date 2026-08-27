/**
 * First-run bootstrap: scaffold `config.yaml` and, when asked, generate a
 * wallet key.
 *
 * The two actions carry very different risk and are treated accordingly:
 *
 * - **Creating `config.yaml`** is harmless — worst case, a helpful skeleton
 *   appears that still needs editing before the bot does anything. Safe to
 *   run unconditionally whenever the target path is missing.
 * - **Generating a wallet key** creates a real, currently-unfunded Klever
 *   identity whose only copy will exist in `.env`. Doing this silently on an
 *   unattended run (cron, systemd, a container restarting after a config
 *   mistake) risks minting a key nobody ever sees or backs up. So this module
 *   never decides *whether* to generate — it only *does* it when told to. The
 *   caller (`index.ts`) is where that decision — explicit `--init`, or an
 *   interactive confirmation — actually lives.
 *
 *   Separately, and just as important: `ensureWalletKey` must never
 *   overwrite a key that already exists. An earlier version of this function
 *   trusted its caller's `currentValue` (derived from `process.env`) for that
 *   decision — but dotenv resolves duplicate `OGMARA_WALLET_KEY=` lines
 *   last-wins, so an operator who pastes a fresh `.env.example` onto the end
 *   of their real `.env` (a completely normal way to pick up newly documented
 *   variables) ends up with `process.env` reporting empty while the FILE
 *   still holds the real key on an earlier line — and the old code's
 *   non-global regex replace would then destroy exactly that line, since it
 *   was the first match. Worse: dotenv's own `populate()` treats a
 *   *present-but-empty* environment variable as already "set" (it checks
 *   `hasOwnProperty`, not truthiness) and skips reading `.env` for it at
 *   all — so `export OGMARA_WALLET_KEY=` in a parent shell, or a templated
 *   systemd `Environment=` line that resolved to empty, reproduces the same
 *   destruction with no `.env` editing at all.
 *
 *   The fix is structural, not a patch: the FILE is the only thing this
 *   function ever writes, so the FILE — parsed with the exact same `dotenv`
 *   parser that will load it at real startup — is the only thing it trusts
 *   to answer "does a key already exist". `currentValue` is used only as a
 *   fast-path skip (the common case, once configured, on every ordinary
 *   invocation) and is never the sole basis for anything destructive.
 */

import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { WalletSigner } from '@ogmara/sdk';
import { parse as parseDotenv } from 'dotenv';
import { acquireDataLock } from './lock.js';
import { markBackupPending } from './walletBackup.js';

// This file lives at src/bootstrap.ts (tsx) or dist/bootstrap.js (built) —
// both one level below the package root, where config.example.yaml and
// .env.example ship. Resolved from the module's own location rather than
// `process.cwd()` so it still works if the bot is ever invoked from
// elsewhere.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Create `configPath` from the shipped `config.example.yaml` if it doesn't
 * already exist. Never overwrites an existing file.
 *
 * @returns whether a file was created.
 */
export function ensureConfigFile(configPath: string): boolean {
  if (existsSync(configPath)) return false;

  let example: string;
  try {
    example = readFileSync(join(PACKAGE_ROOT, 'config.example.yaml'), 'utf8');
  } catch {
    // Shipped file missing — an unusual install. Say nothing here; the
    // ordinary loadConfig failure for the still-missing path explains it.
    return false;
  }

  writeFileSync(configPath, example);
  return true;
}

/** Outcome of a wallet-key bootstrap attempt. */
export interface WalletBootstrapResult {
  generated: boolean;
  address?: string;
  /**
   * Set when a key WAS generated but could not be persisted. Deliberately
   * carries no key material: the key at this point is brand new, unfunded
   * and has never signed anything, so discarding it costs nothing — nowhere
   * near what printing a private key to a terminal could cost if that output
   * is ever captured (a systemd journal, CI logs, a recorded session). The
   * operator just fixes whatever blocked the write and runs `--init` again.
   */
  writeError?: { message: string; path: string };
}

/** Largest `.env` file this will read. A real secrets file is a few KB. */
const MAX_ENV_FILE_BYTES = 1024 * 1024;

/**
 * Matches every `OGMARA_WALLET_KEY=` line, tolerant of a leading `export`
 * and indentation — because `dotenv` tolerates both, and finding every line
 * dotenv would (not just the first, or the one it resolves to) is exactly
 * what both `hasAnyExistingKey` and the rewrite step below depend on.
 */
const ENV_KEY_LINE = /^[ \t]*(?:export[ \t]+)?OGMARA_WALLET_KEY[ \t]*=.*$/gm;

/** Read a `.env`-shaped file, refusing anything implausibly large (a FIFO, a mistake, an attack). */
function readSmallFile(path: string): string {
  const size = statSync(path).size;
  if (size > MAX_ENV_FILE_BYTES) {
    throw new Error(`"${path}" is ${Math.round(size / 1024)} KB — too large to be a real .env file`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * Whether ANY `OGMARA_WALLET_KEY` line in the file has a real value —
 * deliberately not "what does dotenv resolve this file to", which only
 * reflects the last matching line and would miss a real key shadowed by a
 * later stray empty one. Each candidate line is parsed on its own with the
 * real `dotenv` parser (a single `KEY=value` line is a valid tiny dotenv
 * file), so quoting/export/whitespace are handled exactly as they will be
 * when the file is actually loaded — just per line instead of per file.
 */
function hasAnyExistingKey(content: string): boolean {
  const lines = content.match(ENV_KEY_LINE) ?? [];
  return lines.some((line) => {
    const value = parseDotenv(line)['OGMARA_WALLET_KEY'];
    return value !== undefined && value.trim() !== '';
  });
}

/**
 * Read the wallet key actually on disk at `envPath`, entirely independent of
 * `process.env`.
 *
 * Exists for status reporting after a refused generation: `process.env` can
 * disagree with the file (that disagreement is precisely what `ensureWalletKey`
 * guards against — see the module comment), so a caller that wants to tell the
 * operator "yes, you do have a key configured" needs the file's own answer,
 * not whatever `process.env` happened to already believe.
 *
 * Uses dotenv's real last-wins resolution (unlike `hasAnyExistingKey`, which
 * deliberately checks every occurrence) because this is describing what the
 * bot will actually load at real startup, not deciding whether it's safe to
 * write — those are different questions with different correct answers.
 */
export function readWalletKeyFromFile(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  let content: string;
  try {
    content = readSmallFile(envPath);
  } catch {
    return undefined;
  }
  const value = parseDotenv(content)['OGMARA_WALLET_KEY'];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Generate a wallet key and persist it to `envPath`.
 *
 * Locked around the read-check-write sequence (via the same primitive
 * `lock.ts` uses for the ledger) so two overlapping invocations — a
 * double-clicked `--init`, a stray second terminal — can't both observe "no
 * key yet" and both generate one, silently orphaning whichever loses the
 * race. The lock lives in the same directory as `backupStatePath`, which
 * also means this refuses to run at all while a real bot instance holds that
 * same lock for its ledger — exactly when touching `.env` is riskiest.
 *
 * @param envPath           Path to the `.env` file (created from
 *                           `.env.example` if entirely missing).
 * @param currentValue      The current `OGMARA_WALLET_KEY` value, if any
 *                           (typically `process.env['OGMARA_WALLET_KEY']`).
 *                           Used only as a fast-path skip — see the module
 *                           comment for why it is never trusted alone.
 * @param backupStatePath   Where to record that this key needs a backup
 *                           confirmation (see `walletBackup.ts`). Also
 *                           determines the lock's directory.
 * @throws {LockError} if another instance already holds the data lock.
 */
export async function ensureWalletKey(
  envPath: string,
  currentValue: string | undefined,
  backupStatePath: string,
): Promise<WalletBootstrapResult> {
  // Fast path: the common case on every ordinary invocation once the bot is
  // actually configured. Never the ONLY check for something destructive —
  // see below — but skipping the filesystem entirely here matters, since
  // this fires on every single startup, not just --init.
  if (currentValue !== undefined && currentValue.trim() !== '') {
    return { generated: false };
  }

  const lock = acquireDataLock(backupStatePath);
  try {
    let content: string | undefined;
    if (existsSync(envPath)) {
      content = readSmallFile(envPath);
      // The file is the only authority for whether a key already exists —
      // re-checked here, under the lock, in case another process wrote one
      // between the fast-path check above and this point.
      //
      // Deliberately checks EVERY matching line, not dotenv's single
      // last-wins resolution of the whole file: a real key that got
      // shadowed by a later stray empty line (e.g. an operator pasting a
      // fresh .env.example onto the end of their real .env instead of
      // editing the key in place) would resolve to "empty" under last-wins,
      // even though a real key still sits right there in the file. For a
      // decision this destructive, "a real value exists anywhere in this
      // file" is the only safe question to ask — each candidate line is
      // still parsed with the real dotenv parser (not a hand-rolled one),
      // just one line at a time, so quoting/export/whitespace are handled
      // exactly as they will be when the file is actually loaded.
      if (hasAnyExistingKey(content)) {
        return { generated: false };
      }
    }

    // Same primitive @ogmara/sdk's own WalletSigner.generate() uses
    // internally — @noble/ed25519's CSPRNG-backed key generator. Generated
    // directly (rather than via `WalletSigner.generate()` then trying to
    // extract its key) because the signer's private key field is not part
    // of its public API.
    const privateKey = ed.utils.randomPrivateKey();
    const hex = Buffer.from(privateKey).toString('hex');
    const signer = await WalletSigner.fromHex(hex);

    if (content === undefined) {
      try {
        content = readSmallFile(join(PACKAGE_ROOT, '.env.example'));
      } catch {
        content = 'OGMARA_WALLET_KEY=\n';
      }
    }

    const line = `OGMARA_WALLET_KEY=${hex}`;
    // Global replace, not just the first match: a stale duplicate empty line
    // elsewhere in the file would otherwise survive and win at load time
    // (dotenv is last-wins), silently undoing the write that just happened.
    // A function replacer, not a string, so nothing in `line` (there is
    // nothing today, but this must stay true unconditionally) is ever
    // interpreted as a `$&`/`$1`-style replacement pattern.
    //
    // Whether a line existed to replace is read off the result itself
    // (changed vs. unchanged) rather than a preceding `.test()` call on the
    // same global-flagged regex — `.test()`/`.exec()` mutate `lastIndex` as
    // a side effect, and depending on a *second* call against that mutated
    // state to still behave as if starting fresh is exactly the kind of
    // thing that quietly breaks under a future reordering.
    const replaced = content.replace(ENV_KEY_LINE, () => line);
    content = replaced === content ? `${content.replace(/\n?$/, '\n')}${line}\n` : replaced;

    try {
      // Written to a fresh sibling temp file, then renamed over the target —
      // atomic on the same filesystem, so a crash mid-write can never
      // truncate an existing .env (losing every other secret in it) and
      // never leaves the file briefly at looser permissions than 0600: a
      // freshly-created temp file honours the `mode` option from the start,
      // and POSIX rename carries the SOURCE file's permissions onto the
      // target, replacing whatever the original file's mode was.
      // Note for anyone symlinking .env to a shared location: unlike the
      // previous write-through-symlink behavior, a rename onto a symlink
      // path replaces the symlink itself with a real file, rather than
      // following it. Not a documented or supported setup today, so this
      // trades that edge case for atomicity everywhere else.
      const tmpPath = `${envPath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpPath, content, { mode: 0o600 });
      chmodSync(tmpPath, 0o600); // extra assurance the temp file itself is 0600 regardless of umask quirks
      renameSync(tmpPath, envPath);
    } catch (err) {
      // The key is brand new, unfunded, and has never signed anything —
      // discarding it costs nothing. Printing it instead would cost more:
      // it can persist in a systemd journal, CI logs, or a recorded
      // terminal session far longer than "run --init again" costs the
      // operator. So it is never returned here, in any form.
      return {
        generated: false,
        writeError: {
          message: err instanceof Error ? err.message : String(err),
          path: envPath,
        },
      };
    }

    // Advisory only — must never suppress the caller's view of a
    // successfully generated key. A backup reminder that fails to record
    // itself is a smaller problem than the operator never being told their
    // new wallet address at all.
    try {
      markBackupPending(backupStatePath);
    } catch {
      // Nothing to do: the key is safely on disk either way.
    }

    return { generated: true, address: signer.address };
  } finally {
    lock.release();
  }
}
