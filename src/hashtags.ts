/**
 * Tag extraction and normalization for Ogmara news posts.
 *
 * This module encodes a **protocol rule**, not a stylistic choice. From the
 * Ogmara protocol spec (§3.5, "Hashtags and tags"):
 *
 * - `tags` is the canonical list used for indexing and GossipSub routing
 * - clients SHOULD extract `#hashtags` from `content`/`title` and merge them in
 * - max 10 tags total
 * - tags are lowercase alphanumeric + hyphens, max 64 bytes each
 *
 * Crucially, **nodes index whatever is in the `tags` array and never parse the
 * content**. So if this module drops a tag, that tag simply does not exist as
 * far as the network is concerned — there is no server-side safety net. That is
 * why the rules live in one place with direct test coverage.
 */

/** Maximum number of tags on a single news post (protocol §3.5). */
export const MAX_TAGS = 10;

/** Maximum size of a single tag, in UTF-8 bytes (protocol §3.5). */
export const MAX_TAG_BYTES = 64;

const UTF8 = new TextEncoder();

/**
 * Matches `#hashtag` occurrences in free text.
 *
 * The leading `(^|[^\w#])` guard prevents matching inside words and stops a
 * `##double` from yielding a second empty-ish tag. Unicode letters are accepted
 * here and folded later by {@link normalizeTag}, so `#münchen` survives as
 * `munchen` rather than being missed entirely.
 */
const HASHTAG_RE = /(?:^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_-]+)/gu;

/**
 * Normalize one raw tag into protocol-legal form.
 *
 * Returns `null` when nothing legal survives (e.g. a tag of only punctuation),
 * so callers can drop it rather than emit an empty string the node would reject.
 *
 * Diacritics are folded rather than replaced (`münchen` → `munchen`); replacing
 * them would produce `m-nchen`, which splits one word into two nonsense stems
 * and would fragment the tag index for any non-English feed.
 */
export function normalizeTag(raw: string): string | null {
  let tag = raw.trim().replace(/^#+/, '');
  if (tag.length === 0) return null;

  // Fold accents: "é" → "e". NFKD splits the base letter from its combining
  // mark, which the following strip then removes.
  tag = tag.normalize('NFKD').replace(/\p{Diacritic}/gu, '');

  tag = tag.toLowerCase();

  // Word separators become hyphens so multi-word input stays readable.
  tag = tag.replace(/[\s_.]+/g, '-');

  // Anything still outside the legal charset is dropped outright. Dropping
  // beats hyphen-substitution here: a stray "&" inside a word should not
  // fracture it.
  tag = tag.replace(/[^a-z0-9-]/g, '');

  tag = tag.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (tag.length === 0) return null;

  if (UTF8.encode(tag).length > MAX_TAG_BYTES) {
    // Post-normalization the charset is pure ASCII, so bytes === characters and
    // a plain slice cannot split a multi-byte sequence. Asserted by a test so
    // the assumption fails loudly if the charset rule ever widens.
    tag = tag.slice(0, MAX_TAG_BYTES).replace(/-+$/, '');
    if (tag.length === 0) return null;
  }

  return tag;
}

/**
 * Extract `#hashtags` from free text, normalized and de-duplicated.
 *
 * Order of first appearance is preserved.
 */
export function extractHashtags(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(HASHTAG_RE)) {
    const captured = match[1];
    if (captured === undefined) continue;
    const tag = normalizeTag(captured);
    if (tag !== null && !found.includes(tag)) found.push(tag);
  }
  return found;
}

/** Inputs to {@link buildTags}. */
export interface BuildTagsInput {
  /**
   * Tags that must survive truncation if at all possible — the bot-disclosure
   * tag and any operator-configured `alwaysTags`. Kept in given order.
   */
  required?: string[];
  /** Tags suggested by the AI composer. */
  suggested?: string[];
  /** Post title, scanned for inline `#hashtags`. */
  title?: string;
  /** Post body, scanned for inline `#hashtags`. */
  content?: string;
}

/**
 * Build the final, protocol-legal tag list for a news post.
 *
 * Priority order, highest first — this decides what survives the 10-tag cap:
 *
 * 1. `required` (disclosure tag, operator's `alwaysTags`)
 * 2. `suggested` (AI-proposed)
 * 3. hashtags found inline in the title
 * 4. hashtags found inline in the content
 *
 * Required tags rank first deliberately: the bot-disclosure tag is a
 * transparency guarantee, so an AI that returns ten enthusiastic tags must not
 * be able to push it off the list.
 */
export function buildTags(input: BuildTagsInput): string[] {
  const out: string[] = [];

  const push = (raw: string): void => {
    if (out.length >= MAX_TAGS) return;
    const tag = normalizeTag(raw);
    if (tag === null || out.includes(tag)) return;
    out.push(tag);
  };

  for (const t of input.required ?? []) push(t);
  for (const t of input.suggested ?? []) push(t);
  for (const t of extractHashtags(input.title ?? '')) push(t);
  for (const t of extractHashtags(input.content ?? '')) push(t);

  return out;
}
