/**
 * RSS 2.0 / Atom 1.0 source.
 *
 * Parses feeds with `fast-xml-parser` and maps both formats onto a common
 * {@link Candidate}. The two formats disagree on almost every field name
 * (`pubDate` vs `updated`, `description` vs `summary`, a plain `link` string vs
 * a `<link href>` attribute), so the mapping is explicit rather than clever —
 * feeds in the wild are inconsistent enough that guessing costs more than it
 * saves.
 *
 * A single unreachable or malformed feed never fails the poll; it is reported
 * as a warning so one dead publisher cannot stop an unattended bot.
 */

import { XMLParser } from 'fast-xml-parser';
import { candidateKey } from '../dedup.js';
import { FetchError, fetchText } from '../http.js';
import type { Candidate, PollResult, Source } from './types.js';

/** One configured feed. */
export interface FeedConfig {
  url: string;
  /**
   * Overrides the publisher name taken from the feed itself.
   *
   * Explicitly `| undefined` so config objects parsed by Zod — which produce
   * present-but-undefined properties — satisfy this under
   * `exactOptionalPropertyTypes`.
   */
  publisher?: string | undefined;
}

/** Options for {@link RssSource}. */
export interface RssSourceOptions {
  feeds: readonly FeedConfig[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Ignore items older than this. 0 disables the check. */
  maxAgeDays?: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Feed text routinely contains entity-encoded markup; without this, titles
  // arrive as "&amp;" instead of "&".
  processEntities: true,
  trimValues: true,
});

/**
 * Tolerance for feed items dated slightly in the future.
 *
 * Publisher clocks drift and timezone handling is often wrong, so a few
 * minutes ahead is normal and should not drop a legitimate item.
 */
const FUTURE_SKEW_MS = 10 * 60_000;

/** Coerce a value that may be a single item or an array into an array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Pull plain text out of a node that may be a string or an object with #text. */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (value !== null && typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text.trim() || undefined;
  }
  return undefined;
}

/**
 * Strip HTML from a feed summary.
 *
 * Feeds embed markup in `description`/`summary` constantly. The bot passes this
 * text to an AI provider and may quote it, so tags are removed rather than
 * rendered — this is a text pipeline, and un-stripped markup shows up as
 * literal `<p>` in composed posts.
 *
 * **Every character class here excludes `<` as well as `>`, and that is load
 * bearing.** With `[^>]` a run of unmatched `<` makes the engine scan to
 * end-of-string and backtrack from every position — quadratic, and reachable
 * from any feed body. Measured on 400 KB of bare `<`: 92,841 ms with `[^>]`,
 * 0.5 ms with `[^<>]`, byte-identical output on real markup. A tag can never
 * legally contain `<`, so excluding it costs nothing and bounds the scan.
 * (Audit 2026-08-26, M2.)
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^<>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^<>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // Second tag-strip pass, because the decodes above can *reveal* markup:
    // `&lt;img onerror=…&gt;` survives the first pass as text and only becomes
    // `<img onerror=…>` here. One extra linear pass closes that, and the
    // bounded character class keeps it cheap. (Audit 2026-08-26, SEC-N2.)
    .replace(/<[^<>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the link from an Atom entry, which may have several `<link>` forms. */
function atomLink(entry: Record<string, unknown>): string | undefined {
  const links = asArray(entry['link'] as unknown);
  // Prefer rel="alternate" (the human-readable page); fall back to the first
  // link that has an href at all. rel="self"/"enclosure" are not the article.
  const candidates = links.filter(
    (l): l is Record<string, unknown> => l !== null && typeof l === 'object',
  );
  const alternate = candidates.find((l) => {
    const rel = l['@_rel'];
    return rel === undefined || rel === 'alternate';
  });
  const chosen = alternate ?? candidates[0];
  const href = chosen?.['@_href'];
  if (typeof href === 'string' && href.trim().length > 0) return href.trim();
  return asText(entry['link']);
}

