import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/**
 * Regression coverage for a real user-reported bug: `posting.maxPostsPerHour`
 * used to be validated at config-load time against `nodeDailyUnverified`
 * ALWAYS, regardless of the wallet's actual on-chain registration status.
 * Config validation is synchronous with no network access, so it has no way
 * to know a wallet is registered — the check was really "would this be safe
 * for a wallet that never registers," which made it a hard startup failure
 * for anyone who registered and then raised their cadence to match. The
 * real per-tier check now happens in index.ts's `dailyBudgetWarning`
 * (index.test.ts) once registration status is actually known, as a
 * non-fatal warning rather than a ConfigError.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function load(postingYaml: string) {
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `node:\n  url: http://localhost:8080\n${postingYaml}`);
  return loadConfig(path);
}

describe('posting.maxPostsPerHour', () => {
  it('no longer fails config load for a cadence that only exceeds the UNVERIFIED tier', () => {
    // 2 posts/hour x 24h = 48, which is > 50 (default nodeDailyUnverified) x
    // 0.8 = 40 — this used to be a hard ConfigError even for a registered
    // wallet, which caps out at 300/day.
    const config = load('posting:\n  dryRun: false\n  maxPostsPerHour: 2');
    expect(config.posting.maxPostsPerHour).toBe(2);
  });

  it('still accepts the default of 1', () => {
    expect(load('').posting.maxPostsPerHour).toBe(1);
  });

  it('still rejects a genuinely out-of-range value via its own bound', () => {
    expect(() => load('posting:\n  maxPostsPerHour: 1000')).toThrow(/invalid configuration/);
  });

  it('accepts a cadence appropriate for a REGISTERED wallet (up to 300/day)', () => {
    // 10/hour x 24h = 240, comfortably under the registered daily ceiling —
    // this is exactly the case a registered operator should be able to
    // configure without a startup failure.
    const config = load('posting:\n  dryRun: false\n  maxPostsPerHour: 10');
    expect(config.posting.maxPostsPerHour).toBe(10);
  });
});
