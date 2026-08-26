/**
 * Persistent record of what the bot has already posted.
 *
 * This is the bot's only durable state, and losing it means reposting the
 * backlog — so writes are atomic (temp file + rename) rather than in-place. A
 * crash mid-write leaves the previous good file intact instead of a truncated
 * one that fails to parse on restart.
 *
 * Deliberately a JSON file rather than SQLite: at the volumes this bot operates
 * at (a node caps news posts per wallet per hour, so a few hundred entries a
 * day at most) a JSON document is entirely adequate, needs no native build
 * toolchain for people installing the bot, and stays readable and editable by
 * the operator — which matters for a tool whose whole job is publishing on
 * their behalf. If you ever run this at a volume where that hurts, the
 * interface here is narrow enough to swap the storage behind it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** One published item. */
export interface LedgerEntry {
  /** {@link import('./dedup.js').candidateKey} of the source item. */
  key: string;
  /** Title as posted, retained for near-duplicate comparison. */
  title: string;
  /** Ogmara message id, absent for dry runs. */
  msgId?: string;
  /** Unix milliseconds. */
  postedAt: number;
  /** Which source produced it. */
  kind: string;
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

/** Default retention. Older entries are pruned on save. */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * How many recent titles to compare against for near-duplicate detection.
 *
 * Bounded because similarity is O(n) per candidate and old headlines stop
 * being relevant — a story resurfacing three months later is genuinely news
 * again, not a duplicate.
 */
export const NEAR_DUPLICATE_WINDOW = 200;

/** Tracks posted items and prevents re-posting them. */
export class Ledger {
  readonly #path: string;
  readonly #retentionMs: number;
  #entries: LedgerEntry[];
  #keys: Set<string>;

  private constructor(path: string, entries: LedgerEntry[], retentionDays: number) {
    this.#path = path;
    this.#entries = entries;
    this.#keys = new Set(entries.map((e) => e.key));
    this.#retentionMs = retentionDays * 86_400_000;
  }

  /**
   * Load a ledger, creating an empty one if the file does not exist.
   *
   * A corrupt file is a hard error rather than a silent reset: silently
   * starting empty would repost the entire backlog, which is far worse than
   * refusing to start and letting the operator look.
   */
  static load(path: string, retentionDays: number = DEFAULT_RETENTION_DAYS): Ledger {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Ledger(path, [], retentionDays);
      }
      throw err;
    }

    let parsed: LedgerFile;
    try {
      parsed = JSON.parse(raw) as LedgerFile;
    } catch (err) {
      throw new Error(
        `ledger at "${path}" is corrupt and cannot be parsed: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          'Refusing to start: continuing with an empty ledger would repost everything. ' +
          'Inspect or delete the file to proceed.',
      );
    }

    if (!Array.isArray(parsed.entries)) {
      throw new Error(`ledger at "${path}" has no entries array — refusing to start`);
    }

    return new Ledger(path, parsed.entries, retentionDays);
  }

  /** Whether this item has already been posted. */
  has(key: string): boolean {
    return this.#keys.has(key);
  }

  /** Titles of recent posts, newest first, for near-duplicate comparison. */
  recentTitles(limit: number = NEAR_DUPLICATE_WINDOW): string[] {
    return this.#entries
      .slice()
      .sort((a, b) => b.postedAt - a.postedAt)
      .slice(0, limit)
      .map((e) => e.title);
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.#entries.length;
  }

  /** Record a posted item and persist immediately. */
  record(entry: LedgerEntry): void {
    if (this.#keys.has(entry.key)) return;
    this.#entries.push(entry);
    this.#keys.add(entry.key);
    this.save();
  }

  /**
   * Persist to disk atomically.
   *
   * Writes a sibling temp file then renames over the target — rename is atomic
   * within a filesystem, so a reader (or a crash) sees either the old file or
   * the new one, never a half-written one.
   */
  save(): void {
    const cutoff = Date.now() - this.#retentionMs;
    this.#entries = this.#entries.filter((e) => e.postedAt >= cutoff);
    this.#keys = new Set(this.#entries.map((e) => e.key));

    const payload: LedgerFile = { version: 1, entries: this.#entries };
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true });

    const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}
