/**
 * Single-instance lock on the data directory.
 *
 * Two bot processes sharing a data directory corrupt each other's ledger: each
 * loads it once at startup and writes its own in-memory copy on every record,
 * so the second process silently erases the first's entries and then reposts
 * those items — a duplicate post on a feed that cannot be unpublished. The
 * README documents both a long-running daemon (`npm run dev`) and one-shot
 * `--once` runs for cron, so an operator running both is a realistic mistake
 * rather than a hypothetical one. (Audit 2026-08-26, M19.)
 */

import { openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Raised when another instance already holds the lock. */
export class LockError extends Error {
  override readonly name = 'LockError';
}

/** A held lock. Release it when the process is done. */
export interface DataLock {
  release(): void;
}

/**
 * Acquire an exclusive lock beside the ledger.
 *
 * Uses `wx` (create-exclusive), which is atomic. A stale lock from a crashed
 * process is detected by checking whether that pid is still alive rather than
 * by age, so a legitimately long run is never evicted while a genuinely dead
 * one does not block startup forever.
 */
export function acquireDataLock(ledgerPath: string): DataLock {
  const dir = dirname(ledgerPath);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, '.newsbot.lock');

  const tryCreate = (): number | null => {
    try {
      return openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };

  let fd = tryCreate();

  if (fd === null) {
    const holder = readHolderPid(lockPath);
    if (holder !== null && isAlive(holder)) {
      throw new LockError(
        `Another ogmara-newsbot instance (pid ${holder}) is using "${dir}".\n` +
          'Two instances sharing a data directory overwrite each other\'s ledger and ' +
          'republish items. Stop the other one, or give this instance its own ' +
          'storage.ledgerPath and queue.path.',
      );
    }
    // Stale lock from a process that is gone — reclaim it.
    try {
      unlinkSync(lockPath);
    } catch {
      /* raced with another reclaimer; the retry below will report it */
    }
    fd = tryCreate();
    if (fd === null) {
      throw new LockError(`Could not acquire the lock at "${lockPath}" — another instance raced us.`);
    }
  }

  writeSync(fd, String(process.pid));
  closeSync(fd);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };

  // Best-effort cleanup. `exit` cannot do async work, which is why release is
  // synchronous.
  process.once('exit', release);
  return { release };
}

function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether a pid is still running. Signal 0 checks existence without signalling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
