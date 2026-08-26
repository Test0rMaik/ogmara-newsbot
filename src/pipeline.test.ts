import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { Ledger } from './ledger.js';
import type { ComposedPost, OgmaraPublisher, PublishResult } from './ogmara.js';
import { composeFromCandidate, runOnce, truncateTitle } from './pipeline.js';
import type { Candidate, Source } from './sources/types.js';

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-pipeline-'));
  ledgerPath = join(dir, 'ledger.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CONFIG = {
  posting: {
    dryRun: false,
    alwaysTags: [],
    disclosureTag: 'bot',
    includeSourceLink: true,
  },
} as unknown as Config;

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    dedupKey: 'key-1',
    kind: 'rss',
    title: 'Fed holds rates steady',
    summary: 'The central bank left rates unchanged.',
    url: 'https://example.com/a',
    publisher: 'Example Wire',
    ...over,
  };
}

function sourceOf(...items: Candidate[]): Source {
  return { kind: 'rss', name: 'test', poll: async () => items };
}

/** Publisher stub recording what it was asked to publish. */
function publisherStub(result: PublishResult): { pub: OgmaraPublisher; sent: ComposedPost[] } {
  const sent: ComposedPost[] = [];
  const pub = {
    address: 'klv1test',
    publish: async (post: ComposedPost): Promise<PublishResult> => {
      sent.push(post);
      return result;
    },
  } as unknown as OgmaraPublisher;
  return { pub, sent };
}

describe('truncateTitle', () => {
  it('leaves a short title alone', () => {
    expect(truncateTitle('Short headline')).toBe('Short headline');
  });

  it('trims to the byte cap and marks the cut', () => {
    const out = truncateTitle('word '.repeat(100), 256);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(256);
    expect(out.endsWith('…')).toBe(true);
  });

  it('cuts on a word boundary rather than mid-word', () => {
    const headline = 'Central bank officials signal caution as inflation pressures persist';
    const out = truncateTitle(headline, 40);
    expect(out.endsWith('…')).toBe(true);
    // Everything before the ellipsis is whole words from the original.
    const body = out.slice(0, -1);
    expect(headline.startsWith(body)).toBe(true);
    expect(headline[body.length]).toBe(' ');
  });

  it('accepts a mid-word cut when one word is too long to break', () => {
    // With no usable boundary, a mid-word cut beats returning almost nothing.
    const out = truncateTitle(`${'a'.repeat(20)} ${'b'.repeat(300)}`, 40);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(40);
    expect(out.startsWith('aaaaaaaaaaaaaaaaaaaa b')).toBe(true);
  });

  it('counts bytes, not characters, for non-ASCII titles', () => {
    const out = truncateTitle('ü'.repeat(300), 100);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(100);
  });

  it('never splits a surrogate pair', () => {
    // Slicing by UTF-16 unit would emit a lone surrogate — invalid UTF-8 that
    // the node would reject.
    const out = truncateTitle('🚀'.repeat(100), 51);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(51);
    expect(out.isWellFormed()).toBe(true);
    expect([...out].every((c) => c === '🚀' || c === '…')).toBe(true);
  });
});

describe('composeFromCandidate', () => {
  it('includes an attribution link', () => {
    const post = composeFromCandidate(candidate(), CONFIG);
    expect(post.content).toContain('via [Example Wire](https://example.com/a)');
  });

  it('always carries the disclosure tag', () => {
    expect(composeFromCandidate(candidate(), CONFIG).tags).toContain('bot');
  });

  it('omits the link when attribution is disabled', () => {
    const cfg = { posting: { ...CONFIG.posting, includeSourceLink: false } } as Config;
    expect(composeFromCandidate(candidate(), cfg).content).not.toContain('via [');
  });

  it('falls back to the title when there is no summary', () => {
    const cfg = { posting: { ...CONFIG.posting, includeSourceLink: false } } as Config;
    const noSummary: Candidate = {
      dedupKey: 'k',
      kind: 'rss',
      title: 'Fed holds rates steady',
      url: 'https://example.com/a',
    };
    expect(composeFromCandidate(noSummary, cfg).content).toBe('Fed holds rates steady');
  });
});

