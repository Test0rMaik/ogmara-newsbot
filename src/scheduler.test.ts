import { describe, expect, it } from 'vitest';
import { isValidCron, runsPerHour } from './scheduler.js';

describe('isValidCron', () => {
  it('accepts a well-formed expression', () => {
    expect(isValidCron('*/30 * * * *')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidCron('not a cron expression')).toBe(false);
  });
});

describe('runsPerHour', () => {
  // A fixed reference point, so "the next hour" is deterministic regardless
  // of when the test suite happens to run. Explicit UTC throughout: croner
  // otherwise interprets hour-specific expressions (e.g. "0 6 * * *") in the
  // SYSTEM's local timezone, which would make these tests pass or fail
  // depending on what machine runs them — not something a test should
  // depend on.
  const UTC = { timezone: 'UTC' };
  const NOON = new Date('2026-01-01T12:00:00Z');

  it('counts a twice-hourly schedule as 2 — the exact case this exists to catch', () => {
    expect(runsPerHour('*/30 * * * *', NOON, UTC)).toBe(2);
  });

  it('counts an hourly schedule as 1', () => {
    expect(runsPerHour('0 * * * *', NOON, UTC)).toBe(1);
  });

  it('counts a schedule firing every 10 minutes as 6', () => {
    expect(runsPerHour('*/10 * * * *', NOON, UTC)).toBe(6);
  });

  it('counts a once-daily schedule as 0 for a random hour that misses it', () => {
    // Fires at 06:00; from noon, the next occurrence is >24h away.
    expect(runsPerHour('0 6 * * *', NOON, UTC)).toBe(0);
  });

  it('counts a once-daily schedule as 1 for the hour it actually fires in', () => {
    const justBefore = new Date('2026-01-01T05:59:00Z');
    expect(runsPerHour('0 6 * * *', justBefore, UTC)).toBe(1);
  });

  it('handles a schedule with multiple daily times landing in the same hour', () => {
    // Two fires inside the same 60-minute window.
    const justBefore = new Date('2026-01-01T05:59:00Z');
    expect(runsPerHour('0,30 6 * * *', justBefore, UTC)).toBe(2);
  });

  it('defaults to the system timezone when none is given, same as schedule()', () => {
    // Not asserting a specific count (that would be as machine-dependent as
    // the bug this test structure avoids elsewhere) — just that omitting the
    // option doesn't throw and returns a sane, non-negative result.
    expect(runsPerHour('0 6 * * *', NOON)).toBeGreaterThanOrEqual(0);
  });

  it('counts a seconds-precision schedule correctly, past the old 60/hour assumption', () => {
    // croner accepts an optional 6th SECONDS field, and isValidCron accepts
    // it too, so 60/hour is not actually the ceiling — an earlier version of
    // this function sampled only 100 future runs and silently under-counted
    // anything denser than that. "Every 10 seconds" is a real, valid,
    // accepted-by-isValidCron schedule that exceeds 100/hour.
    expect(runsPerHour('*/10 * * * * *', NOON, UTC)).toBe(360);
  });

  it('counts an every-second schedule as the true 3600, not a sampling artifact', () => {
    expect(runsPerHour('* * * * * *', NOON, UTC)).toBe(3600);
  });
});
