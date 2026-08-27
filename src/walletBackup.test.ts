import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeBackup, isBackupPending, markBackupPending } from './walletBackup.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-backup-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isBackupPending', () => {
  it('is false when no state file exists — a manually supplied key needs no reminder', () => {
    expect(isBackupPending(join(dir, 'wallet-backup.json'))).toBe(false);
  });

  it('is true right after marking a key pending', () => {
    const path = join(dir, 'wallet-backup.json');
    markBackupPending(path);
    expect(isBackupPending(path)).toBe(true);
  });

  it('is false once acknowledged', () => {
    const path = join(dir, 'wallet-backup.json');
    markBackupPending(path);
    acknowledgeBackup(path);
    expect(isBackupPending(path)).toBe(false);
  });

  it('fails toward still-pending on a corrupt state file', () => {
    // An extra dismissal is a minor annoyance; a real key silently going
    // unbacked-up because of a parse error is not an acceptable trade.
    const path = join(dir, 'wallet-backup.json');
    writeFileSync(path, 'not json');
    expect(isBackupPending(path)).toBe(true);
  });
});

describe('acknowledgeBackup', () => {
  it('is a no-op when nothing was pending', () => {
    const path = join(dir, 'wallet-backup.json');
    expect(() => acknowledgeBackup(path)).not.toThrow();
    expect(isBackupPending(path)).toBe(false);
  });

  it('creates the parent directory if needed', () => {
    const path = join(dir, 'nested', 'deep', 'wallet-backup.json');
    expect(() => markBackupPending(path)).not.toThrow();
    expect(isBackupPending(path)).toBe(true);
  });
});
