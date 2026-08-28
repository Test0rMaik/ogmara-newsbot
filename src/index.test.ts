import { describe, expect, it } from 'vitest';
import { dailyBudgetWarning } from './index.js';

/**
 * `index.ts` is mostly CLI orchestration and isn't otherwise unit-tested,
 * but `dailyBudgetWarning` is pure logic extracted specifically so this real
 * user-reported bug (config-time validation always assumed the unverified
 * tier, hard-failing startup for a registered wallet with a legitimately
 * higher cadence) has a direct test rather than relying on a full `run()`
 * integration test against a live chain.
 */
describe('dailyBudgetWarning', () => {
  it('warns when the cadence exceeds 80% of the unverified daily ceiling', () => {
    // 2/hour x 24h = 48, > 50 x 0.8 = 40.
    const warning = dailyBudgetWarning(2, 50, false);
    expect(warning).toContain('unregistered tier');
    expect(warning).toContain('--register');
  });

  it('does NOT warn for the same cadence once the wallet is registered', () => {
    // Same 2/hour, but against the registered ceiling (300): 48 <= 240.
    // This is the exact bug: the old check always used the unverified
    // ceiling and would have failed here even though this is safe.
    expect(dailyBudgetWarning(2, 300, true)).toBeUndefined();
  });

  it('still warns for a registered wallet whose cadence exceeds ITS ceiling', () => {
    // 11/hour x 24h = 264, > 300 x 0.8 = 240.
    const warning = dailyBudgetWarning(11, 300, true);
    expect(warning).toContain('registered tier');
    expect(warning).not.toContain('--register'); // already registered, nothing to suggest
  });

  it('returns undefined right at the boundary (exactly 80%)', () => {
    // 1/hour x 24h = 24, exactly 80% of a 30/day ceiling.
    expect(dailyBudgetWarning(1, 30, false)).toBeUndefined();
  });
});
