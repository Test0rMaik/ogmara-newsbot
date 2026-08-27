import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletSigner } from '@ogmara/sdk';
import { ensureConfigFile, ensureWalletKey } from './bootstrap.js';
import { acquireDataLock, LockError } from './lock.js';
import { isBackupPending } from './walletBackup.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-bootstrap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['OGMARA_WALLET_KEY'];
});

describe('ensureConfigFile', () => {
  it('creates the target from config.example.yaml when missing', () => {
    const target = join(dir, 'config.yaml');
    expect(ensureConfigFile(target)).toBe(true);
    const written = readFileSync(target, 'utf8');
    expect(written).toContain('node:');
    expect(written).toContain('panel:');
  });

  it('never overwrites an existing file', () => {
    const target = join(dir, 'config.yaml');
    writeFileSync(target, 'my custom config\n');
    expect(ensureConfigFile(target)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('my custom config\n');
  });
});

describe('ensureWalletKey', () => {
  const backupPath = () => join(dir, 'wallet-backup.json');

  it('does nothing when the caller-supplied value is already configured', async () => {
    const envPath = join(dir, '.env');
    const result = await ensureWalletKey(envPath, 'a'.repeat(64), backupPath());
    expect(result.generated).toBe(false);
    expect(existsSyncSafe(envPath)).toBe(false);
  });

  it('treats an empty or whitespace-only value as unconfigured', async () => {
    const envPath = join(dir, '.env');
    for (const value of [undefined, '', '   ']) {
      const result = await ensureWalletKey(envPath, value, backupPath());
      expect(result.generated).toBe(true);
      rmSync(envPath, { force: true });
      rmSync(backupPath(), { force: true });
    }
  });

  it('generates a real, usable 64-char hex key', async () => {
    const envPath = join(dir, '.env');
    const result = await ensureWalletKey(envPath, undefined, backupPath());
    expect(result.generated).toBe(true);
    expect(result.address).toMatch(/^klv1/);

    const content = readFileSync(envPath, 'utf8');
    const match = /^OGMARA_WALLET_KEY=([0-9a-f]{64})$/m.exec(content);
    expect(match).not.toBeNull();

    // The key actually round-trips to the SAME address the result reported —
    // not just "looks like hex", but a genuinely usable Ed25519 key.
    const signer = await WalletSigner.fromHex(match![1]!);
    expect(signer.address).toBe(result.address);
  });

  it('creates .env from .env.example when entirely missing', async () => {
    const envPath = join(dir, '.env');
    await ensureWalletKey(envPath, undefined, backupPath());
    const content = readFileSync(envPath, 'utf8');
    // .env.example's other documented keys should survive the merge.
    expect(content).toContain('ANTHROPIC_API_KEY');
  });

  it('replaces an existing empty OGMARA_WALLET_KEY line in place, keeping the rest of the file', async () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'OGMARA_WALLET_KEY=\nANTHROPIC_API_KEY=sk-mine\n');
    const result = await ensureWalletKey(envPath, '', backupPath());
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-mine');
    expect(content).toContain(`OGMARA_WALLET_KEY=${extractHex(content)}`);
    expect(extractHex(content)).toHaveLength(64);
    void result;
  });

  it('appends the line when the .env file has no OGMARA_WALLET_KEY line at all', async () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-mine\n');
    await ensureWalletKey(envPath, undefined, backupPath());
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-mine');
    expect(content).toMatch(/OGMARA_WALLET_KEY=[0-9a-f]{64}/);
  });

  it('marks the backup as pending on successful generation', async () => {
    const envPath = join(dir, '.env');
    await ensureWalletKey(envPath, undefined, backupPath());
    expect(isBackupPending(backupPath())).toBe(true);
  });

  it('never touches the file when the caller-supplied value already matches the file — the aligned case', async () => {
    const envPath = join(dir, '.env');
    const original =
      'OGMARA_WALLET_KEY=deadbeef00000000000000000000000000000000000000000000000000000000\nSOMETHING=else\n';
    writeFileSync(envPath, original);
    const before = readFileSync(envPath, 'utf8');
    const result = await ensureWalletKey(envPath, 'somekeyvalue', backupPath());
    expect(result.generated).toBe(false);
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(isBackupPending(backupPath())).toBe(false);
  });

  describe('the file is the sole authority, never the caller-supplied value alone', () => {
    // These are the two triggers from the critical finding: a caller-supplied
    // `currentValue` of "" must never, by itself, be enough to justify
    // touching a file that actually still holds a real key.

    it('refuses when the caller reports empty but the FILE holds a real key (present-but-empty env var)', async () => {
      // Reproduces: `export OGMARA_WALLET_KEY=` in a parent shell, or a
      // templated systemd Environment= that resolved empty. dotenv's
      // populate() treats a present-but-empty var as already "set" and never
      // reads the file for it — so `currentValue` here is legitimately `''`
      // even though the file underneath is fine.
      const envPath = join(dir, '.env');
      const realKey = 'a'.repeat(64);
      writeFileSync(envPath, `OGMARA_WALLET_KEY=${realKey}\nANTHROPIC_API_KEY=sk-mine\n`);
      const before = readFileSync(envPath, 'utf8');

      const result = await ensureWalletKey(envPath, '', backupPath());

      expect(result.generated).toBe(false);
      expect(readFileSync(envPath, 'utf8')).toBe(before);
      expect(isBackupPending(backupPath())).toBe(false);
    });

    it('refuses when a duplicate empty line would otherwise win under dotenv\'s last-wins rule', async () => {
      // Reproduces: pasting a fresh .env.example (empty placeholder line)
      // onto the end of a real .env instead of editing the key in place.
      // dotenv reads this file's OGMARA_WALLET_KEY as '' (last-wins) even
      // though a real key sits earlier in the file.
      const envPath = join(dir, '.env');
      const realKey = 'b'.repeat(64);
      writeFileSync(envPath, `OGMARA_WALLET_KEY=${realKey}\nANTHROPIC_API_KEY=sk-mine\n\nOGMARA_WALLET_KEY=\n`);
      const before = readFileSync(envPath, 'utf8');

      // currentValue passed in mirrors what dotenv would actually resolve
      // this file to right now: ''.
      const result = await ensureWalletKey(envPath, '', backupPath());

      expect(result.generated).toBe(false);
      expect(readFileSync(envPath, 'utf8')).toBe(before);
    });

    it('recognises an existing key behind "export " and leading whitespace, exactly as dotenv does', async () => {
      const envPath = join(dir, '.env');
      const realKey = 'c'.repeat(64);
      writeFileSync(envPath, `  export OGMARA_WALLET_KEY=${realKey}\n`);
      const before = readFileSync(envPath, 'utf8');

      const result = await ensureWalletKey(envPath, '', backupPath());

      expect(result.generated).toBe(false);
      expect(readFileSync(envPath, 'utf8')).toBe(before);
    });

    it('still generates when the file genuinely has no real key anywhere, updating every empty occurrence consistently', async () => {
      const envPath = join(dir, '.env');
      writeFileSync(envPath, 'OGMARA_WALLET_KEY=\nSOMETHING=else\nOGMARA_WALLET_KEY=\n');

      const result = await ensureWalletKey(envPath, '', backupPath());

      expect(result.generated).toBe(true);
      const content = readFileSync(envPath, 'utf8');
      // Both empty lines are updated to the SAME new value — a global
      // replace doesn't merge lines, but it does mean there is no longer any
      // disagreement about what the real value is, whichever line dotenv's
      // last-wins rule picks.
      const matches = content.match(/^OGMARA_WALLET_KEY=.*$/gm) ?? [];
      expect(matches).toHaveLength(2);
      expect(new Set(matches).size).toBe(1);
      expect(matches[0]).toMatch(/^OGMARA_WALLET_KEY=[0-9a-f]{64}$/);
      expect(content).toContain('SOMETHING=else');
    });
  });

  describe('locking against overlapping invocations', () => {
    it('refuses to proceed while another process holds the data lock', async () => {
      const envPath = join(dir, '.env');
      const path = backupPath();
      const externalLock = acquireDataLock(path);
      try {
        await expect(ensureWalletKey(envPath, undefined, path)).rejects.toThrow(LockError);
        expect(existsSyncSafe(envPath)).toBe(false);
      } finally {
        externalLock.release();
      }
    });

    it('releases the lock after a successful run, so a later call can proceed', async () => {
      const envPath = join(dir, '.env');
      const path = backupPath();
      await ensureWalletKey(envPath, undefined, path);
      rmSync(envPath, { force: true });
      rmSync(path, { force: true });
      // If the first call's lock leaked, this would throw LockError.
      const second = await ensureWalletKey(envPath, undefined, path);
      expect(second.generated).toBe(true);
    });

    it('releases the lock even when generation is refused (nothing to do)', async () => {
      const envPath = join(dir, '.env');
      const path = backupPath();
      writeFileSync(envPath, `OGMARA_WALLET_KEY=${'d'.repeat(64)}\n`);
      await ensureWalletKey(envPath, '', path); // refused — file already has a key
      // Lock must not still be held; acquiring it directly must succeed.
      const lock = acquireDataLock(path);
      lock.release();
    });
  });

  it('reports a write failure without exposing the raw key, and generates nothing', async () => {
    // Point envPath at a path whose parent directory doesn't exist, so the
    // write fails deterministically without relying on filesystem permission
    // quirks that could behave differently across environments (e.g. root).
    const envPath = join(dir, 'nonexistent-parent', '.env');
    const result = await ensureWalletKey(envPath, undefined, backupPath());
    expect(result.generated).toBe(false);
    expect(result.address).toBeUndefined();
    expect(result.writeError).toBeDefined();
    expect(result.writeError!.path).toBe(envPath);
    // No field anywhere on the result carries key material.
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('refuses a .env file that is implausibly large rather than reading it in full', async () => {
    const envPath = join(dir, '.env');
    // 2 MB of filler — comfortably over the 1 MB cap, without actually being
    // large enough to make a slow test.
    writeFileSync(envPath, 'X'.repeat(2 * 1024 * 1024));
    await expect(ensureWalletKey(envPath, undefined, backupPath())).rejects.toThrow(/too large/);
  });

  it('leaves no temp file behind after a successful write', async () => {
    const envPath = join(dir, '.env');
    await ensureWalletKey(envPath, undefined, backupPath());
    const leftovers = statSyncListDir(dir).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

function extractHex(content: string): string {
  const match = /OGMARA_WALLET_KEY=([0-9a-f]{64})/.exec(content);
  if (match === null) throw new Error('no key found in content');
  return match[1]!;
}

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function statSyncListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
