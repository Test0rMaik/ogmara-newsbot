/**
 * Pending-post queue.
 *
 * When the node rate-limits a post, the composed result is parked here and
 * retried on a later run instead of being discarded.
 *
 * **It stores the composed post, not the source candidate.** That distinction
 * is the whole point: composition costs an AI API call, so re-deriving a
 * rate-limited post would mean paying twice for the same output. Queuing the
 * finished post also decouples it from the feed — an item that scrolls out of
 * the RSS window while the bot is throttled is still published, whereas
 * re-polling for it would silently lose it.
 *
 * Same storage approach as the ledger, for the same reasons: JSON with atomic
 * writes, no native dependency, operator-inspectable.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ComposedPost } from './ogmara.js';

/** A composed post awaiting publication. */
export interface QueuedPost {
  /** Dedup key of the source item, recorded in the ledger once published. */
  key: string;
  /** Source headline, for near-duplicate comparison after publication. */
  sourceTitle: string;
  /** Which source produced it. */
  kind: string;
  /** The fully composed post — already tag-normalized and validated. */
  post: ComposedPost;
  /** When it was queued, Unix ms. */
  queuedAt: number;
  /** How many publish attempts have been made. */
  attempts: number;
}

interface QueueFile {
  version: 1;
  pending: QueuedPost[];
}

/**
 * Give up on an item after this many failed publish attempts.
 *
 * Bounded because a post that keeps failing is usually failing for a permanent
 * reason, and an unbounded queue would retry it forever while newer items
 * queue up behind it.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Discard queued posts older than this.
 *
 * News goes stale. Publishing a three-day-old story because the bot was
 * throttled at the time is worse than not publishing it.
 */
export const DEFAULT_MAX_AGE_HOURS = 24;

/** Structural check for a queue entry deserialized from disk. */
function isQueuedPost(value: unknown): value is QueuedPost {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  const post = e['post'] as Record<string, unknown> | undefined;
  return (
    typeof e['key'] === 'string' &&
    typeof e['sourceTitle'] === 'string' &&
    typeof e['kind'] === 'string' &&
    typeof e['queuedAt'] === 'number' &&
    typeof e['attempts'] === 'number' &&
    post !== undefined &&
    post !== null &&
    typeof post['title'] === 'string' &&
    typeof post['content'] === 'string' &&
    Array.isArray(post['tags'])
  );
}

/** FIFO queue of composed posts waiting to be published. */
export class PostQueue {
  readonly #path: string;
  readonly #maxAttempts: number;
  readonly #maxAgeMs: number;
  #pending: QueuedPost[];

  private constructor(path: string, pending: QueuedPost[], maxAttempts: number, maxAgeHours: number) {
    this.#path = path;
    this.#pending = pending;
    this.#maxAttempts = maxAttempts;
    this.#maxAgeMs = maxAgeHours * 3_600_000;
  }

  /**
   * Load the queue, creating an empty one if absent.
   *
   * A corrupt queue is recoverable in a way a corrupt ledger is not: the worst
   * case is losing a few pending posts, whereas a reset ledger reposts
   * everything. So this warns and starts empty rather than refusing to start —
   * an unattended bot should keep running.
   */
  static load(
    path: string,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    maxAgeHours: number = DEFAULT_MAX_AGE_HOURS,
  ): PostQueue {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new PostQueue(path, [], maxAttempts, maxAgeHours);
      }
      throw err;
    }

    try {
      const parsed = JSON.parse(raw) as QueueFile;
      if (!Array.isArray(parsed.pending)) throw new Error('no pending array');
      // The version field was written on every save and never read. A future
      // schema change replaying an old queue.json straight into publish() is
      // the hazard this closes. (Audit 2026-08-26, M17.)
      if (parsed.version !== 1) throw new Error(`unsupported version ${String(parsed.version)}`);
      // Shape-check each entry: the file is advertised as operator-editable,
      // and an entry missing `post` would previously reach publish(undefined)
      // and TypeError on the FIRST thing every run does — crashing every run
      // for up to maxAgeHours. Bad entries are dropped, not fatal.
      const valid = parsed.pending.filter(isQueuedPost);
      if (valid.length !== parsed.pending.length) {
        console.warn(
          `Warning: dropped ${parsed.pending.length - valid.length} malformed queue entr(ies) from "${path}".`,
        );
      }
      return new PostQueue(path, valid, maxAttempts, maxAgeHours);
    } catch (err) {
      console.warn(
        `Warning: queue at "${path}" is unreadable (${err instanceof Error ? err.message : String(err)}); ` +
          'starting with an empty queue. At most a few pending posts are lost.',
      );
      return new PostQueue(path, [], maxAttempts, maxAgeHours);
    }
  }

  /** Number of posts currently waiting. */
  get size(): number {
    return this.#pending.length;
  }

  /** Whether this source item is already queued. */
  has(key: string): boolean {
    return this.#pending.some((p) => p.key === key);
  }

  /** Add a composed post to the back of the queue. */
  enqueue(entry: Omit<QueuedPost, 'queuedAt' | 'attempts'>, now: number = Date.now()): void {
    if (this.has(entry.key)) return;
    this.#pending.push({ ...entry, queuedAt: now, attempts: 0 });
    this.save();
  }

  /**
   * Return the oldest post still worth publishing, dropping any that have
   * expired or exhausted their attempts.
   *
   * Expiry is evaluated here rather than only on save so a queue that sat
   * untouched across a long outage doesn't hand back stale news on the next
   * run.
   */
  next(now: number = Date.now()): QueuedPost | undefined {
    const cutoff = now - this.#maxAgeMs;
    const before = this.#pending.length;
    this.#pending = this.#pending.filter(
      (p) => p.queuedAt >= cutoff && p.attempts < this.#maxAttempts,
    );
    if (this.#pending.length !== before) this.save();
    return this.#pending[0];
  }

  /** Record a failed publish attempt, dropping the post if it's out of retries. */
  recordAttempt(key: string): void {
    const entry = this.#pending.find((p) => p.key === key);
    if (entry === undefined) return;
    entry.attempts += 1;
    if (entry.attempts >= this.#maxAttempts) {
      console.warn(
        `Dropping queued post "${entry.post.title}" after ${entry.attempts} failed attempts.`,
      );
      this.#pending = this.#pending.filter((p) => p.key !== key);
    }
    this.save();
  }

  /** Remove a post from the queue after it publishes successfully. */
  remove(key: string): void {
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((p) => p.key !== key);
    if (this.#pending.length !== before) this.save();
  }

  /** Persist atomically — temp file plus rename, as with the ledger. */
  save(): void {
    const payload: QueueFile = { version: 1, pending: this.#pending };
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${Date.now()}-${process.pid}-queue.tmp`);
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}
