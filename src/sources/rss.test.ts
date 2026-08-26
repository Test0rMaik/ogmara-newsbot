import { describe, expect, it } from 'vitest';
import { parseFeed, stripHtml } from './rss.js';

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example Wire</title>
    <item>
      <title>Rates held steady</title>
      <link>https://example.com/rates?utm_source=rss</link>
      <guid isPermaLink="false">tag:example.com,2026:1</guid>
      <description>&lt;p&gt;The central bank &amp;amp; its board held rates.&lt;/p&gt;</description>
      <pubDate>Tue, 26 Aug 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second story</title>
      <link>https://example.com/second</link>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Daily</title>
  <entry>
    <title>Volcano erupts</title>
    <id>urn:uuid:1234</id>
    <link rel="self" href="https://example.org/feed"/>
    <link rel="alternate" href="https://example.org/volcano"/>
    <summary>Lava flows observed.</summary>
    <published>2026-08-26T09:00:00Z</published>
  </entry>
</feed>`;

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<p>Hello &amp; welcome</p>')).toBe('Hello & welcome');
  });

  it('drops script and style content entirely', () => {
    expect(stripHtml('<script>evil()</script>text')).toBe('text');
    expect(stripHtml('<style>.a{}</style>text')).toBe('text');
  });

  it('collapses whitespace', () => {
    expect(stripHtml('<p>a</p>\n\n  <p>b</p>')).toBe('a b');
  });
});

describe('parseFeed — RSS', () => {
  const items = parseFeed(RSS_FEED);

  it('parses every item', () => {
    expect(items).toHaveLength(2);
  });

  it('maps the core fields', () => {
    const first = items[0]!;
    expect(first.title).toBe('Rates held steady');
    expect(first.url).toBe('https://example.com/rates?utm_source=rss');
    expect(first.kind).toBe('rss');
    expect(first.publishedAt).toBe(Date.parse('Tue, 26 Aug 2026 08:00:00 GMT'));
  });

  it('strips markup from the description', () => {
    expect(items[0]!.summary).toBe('The central bank & its board held rates.');
  });

  it('falls back to the channel title for the publisher', () => {
    expect(items[0]!.publisher).toBe('Example Wire');
  });

  it('honours a publisher override', () => {
    expect(parseFeed(RSS_FEED, 'Custom Name')[0]!.publisher).toBe('Custom Name');
  });

  it('keeps items that have no date', () => {
    // Plenty of feeds omit dates; dropping them would silently ignore whole
    // publishers.
    expect(items[1]!.title).toBe('Second story');
    expect(items[1]!.publishedAt).toBeUndefined();
  });

  it('produces stable dedup keys across parses', () => {
    expect(parseFeed(RSS_FEED)[0]!.dedupKey).toBe(items[0]!.dedupKey);
  });
});

describe('parseFeed — Atom', () => {
  const items = parseFeed(ATOM_FEED);

  it('parses entries', () => {
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Volcano erupts');
  });

  it('prefers rel="alternate" over rel="self"', () => {
    // rel="self" is the feed's own address, not the article — picking it would
    // make every post link back to the feed.
    expect(items[0]!.url).toBe('https://example.org/volcano');
  });

  it('maps summary and published date', () => {
    expect(items[0]!.summary).toBe('Lava flows observed.');
    expect(items[0]!.publishedAt).toBe(Date.parse('2026-08-26T09:00:00Z'));
  });
});

describe('parseFeed — malformed input', () => {
  it('throws a clear error for non-feed XML', () => {
    expect(() => parseFeed('<html><body>not a feed</body></html>')).toThrow(
      /not a recognizable RSS or Atom feed/,
    );
  });

  it('skips items with no title rather than failing the feed', () => {
    const feed = `<rss version="2.0"><channel><title>T</title>
      <item><link>https://x.com/a</link></item>
      <item><title>Good</title><link>https://x.com/b</link></item>
      </channel></rss>`;
    const items = parseFeed(feed);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Good');
  });

  it('handles a feed with a single item (not wrapped in an array)', () => {
    // fast-xml-parser collapses a lone repeated element to a scalar, which is
    // the classic way feed parsers break on small feeds.
    const feed = `<rss version="2.0"><channel><title>T</title>
      <item><title>Only</title><link>https://x.com/a</link></item>
      </channel></rss>`;
    expect(parseFeed(feed)).toHaveLength(1);
  });

  it('handles an empty channel', () => {
    expect(parseFeed('<rss version="2.0"><channel><title>T</title></channel></rss>')).toEqual([]);
  });
});

describe('stripHtml — hostile input (audit M2/SEC-N2)', () => {
  it('handles a large run of unmatched "<" in linear time', () => {
    // Previously quadratic: 400 KB of bare "<" took 92 seconds and froze the
    // whole single-threaded bot.
    const started = Date.now();
    stripHtml('<'.repeat(400_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('strips markup that only appears after entity decoding', () => {
    // &lt;img&gt; survives the first tag pass as text, then decodes to real
    // markup — a second pass is needed.
    expect(stripHtml('a &lt;img src=x onerror=alert(1)&gt; b')).toBe('a b');
  });
});