describe('runOnce', () => {
  it('publishes a fresh candidate and records it', async () => {
    const ledger = Ledger.load(ledgerPath);
    const { pub, sent } = publisherStub({ status: 'published', msgId: 'abc123' });

    const outcome = await runOnce({
      config: CONFIG,
      sources: [sourceOf(candidate())],
      ledger,
      publisher: pub,
    });

    expect(outcome.status).toBe('posted');
    expect(sent).toHaveLength(1);
    expect(ledger.has('key-1')).toBe(true);
  });

  it('skips an item already in the ledger', async () => {
    const ledger = Ledger.load(ledgerPath);
    ledger.record({ key: 'key-1', title: 'Fed holds rates steady', postedAt: Date.now(), kind: 'rss' });
    const { pub, sent } = publisherStub({ status: 'published', msgId: 'x' });

    const outcome = await runOnce({
      config: CONFIG,
      sources: [sourceOf(candidate())],
      ledger,
      publisher: pub,
    });

    expect(outcome.status).toBe('nothing-new');
    expect(sent).toHaveLength(0);
  });

  it('skips a near-duplicate of a recent post from another publisher', async () => {
    const ledger = Ledger.load(ledgerPath);
    ledger.record({
      key: 'other-key',
      title: 'Fed holds rates steady amid inflation concerns',
      postedAt: Date.now(),
      kind: 'rss',
    });
    const { pub, sent } = publisherStub({ status: 'published', msgId: 'x' });

    const outcome = await runOnce({
      config: CONFIG,
      sources: [
        sourceOf(candidate({ dedupKey: 'new', title: 'Fed holds rates steady despite inflation concerns' })),
      ],
      ledger,
      publisher: pub,
    });

    expect(outcome.status).toBe('nothing-new');
    expect(sent).toHaveLength(0);
  });

  it('does NOT record a dry run, so it stays repeatable', async () => {
    // Recording a dry run would mean the item is silently skipped once the
    // operator goes live — swallowing their first real post.
    const ledger = Ledger.load(ledgerPath);
    const { pub } = publisherStub({ status: 'dry-run' });

    const outcome = await runOnce({
      config: { ...CONFIG, posting: { ...CONFIG.posting, dryRun: true } } as Config,
      sources: [sourceOf(candidate())],
      ledger,
      publisher: pub,
    });

    expect(outcome.status).toBe('dry-run');
    expect(ledger.has('key-1')).toBe(false);
  });

  it('does NOT record when the node rate-limits, so the item is retried', async () => {
    const ledger = Ledger.load(ledgerPath);
    const { pub } = publisherStub({ status: 'rate-limited', retryAfterMs: 1000 });

    const outcome = await runOnce({
      config: CONFIG,
      sources: [sourceOf(candidate())],
      ledger,
      publisher: pub,
    });

    expect(outcome.status).toBe('rate-limited');
    expect(ledger.has('key-1')).toBe(false);
  });

  it('posts at most one item per run', async () => {
    const ledger = Ledger.load(ledgerPath);
    const { pub, sent } = publisherStub({ status: 'published', msgId: 'x' });

    await runOnce({
      config: CONFIG,
      sources: [
        sourceOf(
          candidate({ dedupKey: 'a', title: 'Volcano erupts in Iceland' }),
          candidate({ dedupKey: 'b', title: 'Markets rally on tech earnings' }),
        ),
      ],
      ledger,
      publisher: pub,
    });

    expect(sent).toHaveLength(1);
  });

  it('survives a source that throws', async () => {
    const ledger = Ledger.load(ledgerPath);
    const { pub, sent } = publisherStub({ status: 'published', msgId: 'x' });
    const broken: Source = {
      kind: 'rss',
      name: 'broken',
      poll: async () => {
        throw new Error('feed exploded');
      },
    };

    const outcome = await runOnce({
      config: CONFIG,
      sources: [broken, sourceOf(candidate())],
      ledger,
      publisher: pub,
    });

    expect(outcome.status).toBe('posted');
    expect(sent).toHaveLength(1);
  });

  it('reports nothing-new when no sources yield candidates', async () => {
    const outcome = await runOnce({
      config: CONFIG,
      sources: [sourceOf()],
      ledger: Ledger.load(ledgerPath),
      publisher: publisherStub({ status: 'published', msgId: 'x' }).pub,
    });
    expect(outcome).toEqual({ status: 'nothing-new', polled: 0 });
  });
});
