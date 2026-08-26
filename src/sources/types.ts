/**
 * The source abstraction.
 *
 * A source produces {@link Candidate}s — things that *could* become a post. It
 * does no deduplication, scheduling or composing; those belong to the ledger,
 * the scheduler and the composer respectively. Keeping sources this narrow is
 * what makes adding one a single-file job.
 */

/** Which kind of source produced a candidate. */
export type SourceKind = 'rss' | 'topics' | 'imagedir';

/** Something a source found that could become a post. */
export interface Candidate {
  /**
   * Stable identity for deduplication.
   *
   * Must be derived from the *content's* identity, not from when or where it
   * was found — the same article discovered via three feeds, or re-seen on the
   * next poll, has to produce the same key or the bot will post duplicates.
   */
  dedupKey: string;
  kind: SourceKind;
  /** Headline as published by the source. */
  title: string;
  /** Summary or excerpt, if the source provides one. */
  summary?: string;
  /** Canonical link to the original item. */
  url?: string;
  /** Human-readable publisher name, used for attribution. */
  publisher?: string;
  /** Publication time in Unix milliseconds, if known. */
  publishedAt?: number;
}

/** A configured, pollable source. */
export interface Source {
  readonly kind: SourceKind;
  /** Operator-facing name, used in logs. */
  readonly name: string;
  /** Fetch the current set of candidates. Should not throw for a single bad item. */
  poll(): Promise<Candidate[]>;
}

/** Result of polling one source, including partial failures. */
export interface PollResult {
  candidates: Candidate[];
  /** Non-fatal problems worth logging (one dead feed among several, etc.). */
  warnings: string[];
}
