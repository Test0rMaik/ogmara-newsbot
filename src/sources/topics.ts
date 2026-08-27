/**
 * Topic source — posts about subjects the operator defines, not about
 * anything fetched.
 *
 * The only source with no external input. That makes it the safest one by a
 * wide margin: nothing an attacker controls reaches the prompt, so the fencing
 * that the RSS path needs is unnecessary here.
 *
 * Cadence is handled by *rotation*, not by generating many candidates. Each
 * topic becomes eligible again only after `minIntervalHours`, so a list of six
 * topics on an hourly schedule spreads out rather than cycling every six
 * hours. Without that, a short list would make the bot visibly repetitive.
 */

import { hashKey } from '../dedup.js';
import type { Candidate, PollResult, Source } from './types.js';

/** Options for {@link TopicsSource}. */
export interface TopicsSourceOptions {
  /** Subjects to write about, in the operator's own words. */
  topics: readonly string[];
  /**
   * Minimum gap before the same topic may be posted again.
   *
   * The dedup key buckets by this interval, so the ledger does the enforcing —
   * no extra state, and it survives restarts for free.
   */
  minIntervalHours: number;
  /** Injected for tests. */
  now?: () => number;
}

export class TopicsSource implements Source {
  readonly kind = 'topics' as const;
  readonly name = 'topics';

  readonly #topics: readonly string[];
  readonly #bucketMs: number;
  readonly #now: () => number;

  constructor(options: TopicsSourceOptions) {
    this.#topics = options.topics;
    this.#bucketMs = options.minIntervalHours * 3_600_000;
    this.#now = options.now ?? Date.now;
  }

  async poll(): Promise<PollResult> {
    const warnings: string[] = [];
    if (this.#topics.length === 0) {
      return { candidates: [], warnings: ['topics source is enabled but no topics are configured'] };
    }

    const now = this.#now();
    // Bucket the clock so every topic yields one candidate per interval. The
    // ledger rejects buckets already used, which is what enforces the gap.
    const bucket = Math.floor(now / this.#bucketMs);

    // Rotate the starting offset by bucket so the same topic is not always
    // first in line — otherwise topic #1 would win selection every time and
    // the rest would only ever appear when it was on cooldown.
    const offset = bucket % this.#topics.length;
    const rotated = [...this.#topics.slice(offset), ...this.#topics.slice(0, offset)];

    const candidates: Candidate[] = rotated.map((topic) => ({
      dedupKey: hashKey(`topic:${topic.trim().toLowerCase()}:${bucket}`),
      kind: 'topics' as const,
      title: topic,
      publishedAt: now,
    }));

    return { candidates, warnings };
  }
}
