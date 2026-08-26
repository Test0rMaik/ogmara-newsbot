import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiProvider, ComposeResult } from './ai/index.js';
import type { Config } from './config.js';
import { Ledger } from './ledger.js';
import type { ComposedPost, OgmaraPublisher, PublishResult } from './ogmara.js';
import { composeWithAi, runOnce, truncateTitle } from './pipeline.js';
import { PostQueue } from './queue.js';
import type { Candidate, Source } from './sources/types.js';

let dir: string;
let ledgerPath: string;
let queuePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newsbot-pipeline-'));
  ledgerPath = join(dir, 'ledger.json');
  queuePath = join(dir, 'queue.json');
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
  ai: { targetContentChars: 600, maxTags: 5 },
} as unknown as Config;

const TEMPLATE = 'Write about {{TITLE}} from {{PUBLISHER}}: {{SUMMARY}}';

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

/** Provider stub returning a fixed result and recording the prompts it saw. */
function providerStub(result: ComposeResult): { provider: AiProvider; prompts: string[] } {
  const prompts: string[] = [];
  const provider: AiProvider = {
    id: 'anthropic',
    model: 'stub',
    compose: async (req) => {
      prompts.push(req.prompt);
      return result;
    },
  };
  return { provider, prompts };
}

const OK_RESULT: ComposeResult = {
  status: 'ok',
  title: 'Rates unchanged',
  content: 'The central bank held rates steady this month.',
  tags: ['central-banking', 'rates'],
};

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

function deps(over: Partial<Parameters<typeof runOnce>[0]> = {}) {
  return {
    config: CONFIG,
    sources: [sourceOf(candidate())],
    ledger: Ledger.load(ledgerPath),
    queue: PostQueue.load(queuePath),
    publisher: publisherStub({ status: 'published', msgId: 'abc' }).pub,
    provider: providerStub(OK_RESULT).provider,
    template: TEMPLATE,
    ...over,
  };
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
    const body = out.slice(0, -1);
    expect(headline.startsWith(body)).toBe(true);
    expect(headline[body.length]).toBe(' ');
  });

  it('accepts a mid-word cut when one word is too long to break', () => {
    const out = truncateTitle(`${'a'.repeat(20)} ${'b'.repeat(300)}`, 40);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(40);
    expect(out.startsWith('aaaaaaaaaaaaaaaaaaaa b')).toBe(true);
  });

  it('counts bytes, not characters, for non-ASCII titles', () => {
    const out = truncateTitle('ü'.repeat(300), 100);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(100);
  });

  it('never splits a surrogate pair', () => {
    const out = truncateTitle('🚀'.repeat(100), 51);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(51);
    expect(out.isWellFormed()).toBe(true);
    expect([...out].every((c) => c === '🚀' || c === '…')).toBe(true);
  });
});

describe('composeWithAi', () => {
  it('renders the template with the candidate fields', async () => {
    const { provider, prompts } = providerStub(OK_RESULT);
    await composeWithAi(candidate(), CONFIG, provider, TEMPLATE);
    expect(prompts[0]).toContain('Fed holds rates steady');
    expect(prompts[0]).toContain('Example Wire');
    expect(prompts[0]).toContain('The central bank left rates unchanged.');
  });

  it('appends attribution rather than asking the model for it', async () => {
    // Models reword URLs; a mangled source link is worse than none, so the
    // link is added after composition.
    const { provider } = providerStub(OK_RESULT);
    const post = await composeWithAi(candidate(), CONFIG, provider, TEMPLATE);
    expect(post?.content).toContain('via [Example Wire](https://example.com/a)');
    expect(post?.content).toContain('The central bank held rates steady');
  });

  it('always carries the disclosure tag ahead of AI suggestions', async () => {
    const { provider } = providerStub(OK_RESULT);
    const post = await composeWithAi(candidate(), CONFIG, provider, TEMPLATE);
    expect(post?.tags[0]).toBe('bot');
    expect(post?.tags).toContain('central-banking');
  });

  it('enforces the protocol title cap even if the model ignores it', async () => {
    const { provider } = providerStub({ ...OK_RESULT, title: 'x'.repeat(400) });
    const post = await composeWithAi(candidate(), CONFIG, provider, TEMPLATE);
    expect(new TextEncoder().encode(post!.title).length).toBeLessThanOrEqual(256);
  });

  it('returns null when the model refuses', async () => {
    const { provider } = providerStub({ status: 'refused', category: 'cyber' });
    expect(await composeWithAi(candidate(), CONFIG, provider, TEMPLATE)).toBeNull();
  });

  it('handles a candidate with no summary', async () => {
    const { provider, prompts } = providerStub(OK_RESULT);
    const bare: Candidate = { dedupKey: 'k', kind: 'rss', title: 'Headline only' };
    await composeWithAi(bare, CONFIG, provider, TEMPLATE);
    expect(prompts[0]).toContain('(no summary provided)');
  });
});

