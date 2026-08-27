/**
 * Tracks whether the operator has confirmed backing up a BOT-GENERATED
 * wallet key.
 *
 * Only ever created at the moment `bootstrap.ts` generates a fresh key — a
 * key the operator supplied themselves is presumably already backed up
 * wherever they keep their own keys, so no file here means no reminder, not
 * "backed up by default": the file's mere existence is what turns the
 * reminder on in the first place.
 *
 * This exists because a one-time terminal message at generation time is not
 * enough — it can scroll past, or get lost in systemd/Docker logs nobody is
 * watching at that exact moment. Persisting the "pending" state means the
 * control panel can keep showing the reminder on every visit until the
 * operator explicitly dismisses it, which survives exactly the failure mode
 * that matters: walking away before backing anything up.
 *
 * The path is a fixed, cwd-relative constant rather than derived from
 * `storage.ledgerPath` (which IS operator-configurable) deliberately: a
 * wallet key can be generated before `config.yaml` even exists or parses, so
 * there is no configured ledger path available yet at that point. A fixed
 * location means the generation-time write and every later panel check agree
 * on where to look, regardless of what the operator does with `storage.*`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface WalletBackupState {
  backupAcknowledged: boolean;
}

/** Fixed, cwd-relative path to the state file — see the module comment for why. */
export const WALLET_BACKUP_PATH = 'data/wallet-backup.json';

/** Record that a freshly generated key needs the operator's backup confirmation. */
export function markBackupPending(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const state: WalletBackupState = { backupAcknowledged: false };
  writeFileSync(path, JSON.stringify(state));
}

/**
 * Whether the operator still needs to confirm they've backed up a generated
 * key. A corrupt state file fails toward still-pending (shows the reminder
 * again) rather than silently dropping it — an extra dismissal is a minor
 * annoyance; a real key silently going unbacked-up is not.
 */
export function isBackupPending(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as WalletBackupState;
    return state.backupAcknowledged !== true;
  } catch {
    return true;
  }
}

/** Record that the operator has confirmed the backup. No-op if nothing was pending. */
export function acknowledgeBackup(path: string): void {
  if (!existsSync(path)) return;
  const state: WalletBackupState = { backupAcknowledged: true };
  writeFileSync(path, JSON.stringify(state));
}
