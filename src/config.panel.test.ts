import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletSigner } from '@ogmara/sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

let dir: string;
let wallet: string;

beforeAll(async () => {
  // A real bech32 address, so checksum validation is exercised for real.
  wallet = (await WalletSigner.generate()).address;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a minimal valid config with the given `panel:` block appended. */
function load(panelYaml: string) {
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `node:\n  url: http://localhost:8080\n${panelYaml}`);
  return loadConfig(path);
}

describe('panel config defaults', () => {
  it('is off, loopback-bound and unauthorised by default', () => {
    // Nobody gets a network-exposed control surface by upgrading.
    const { panel } = load('');
    expect(panel.enabled).toBe(false);
    expect(panel.bind).toBe('127.0.0.1');
    expect(panel.adminWallets).toEqual([]);
    expect(panel.trustedProxies).toEqual([]);
    expect(panel.sessionTtlHours).toBe(24);
  });
});

describe('panel adminWallets validation', () => {
  it('accepts a genuine klv1 address', () => {
    expect(load(`panel:\n  enabled: true\n  adminWallets: ["${wallet}"]`).panel.adminWallets)
      .toEqual([wallet]);
  });

  it('rejects a single mistyped character via the bech32 checksum', () => {
    // A charset-only check would pass this. The checksum is what catches it,
    // and catching it here beats an operator locked out of their own panel.
    const typo = `${wallet.slice(0, -1)}${wallet.at(-1) === 'q' ? 'p' : 'q'}`;
    expect(() => load(`panel:\n  enabled: true\n  adminWallets: ["${typo}"]`)).toThrow(
      /invalid checksum/,
    );
  });

  it('rejects an uppercased address', () => {
    expect(() =>
      load(`panel:\n  enabled: true\n  adminWallets: ["${wallet.toUpperCase()}"]`),
    ).toThrow(ConfigError);
  });

  it('rejects a device address', () => {
    // Login is a wallet action; an ogd1 device key in the allowlist is a
    // misunderstanding worth surfacing loudly.
    expect(() =>
      load(`panel:\n  enabled: true\n  adminWallets: ["ogd1${wallet.slice(4)}"]`),
    ).toThrow(/klv1/);
  });

  it('names the offending entry when one of several is bad', () => {
    let message = '';
    try {
      load(`panel:\n  enabled: true\n  adminWallets: ["${wallet}", "klv1nonsense"]`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('klv1nonsense');
    expect(message).not.toContain(`"${wallet}" is`);
  });
});

describe('panel bind safety', () => {
  it('rejects a non-loopback bind with no authorised wallets', () => {
    // This combination is unusable, not merely useless: remote logins are
    // refused and the loopback bypass never applies, so the operator is locked
    // out of a panel they believe they published.
    let message = '';
    try {
      load('panel:\n  enabled: true\n  bind: 0.0.0.0');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/no one could log in/);
  });

  it('allows a non-loopback bind once a wallet and an allowed host are configured', () => {
    const cfg = load(
      `panel:\n  enabled: true\n  bind: 0.0.0.0\n  adminWallets: ["${wallet}"]\n  allowedHosts: ["bot.example.internal"]`,
    );
    expect(cfg.panel.bind).toBe('0.0.0.0');
  });

  it('rejects a non-loopback bind with a wallet but no allowedHosts', () => {
    // Otherwise the operator's own browser gets 400'd by the Host check.
    let message = '';
    try {
      load(`panel:\n  enabled: true\n  bind: 0.0.0.0\n  adminWallets: ["${wallet}"]`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/allowedHosts/);
  });

  it('rejects a loopback bind with trustedProxies but no allowedHosts', () => {
    // The documented same-host reverse-proxy shape: bind stays 127.0.0.1, but
    // nginx serves the panel under its own public hostname and forwards that
    // Host header through — without allowedHosts, the operator's own browser
    // would be rejected exactly like an attacker's forged Host would be.
    let message = '';
    try {
      load('panel:\n  enabled: true\n  trustedProxies: ["172.17.0.0/16"]');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/allowedHosts/);
    expect(message).toMatch(/trustedProxies/);
  });

  it('allows a loopback bind with trustedProxies once allowedHosts is also set', () => {
    const cfg = load(
      'panel:\n  enabled: true\n  trustedProxies: ["172.17.0.0/16"]\n  allowedHosts: ["bot.example.com"]',
    );
    expect(cfg.panel.bind).toBe('127.0.0.1');
  });

  it('treats "localhost" as a loopback bind, not just the literal IPs', () => {
    expect(load('panel:\n  enabled: true\n  bind: localhost').panel.bind).toBe('localhost');
  });

  it('rejects requireLogin: true with no admin wallets — nobody could ever log in', () => {
    let message = '';
    try {
      load('panel:\n  enabled: true\n  requireLogin: true');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/not even from localhost/);
  });

  it('rejects a malformed trustedProxies entry', () => {
    expect(() => load('panel:\n  trustedProxies: ["not-an-ip"]')).toThrow(ConfigError);
    expect(() => load('panel:\n  trustedProxies: ["10.0.0.0/999"]')).toThrow(ConfigError);
  });

  it('allows a loopback bind with no wallets — the localhost-only case', () => {
    expect(load('panel:\n  enabled: true').panel.enabled).toBe(true);
  });

  it('does not complain while the panel is disabled', () => {
    expect(load('panel:\n  enabled: false\n  bind: 0.0.0.0').panel.enabled).toBe(false);
  });
});

describe('panel misc validation', () => {
  it('rejects an out-of-range port', () => {
    expect(() => load('panel:\n  port: 0')).toThrow(ConfigError);
    expect(() => load('panel:\n  port: 70000')).toThrow(ConfigError);
  });

  it('rejects an absurd session lifetime', () => {
    expect(() => load('panel:\n  sessionTtlHours: 0')).toThrow(ConfigError);
    expect(() => load('panel:\n  sessionTtlHours: 9000')).toThrow(ConfigError);
  });
});
