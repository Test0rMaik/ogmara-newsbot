/**
 * Deduplication keys and near-duplicate detection.
 *
 * Two different problems, both of which cause visible bot misbehaviour:
 *
 * 1. **The same item seen twice** — every poll re-reads the whole feed, so
 *    without a stable key the bot reposts its entire backlog on each run.
 *    Solved by {@link candidateKey}.
 * 2. **The same story from different publishers** — a wire story syndicated to
 *    five outlets is five distinct URLs. Posting all five is the single most
 *    obvious way a news bot reads as spam. Solved by {@link isNearDuplicate}.
 */

import { createHash } from 'node:crypto';

/**
 * Query parameters that identify *how you arrived*, not *what you're reading*.
 *
 * Leaving these in means the same article shared via newsletter and via Twitter
 * produces two different keys and gets posted twice.
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'referrer',
  'source',
  'cmpid',
  'cmp',
  'ito',
  'smid',
  'partner',
  'spm',
  'xtor',
]);

/** Parameter name prefixes that are always tracking (`utm_*`, `at_*`). */
const TRACKING_PREFIXES = ['utm_', 'at_', 'pk_', 'piwik_', 'matomo_'];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  return TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Reduce a URL to a canonical form for comparison.
 *
 * Strips tracking parameters, the fragment, a default port and a trailing
 * slash; lowercases scheme and host; sorts remaining parameters so ordering
 * differences don't produce different keys. Path case is preserved — plenty of
 * sites serve case-sensitive paths.
 *
 * Returns the input unchanged if it isn't parseable, so a malformed link still
 * yields a usable (if less precise) key rather than throwing.
 */
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();

  let out = url.toString();
  out = out.replace(/\?$/, '');
  // Trailing slash on a non-root path is almost never significant, and feeds
  // are inconsistent about emitting it.
  out = out.replace(/(?<!\/)\/$/, '');
  return out;
}

/** SHA-256 of a string, hex-encoded. Used to keep ledger keys fixed-width. */
export function hashKey(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Build a stable deduplication key for a feed item.
 *
 * Prefers the feed's own GUID when it looks durable, since that is what the
 * publisher considers the item's identity and it survives URL changes. Many
 * feeds emit a GUID that is just the link, which canonicalizes to the same
 * thing anyway. Falls back to the title when there is neither — weak, but
 * better than treating every poll as new.
 */
export function candidateKey(item: { guid?: string; url?: string; title: string }): string {
  if (item.guid !== undefined && item.guid.trim().length > 0) {
    const guid = item.guid.trim();
    // A GUID that is itself a URL benefits from the same canonicalization,
    // otherwise a tracking parameter inside it defeats the whole exercise.
    return hashKey(guid.startsWith('http') ? canonicalizeUrl(guid) : guid);
  }
  if (item.url !== undefined && item.url.trim().length > 0) {
    return hashKey(canonicalizeUrl(item.url));
  }
  // Join the token list back into a string: normalization already dropped
  // punctuation, casing and stopwords, so this keys on the headline's
  // significant words rather than its exact rendering.
  //
  // Fall back to the raw title when normalization yields nothing. It strips to
  // [a-z0-9], so ANY Cyrillic or CJK headline tokenises to [] — every item on
  // such a feed would otherwise share one key, and only the first would ever
  // be posted. Ogmara ships UI in 7 languages including Russian, so this is an
  // ordinary user, not an edge case. (Audit 2026-08-26, M13.)
  const tokens = normalizeTitle(item.title);
  return hashKey(tokens.length > 0 ? tokens.join(' ') : item.title.trim().toLowerCase());
}

/** Words carrying no distinguishing signal when comparing headlines. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with', 'after', 'over', 'into', 'says', 'say', 'new',
]);

/** Reduce a headline to a comparable token set. */
export function normalizeTitle(title: string): string[] {
  return title
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Jaccard similarity between two headlines, 0..1.
 *
 * Chosen over edit distance because syndicated headlines are usually the same
 * words lightly reordered or re-punctuated ("Fed holds rates steady" vs "Fed
 * holds rates steady, signals caution"), which set overlap catches and
 * character-level distance does not.
 */
export function titleSimilarity(a: string, b: string): number {
  // Same fallback as candidateKey: without it, similarity is a permanent no-op
  // for non-Latin feeds, silently disabling the "same story, different outlet"
  // protection the README advertises by name. Character bigrams work for
  // scripts that do not use spaces. (Audit 2026-08-26, M13.)
  const setA = new Set(tokensOrBigrams(a));
  const setB = new Set(tokensOrBigrams(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Significant-word tokens, or character bigrams for scripts they cannot handle. */
function tokensOrBigrams(title: string): string[] {
  const tokens = normalizeTitle(title);
  if (tokens.length > 0) return tokens;
  const chars = [...title.trim().toLowerCase().replace(/\s+/g, '')];
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) bigrams.push(chars[i]! + chars[i + 1]!);
  return bigrams;
}

/**
 * Default similarity above which two headlines are treated as the same story.
 *
 * 0.6 was picked to sit between genuinely distinct headlines that share topic
 * words and true syndication. Tunable per operator, since a single-topic feed
 * list naturally runs higher similarity throughout.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

/** Whether `title` is a near-duplicate of anything in `recentTitles`. */
export function isNearDuplicate(
  title: string,
  recentTitles: readonly string[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): boolean {
  return recentTitles.some((seen) => titleSimilarity(title, seen) >= threshold);
}