/** Parse a date string to Unix ms, or undefined if unparseable. */
function parseDate(value: unknown): number | undefined {
  const text = asText(value);
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Parse feed XML into candidates.
 *
 * Exported for direct testing — feed-shape handling is where this module will
 * break, and testing it through the network would make those tests useless.
 */
export function parseFeed(xml: string, fallbackPublisher?: string): Candidate[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const out: Candidate[] = [];

  const rssChannel = (doc['rss'] as Record<string, unknown> | undefined)?.['channel'] as
    | Record<string, unknown>
    | undefined;
  const atomFeed = doc['feed'] as Record<string, unknown> | undefined;

  if (rssChannel !== undefined) {
    const publisher = fallbackPublisher ?? asText(rssChannel['title']);
    for (const raw of asArray(rssChannel['item'] as unknown)) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const title = asText(item['title']);
      if (title === undefined) continue;

      const url = asText(item['link']);
      const guid = asText(item['guid']);
      const summaryRaw = asText(item['description']) ?? asText(item['content:encoded']);
      const publishedAt = parseDate(item['pubDate']) ?? parseDate(item['dc:date']);

      out.push({
        dedupKey: candidateKey({
          ...(guid !== undefined ? { guid } : {}),
          ...(url !== undefined ? { url } : {}),
          title,
        }),
        kind: 'rss',
        title,
        ...(summaryRaw !== undefined ? { summary: stripHtml(summaryRaw) } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(publisher !== undefined ? { publisher } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      });
    }
    return out;
  }

  if (atomFeed !== undefined) {
    const publisher = fallbackPublisher ?? asText(atomFeed['title']);
    for (const raw of asArray(atomFeed['entry'] as unknown)) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const title = asText(entry['title']);
      if (title === undefined) continue;

      const url = atomLink(entry);
      const guid = asText(entry['id']);
      const summaryRaw = asText(entry['summary']) ?? asText(entry['content']);
      const publishedAt = parseDate(entry['published']) ?? parseDate(entry['updated']);

      out.push({
        dedupKey: candidateKey({
          ...(guid !== undefined ? { guid } : {}),
          ...(url !== undefined ? { url } : {}),
          title,
        }),
        kind: 'rss',
        title,
        ...(summaryRaw !== undefined ? { summary: stripHtml(summaryRaw) } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(publisher !== undefined ? { publisher } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      });
    }
    return out;
  }

  throw new Error('not a recognizable RSS or Atom feed (no <rss><channel> or <feed> root)');
}

/** Polls a set of RSS/Atom feeds. */
export class RssSource implements Source {
  readonly kind = 'rss' as const;
  readonly name = 'rss';

  readonly #feeds: readonly FeedConfig[];
  readonly #timeoutMs: number | undefined;
  readonly #maxBytes: number | undefined;
  readonly #maxAgeMs: number;

  constructor(options: RssSourceOptions) {
    this.#feeds = options.feeds;
    this.#timeoutMs = options.timeoutMs;
    this.#maxBytes = options.maxBytes;
    this.#maxAgeMs = (options.maxAgeDays ?? 0) * 86_400_000;
  }

  /** Poll every configured feed, collecting warnings instead of failing. */
  async pollDetailed(): Promise<PollResult> {
    const warnings: string[] = [];
    const candidates: Candidate[] = [];
    const now = Date.now();
    const cutoff = this.#maxAgeMs > 0 ? now - this.#maxAgeMs : 0;

    const results = await Promise.allSettled(
      this.#feeds.map(async (feed) => {
        const xml = await fetchText(feed.url, {
          ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
          ...(this.#maxBytes !== undefined ? { maxBytes: this.#maxBytes } : {}),
        });
        return { feed, items: parseFeed(xml, feed.publisher) };
      }),
    );

    for (const [i, result] of results.entries()) {
      const feed = this.#feeds[i];
      if (feed === undefined) continue;
      if (result.status === 'rejected') {
        const err: unknown = result.reason;
        const reason =
          err instanceof FetchError || err instanceof Error ? err.message : String(err);
        warnings.push(`feed ${feed.url}: ${reason}`);
        continue;
      }
      for (const item of result.value.items) {
        // Drop future-dated items. Candidates are sorted newest-first and the
        // pipeline takes the first unseen one, so a <pubDate> in 2099 wins
        // selection on EVERY run — a hostile item pins itself at the top
        // forever, starving every legitimate publisher, and (because maxAgeDays
        // only drops items that are too OLD) it never ages out either. Also
        // fires accidentally on any feed with clock skew or a timezone bug.
        // (Audit 2026-08-26, chain A/B.)
        if (item.publishedAt !== undefined && item.publishedAt > now + FUTURE_SKEW_MS) {
          warnings.push(
            `feed ${feed.url}: dropped future-dated item "${item.title.slice(0, 60)}"`,
          );
          continue;
        }
        // An item with no date is kept: plenty of feeds omit dates, and
        // dropping them would silently ignore whole publishers.
        if (cutoff > 0 && item.publishedAt !== undefined && item.publishedAt < cutoff) continue;
        candidates.push(item);
      }
    }

    // Newest first, undated last — the bot should lead with fresh news.
    candidates.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return { candidates, warnings };
  }

  async poll(): Promise<PollResult> {
    return this.pollDetailed();
  }
}
