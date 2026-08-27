/**
 * Local history of periodic engagement snapshots, for the dashboard's
 * reactions/reposts/comments chart.
 *
 * The node has no "history" endpoint of its own — `getUserPosts` only ever
 * reports the *current* total for each post, not how it changed over time.
 * A real growth-over-time chart therefore has to be built by the bot itself:
 * periodically aggregating the current totals (see `stats.ts`) and appending
 * one point to a local log. This file only ever grows by `append()`ing a
 * point taken *now* — there is no way to backfill history that predates
 * turning this on.
 *
 * Modeled on `ledger.ts`'s atomic-write pattern (temp file + rename), but
 * deliberately NOT on its hard-fail-on-corruption behavior: a corrupt ledger
 * risks reposting the entire backlog if silently reset, which is a real
 * publishing mistake, while a corrupt stats history risks nothing but an
 * empty chart. That reasoning holds for genuine *corruption* (the file
 * doesn't parse, or doesn't look like this format) — it does NOT hold for a
 * plain I/O error (`EACCES` after a permissions change, `EMFILE` under fd
 * pressure, `EIO`, an NFS hiccup, a backup tool holding a lock). An I/O
 * error means "we don't know what's in the file", not "it's corrupt", and
 * treating the two the same way used to mean: `load()` silently starts
 * empty, the very next `append()` calls `save()`, and that overwrites
 * however much real history (up to `retentionDays`, 730 by default) was
 * sitting there — permanently, with no backup and within seconds of boot,
 * since `index.ts` fires a snapshot immediately on startup. Reproduced:
 * 500 real snapshots on disk, `chmod 000`, `load()`, restore permissions,
 * one `append()` → 1 snapshot survives. (Code audit, 0.11.0.)
 *
 * The fix keeps the "never crash the bot over this" design goal while
 * closing that hole: an I/O error puts the instance in **read-only** mode
 * (`save()` becomes a no-op — the chart is simply empty for this run, and
 * the existing file on disk is left untouched for a clean restart to
 * recover), while genuine corruption renames the bad file aside
 * (`.corrupt-<timestamp>`, so an operator curious what happened can actually
 * look at it — the module's own "operator can't inspect it" reasoning only
 * holds if nothing then immediately overwrites the evidence) before
 * starting fresh in normal, writable mode.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One point on the engagement-history chart. */
export interface StatsSnapshot {
  /** Unix milliseconds, when this snapshot was taken. */
  timestamp: number;
  totalReactions: number;
  totalReposts: number;
  totalComments: number;
  /** The node's own lifetime post count as of this snapshot. */
  totalPosts: number;
}

interface StatsHistoryFile {
  version: 1;
  snapshots: StatsSnapshot[];
}

/** Default retention. Older snapshots are pruned on save. */
export const DEFAULT_STATS_RETENTION_DAYS = 730;

/**
 * Hard cap on snapshot count, independent of `retentionDays`. `stats.schedule`
 * is an operator-set cron with no enforced floor, so a short interval
 * combined with a long retention window could otherwise grow this file
 * without bound — a full `JSON.stringify` + file rewrite on every single
 * `append()` — and the panel serves the whole array in one response with no
 * pagination. Oldest snapshots are dropped past this, same as retention,
 * just on a count basis rather than an age basis. (Code audit, 0.11.0.)
 */
export const MAX_SNAPSHOTS = 5000;

/** Tracks periodic engagement snapshots for the dashboard chart. */
export class StatsHistory {
  readonly #path: string;
  readonly #retentionMs: number;
  #snapshots: StatsSnapshot[];
  /** True when the on-disk file couldn't be read for an unknown reason — see the module comment. */
  readonly #readOnly: boolean;

  private constructor(
    path: string,
    snapshots: StatsSnapshot[],
    retentionDays: number,
    readOnly: boolean = false,
  ) {
    this.#path = path;
    this.#snapshots = snapshots;
    this.#retentionMs = retentionDays * 86_400_000;
    this.#readOnly = readOnly;
  }