describe('runOnce', () => {
  it('publishes a fresh candidate and records it', async () => {
    const d = deps();
    const outcome = await runOnce(d);
    expect(outcome.status).toBe('posted');
    expect(d.ledger.has('key-1')).toBe(true);
  });

  it('skips an item already in the ledger', async () => {
    const ledger = Ledger.load(ledgerPath);
    ledger.record({ key: 'key-1', title: 'Fed holds rates steady', postedAt: Date.now(), kind: 'rss' });
    const outcome = await runOnce(deps({ ledger }));
    expect(outcome.status).toBe('nothing-new');
  });

  it('skips a near-duplicate of a recent post', async () => {
    const ledger = Ledger.load(ledgerPath);
    ledger.record({
      key: 'other',
      title: 'Fed holds rates steady amid inflation concerns',
      postedAt: Date.now(),
      kind: 'rss',
    });
    const outcome = await runOnce(
      deps({
        ledger,
        sources: [
          sourceOf(
            candidate({ dedupKey: 'new', title: 'Fed holds rates steady despite inflation concerns' }),
          ),
        ],
      }),
    );
    expect(outcome.status).toBe('nothing-new');
  });

  it('does NOT record a dry run, so it stays repeatable', async () => {
    const d = deps({ config: { ...CONFIG, posting: { ...CONFIG.posting, dryRun: true } } as Config });
    d.publisher = publisherStub({ status: 'dry-run' }).pub;
    const outcome = await runOnce(d);
    expect(outcome.status).toBe('dry-run');
    expect(d.ledger.has('key-1')).toBe(false);
  });

  it('records a refusal so the item is not re-composed and re-billed', async () => {
    // Re-composing a declined item every run would pay for an AI call each
    // time and get the same refusal back.
    const d = deps({ provider: providerStub({ status: 'refused', category: 'cyber' }).provider });
    const outcome = await runOnce(d);
    expect(outcome.status).toBe('refused');
    expect(d.ledger.has('key-1')).toBe(true);
  });

  it('queues the composed post when the node rate-limits', async () => {
    const d = deps({ publisher: publisherStub({ status: 'rate-limited', retryAfterMs: 1000 }).pub });
    const outcome = await runOnce(d);
    expect(outcome.status).toBe('rate-limited');
    expect(d.queue.size).toBe(1);
    expect(d.ledger.has('key-1')).toBe(false);
  });

  it('publishes from the queue on the next run without re-composing', async () => {
    // The saved post already cost an AI call; a second call would pay twice.
    const queue = PostQueue.load(queuePath);
    const ledger = Ledger.load(ledgerPath);

    const first = deps({
      queue,
      ledger,
      publisher: publisherStub({ status: 'rate-limited', retryAfterMs: 1000 }).pub,
    });
    await runOnce(first);
    expect(queue.size).toBe(1);

    const { provider, prompts } = providerStub(OK_RESULT);
    const { pub, sent } = publisherStub({ status: 'published', msgId: 'xyz' });
    const outcome = await runOnce(deps({ queue, ledger, provider, publisher: pub }));

    expect(outcome).toMatchObject({ status: 'posted', fromQueue: true, msgId: 'xyz' });
    expect(prompts).toHaveLength(0); // no second AI call
    expect(sent[0]!.title).toBe('Rates unchanged');
    expect(queue.size).toBe(0);
    expect(ledger.has('key-1')).toBe(true);
  });

  it('does not re-queue an item that is already queued', async () => {
    const queue = PostQueue.load(queuePath);
    queue.enqueue({ key: 'key-1', sourceTitle: 'Fed holds rates steady', kind: 'rss', post: { title: 'T', content: 'C', tags: [] } });
    const d = deps({ queue, publisher: publisherStub({ status: 'rate-limited', retryAfterMs: 1 }).pub });
    await runOnce(d);
    expect(queue.size).toBe(1);
  });

  it('drains the queue before composing anything new', async () => {
    const queue = PostQueue.load(queuePath);
    queue.enqueue({
      key: 'queued-key',
      sourceTitle: 'Older story',
      kind: 'rss',
      post: { title: 'Queued post', content: 'body', tags: ['bot'] },
    });
    const { provider, prompts } = providerStub(OK_RESULT);
    const outcome = await runOnce(deps({ queue, provider }));

    expect(outcome).toMatchObject({ status: 'posted', fromQueue: true });
    expect(prompts).toHaveLength(0);
  });

  it('posts at most one item per run', async () => {
    const { pub, sent } = publisherStub({ status: 'published', msgId: 'x' });
    await runOnce(
      deps({
        publisher: pub,
        sources: [
          sourceOf(
            candidate({ dedupKey: 'a', title: 'Volcano erupts in Iceland' }),
            candidate({ dedupKey: 'b', title: 'Markets rally on tech earnings' }),
          ),
        ],
      }),
    );
    expect(sent).toHaveLength(1);
  });

  it('survives a source that throws', async () => {
    const broken: Source = {
      kind: 'rss',
      name: 'broken',
      poll: async () => {
        throw new Error('feed exploded');
      },
    };
    const outcome = await runOnce(deps({ sources: [broken, sourceOf(candidate())] }));
    expect(outcome.status).toBe('posted');
  });

  it('reports nothing-new when no sources yield candidates', async () => {
    const outcome = await runOnce(deps({ sources: [sourceOf()] }));
    expect(outcome).toEqual({ status: 'nothing-new', polled: 0 });
  });
});
