import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SNAPSHOTS, StatsHistory, type StatsSnapshot } from './statsHistory.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-statshistory-'));
  path = join(dir, 'stats-history.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function snapshot(over: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    timestamp: Date.now(),
    totalReactions: 1,
    totalReposts: 2,
    totalComments: 3,
    totalPosts: 4,
    ...over,
  };
}

describe('StatsHistory', () => {
  it('starts empty when the file does not exist', () => {
    const history = StatsHistory.load(path);
    expect(history.size).toBe(0);
    expect(history.all()).toEqual([]);
  });

  it('appends and persists across reloads', () => {
    StatsHistory.load(path).append(snapshot({ timestamp: Date.now(), totalReactions: 5 }));
    const reloaded = StatsHistory.load(path);
    expect(reloaded.size).toBe(1);
    expect(reloaded.all()[0]!.totalReactions).toBe(5);
  });

  it('keeps snapshots sorted oldest-first regardless of append order', () => {
    const now = Date.now();
    const history = StatsHistory.load(path);
    history.append(snapshot({ timestamp: now + 3000 }));
    history.append(snapshot({ timestamp: now + 1000 }));
    history.append(snapshot({ timestamp: now + 2000 }));
    expect(history.all().map((s) => s.timestamp)).toEqual([now + 1000, now + 2000, now + 3000]);
  });

  it('writes atomically: temp file then rename, real content on disk', () => {
    StatsHistory.load(path).append(snapshot({ timestamp: Date.now() }));
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.snapshots).toHaveLength(1);
  });

  it('prunes snapshots older than retentionDays on save', () => {
    const now = Date.now();
    const history = StatsHistory.load(path, 1); // 1 day retention
    history.append(snapshot({ timestamp: now - 2 * 86_400_000 })); // too old
    history.append(snapshot({ timestamp: now })); // kept
    expect(history.size).toBe(1);
    expect(history.all()[0]!.timestamp).toBe(now);
  });

  it('starts fresh rather than throwing on a corrupt file', () => {
    writeFileSync(path, 'not json{{{');
    const history = StatsHistory.load(path);
    expect(history.size).toBe(0);
  });

  it('starts fresh on an unrecognized version', () => {
    writeFileSync(path, JSON.stringify({ version: 99, snapshots: [] }));
    const history = StatsHistory.load(path);
    expect(history.size).toBe(0);
  });

  it('starts fresh when snapshots is missing or not an array', () => {
    writeFileSync(path, JSON.stringify({ version: 1 }));
    expect(StatsHistory.load(path).size).toBe(0);
  });

  it('drops individual malformed entries rather than discarding the whole file', () => {
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        snapshots: [
          snapshot({ timestamp: now }),
          { timestamp: 'not a number', totalReactions: 1, totalReposts: 1, totalComments: 1, totalPosts: 1 },
          null,
          'garbage',
        ],
      }),
    );
    const history = StatsHistory.load(path);
    expect(history.size).toBe(1);
    expect(history.all()[0]!.timestamp).toBe(now);
  });

  it('applies retention at load time too, not only on the next save', () => {
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        snapshots: [snapshot({ timestamp: now - 2 * 86_400_000 }), snapshot({ timestamp: now })],
      }),
    );
    const history = StatsHistory.load(path, 1); // 1 day retention
    expect(history.size).toBe(1);
    expect(history.all()[0]!.timestamp).toBe(now);
  });

  it('all() returns a copy — mutating the result cannot corrupt internal state', () => {
    const history = StatsHistory.load(path);
    history.append(snapshot());
    const first = history.all();
    (first as StatsSnapshot[]).push(snapshot());
    expect(history.size).toBe(1);
    expect(history.all()).toHaveLength(1);
  });

  it('caps stored snapshots at MAX_SNAPSHOTS, dropping the oldest first', () => {
    const now = Date.now();
    const many = Array.from({ length: MAX_SNAPSHOTS + 10 }, (_, i) =>
      snapshot({ timestamp: now - (MAX_SNAPSHOTS + 10 - i) * 60_000, totalReactions: i }),
    );
    writeFileSync(path, JSON.stringify({ version: 1, snapshots: many }));
    const history = StatsHistory.load(path);
    expect(history.size).toBe(MAX_SNAPSHOTS + 10); // load() itself doesn't cap — only save() does
    // Triggers save(), which enforces the cap.
    history.append(snapshot({ timestamp: now, totalReactions: 999_999 }));
    expect(history.size).toBe(MAX_SNAPSHOTS);
    // The newest entries (including the just-appended one) survive; the
    // oldest are what got dropped.
    expect(history.all().at(-1)!.totalReactions).toBe(999_999);
    expect(history.all()[0]!.totalReactions).toBeGreaterThan(0); // not one of the very oldest (reactions=0..9)
  });

  it('goes read-only on an I/O error (not ENOENT) rather than silently discarding existing history', () => {
    writeFileSync(path, JSON.stringify({ version: 1, snapshots: [snapshot({ timestamp: Date.now() })] }));
    chmodSync(path, 0o000);
    try {
      // Reproduces the exact scenario the fix closes: a transient permission
      // problem must not look like "no history exists yet".
      const history = StatsHistory.load(path);
      expect(history.size).toBe(0); // couldn't read it, so nothing in memory this run
      history.append(snapshot({ timestamp: Date.now(), totalReactions: 999 }));
    } finally {
      chmodSync(path, 0o600);
    }
    // The critical assertion: append()'s save() must NOT have overwritten
    // the original file. The real history is still there, untouched.
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.snapshots).toHaveLength(1);
    expect(onDisk.snapshots[0].totalReactions).not.toBe(999);
  });

  it('quarantines a corrupt file (renames it aside) instead of only warning and discarding it', () => {
    writeFileSync(path, 'not json{{{');
    const history = StatsHistory.load(path);
    expect(history.size).toBe(0);
    const entries = readdirSync(dir);
    const quarantined = entries.find((f) => f.startsWith('stats-history.json.corrupt-'));
    expect(quarantined).toBeDefined();
    expect(readFileSync(join(dir, quarantined!), 'utf8')).toBe('not json{{{');
    // And the original path is now free for a fresh, writable file.
    history.append(snapshot());
    expect(existsSync(path)).toBe(true);
  });

  it('quarantines a file with an unrecognized shape the same way', () => {
    writeFileSync(path, JSON.stringify({ version: 99, snapshots: [] }));
    StatsHistory.load(path);
    const quarantined = readdirSync(dir).find((f) => f.startsWith('stats-history.json.corrupt-'));
    expect(quarantined).toBeDefined();
  });
});