  /**
   * Load a stats history, creating an empty one if the file does not exist.
   * See the module comment for how an I/O error (read-only mode) is handled
   * differently from genuine corruption (rename aside, start fresh).
   */
  static load(path: string, retentionDays: number = DEFAULT_STATS_RETENTION_DAYS): StatsHistory {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new StatsHistory(path, [], retentionDays);
      }
      console.warn(
        `  warning: could not read stats history at "${path}" (${(err as Error).message}). ` +
          'The chart will be empty this run, but the existing file is left untouched — ' +
          'a clean restart will recover it.',
      );
      return new StatsHistory(path, [], retentionDays, /* readOnly */ true);
    }

    let parsed: StatsHistoryFile;
    try {
      parsed = JSON.parse(raw) as StatsHistoryFile;
    } catch {
      quarantine(path);
      return new StatsHistory(path, [], retentionDays);
    }

    if (parsed.version !== 1 || !Array.isArray(parsed.snapshots)) {
      quarantine(path);
      return new StatsHistory(path, [], retentionDays);
    }

    // Defensively filter rather than trust the file wholesale — it's still
    // local state, but a hand-edit or a future format change should degrade
    // to "drop the bad point" rather than crash the chart renderer.
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const clean = parsed.snapshots.filter(
      (s): s is StatsSnapshot =>
        s !== null &&
        typeof s === 'object' &&
        typeof s.timestamp === 'number' &&
        Number.isFinite(s.timestamp) &&
        s.timestamp >= cutoff &&
        typeof s.totalReactions === 'number' &&
        typeof s.totalReposts === 'number' &&
        typeof s.totalComments === 'number' &&
        typeof s.totalPosts === 'number',
    );
    return new StatsHistory(path, clean, retentionDays);
  }

  /** All snapshots currently held, oldest first. A copy — callers cannot mutate internal state through it. */
  all(): readonly StatsSnapshot[] {
    return [...this.#snapshots];
  }

  /** Number of snapshots currently held. */
  get size(): number {
    return this.#snapshots.length;
  }

  /** Record one snapshot and persist immediately (unless in read-only mode — see the module comment). */
  append(snapshot: StatsSnapshot): void {
    this.#snapshots.push(snapshot);
    this.#snapshots.sort((a, b) => a.timestamp - b.timestamp);
    this.save();
  }

  /**
   * Persist to disk atomically — a sibling temp file then a rename, so a
   * crash mid-write leaves the previous good file intact. A no-op in
   * read-only mode: see the module comment for why an unreadable file must
   * never be overwritten by whatever happens to be in memory.
   */
  save(): void {
    if (this.#readOnly) return;

    const cutoff = Date.now() - this.#retentionMs;
    this.#snapshots = this.#snapshots.filter((s) => s.timestamp >= cutoff);
    if (this.#snapshots.length > MAX_SNAPSHOTS) {
      this.#snapshots = this.#snapshots.slice(this.#snapshots.length - MAX_SNAPSHOTS);
    }

    const payload: StatsHistoryFile = { version: 1, snapshots: this.#snapshots };
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true });

    const tmp = join(dir, `.${Date.now()}-${process.pid}.stats.tmp`);
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    try {
      renameSync(tmp, this.#path);
    } catch (err) {
      // Don't leave the temp file orphaned in the data directory on a failed
      // rename (e.g. the target is on a different filesystem, or a
      // permissions change mid-run) — best-effort cleanup, the original
      // error is what the operator needs to see.
      try {
        unlinkSync(tmp);
      } catch {
        // Already gone, or we can't remove it either — nothing more to do.
      }
      throw err;
    }
  }
}

/**
 * Rename a corrupt/unrecognized stats-history file aside so it can actually
 * be inspected, rather than silently discarding it — the module comment's
 * "the operator can't even inspect it" reasoning only holds if the file
 * still exists to inspect once the next save happens.
 */
function quarantine(path: string): void {
  const quarantinePath = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, quarantinePath);
    console.warn(
      `  warning: stats history at "${path}" is corrupt or has an unrecognized shape. ` +
        `Moved it to "${quarantinePath}" for inspection and starting fresh.`,
    );
  } catch (err) {
    console.warn(`  warning: stats history at "${path}" is corrupt, and could not be moved aside: ${err}`);
  }
}
