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
  /** Absolute path to an image to post, for the image-directory source. */
  imagePath?: string;
  /** MIME type of {@link imagePath}. */
  imageMimeType?: string;
}

/** A configured, pollable source. */
export interface Source {
  readonly kind: SourceKind;
  /** Operator-facing name, used in logs. */
  readonly name: string;
  /**
   * Fetch the current set of candidates plus any non-fatal problems.
   *
   * Returns warnings rather than just candidates because a dead or hijacked
   * feed is otherwise indistinguishable from a quiet news day: the bot prints
   * "Nothing new to post" forever while the one signal that would explain it
   * is discarded. (Audit 2026-08-26, M11.)
   */
  poll(): Promise<PollResult>;
}

/** Result of polling one source, including partial failures. */
export interface PollResult {
  candidates: Candidate[];
  /** Non-fatal problems worth logging (one dead feed among several, etc.). */
  warnings: string[];
}
