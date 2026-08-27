import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchError, assertFetchableUrl, fetchBytes, fetchText } from './http.js';

/**
 * `global.fetch` is stubbed rather than hitting a real server. The URLs used
 * throughout (`https://example.com/...`) are real hostnames chosen so
 * `assertFetchableUrl`'s blocklist check — the thing that matters here —
 * still runs for real on every call; only the network I/O underneath is
 * faked. A real local server would be bound to 127.0.0.1, which the SSRF
 * guard refuses by design, making a genuine end-to-end test impossible
 * without weakening the very check being tested.
 *
 * No existing test file covered this module before now. The refactor that
 * pulled the redirect-following loop out into
 * `fetchFollowingValidatedRedirects` (shared between `fetchText` and the new
 * `fetchBytes`) is exactly the kind of change that benefits from — and
 * needs — a regression check on both call sites.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Route `fetch(url)` calls to canned `Response`s, keyed by exact URL string. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch to ${url}`);
      return handler();
    }),
  );
}

describe('assertFetchableUrl', () => {
  it('accepts http/https', () => {
    expect(() => assertFetchableUrl('https://example.com/feed')).not.toThrow();
    expect(() => assertFetchableUrl('http://example.com/feed')).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertFetchableUrl('file:///etc/passwd')).toThrow(FetchError);
    expect(() => assertFetchableUrl('data:text/plain;base64,aGk=')).toThrow(FetchError);
  });

  it('rejects loopback and RFC1918 hosts', () => {
    expect(() => assertFetchableUrl('http://127.0.0.1/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://localhost/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://10.0.0.5/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://192.168.1.1/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://[::1]/')).toThrow(FetchError);
  });

  it('rejects CGNAT (100.64.0.0/10)', () => {
    expect(() => assertFetchableUrl('http://100.64.0.1/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://100.100.0.1/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://100.127.255.255/')).toThrow(FetchError);
    // Adjacent, real public ranges must NOT be caught by an overly broad regex.
    expect(() => assertFetchableUrl('http://100.63.255.255/')).not.toThrow();
    expect(() => assertFetchableUrl('http://100.128.0.0/')).not.toThrow();
  });

  it('rejects the IPv6 unspecified address and link-local range', () => {
    expect(() => assertFetchableUrl('http://[::]/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://[fe80::1]/')).toThrow(FetchError);
  });

  it('rejects IPv4-mapped IPv6 addresses in both dotted and hex form — verified SSRF bypass', () => {
    // http://[::ffff:127.0.0.1]/ previously reached real IPv4 loopback: the
    // WHATWG URL parser normalizes the hostname to the HEX form
    // "[::ffff:7f00:1]", which matched none of the (dotted-quad-only)
    // blocklist patterns. Security audit, 0.11.0.
    expect(() => assertFetchableUrl('http://[::ffff:127.0.0.1]/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://[::ffff:7f00:1]/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://[::ffff:10.0.0.5]/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://[::ffff:a00:5]/')).toThrow(FetchError);
    expect(() => assertFetchableUrl('http://[::ffff:192.168.1.1]/')).toThrow(FetchError);
    // A mapped PUBLIC address must still be allowed — this is not a blanket
    // ban on the ::ffff: form, only on addresses that map to blocked ranges.
    expect(() => assertFetchableUrl('http://[::ffff:8.8.8.8]/')).not.toThrow();
  });

  it('rejects a malformed URL', () => {
    expect(() => assertFetchableUrl('not a url')).toThrow(FetchError);
  });
});

describe('fetchText', () => {
  it('fetches a small body', async () => {
    stubFetch({ 'https://example.com/': () => new Response('hello world', { status: 200 }) });
    await expect(fetchText('https://example.com/')).resolves.toBe('hello world');
  });

  it('rejects a body larger than maxBytes', async () => {
    stubFetch({
      'https://example.com/big': () => new Response('x'.repeat(4096), { status: 200 }),
    });
    await expect(fetchText('https://example.com/big', { maxBytes: 1024 })).rejects.toThrow(
      /exceeded 1024 bytes/,
    );
  });

  it('cancels the body stream once the size cap is exceeded, rather than draining it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2048)));
      },
      cancel() {
        cancelled = true;
      },
    });
    stubFetch({ 'https://example.com/big': () => new Response(body, { status: 200 }) });
    await expect(fetchText('https://example.com/big', { maxBytes: 1024 })).rejects.toThrow(FetchError);
    expect(cancelled).toBe(true);
  });

  it('rejects up front on a declared Content-Length over the limit', async () => {
    stubFetch({
      'https://example.com/big': () =>
        new Response('irrelevant', { status: 200, headers: { 'content-length': '999999999' } }),
    });
    await expect(fetchText('https://example.com/big', { maxBytes: 1024 })).rejects.toThrow(
      /declares 999999999 bytes/,
    );
  });

  it('follows one redirect', async () => {
    stubFetch({
      'https://example.com/start': () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/target' } }),
      'https://example.com/target': () => new Response('redirected-body', { status: 200 }),
    });
    await expect(fetchText('https://example.com/start')).resolves.toBe('redirected-body');
  });

  it('caps redirect hops', async () => {
    stubFetch({
      'https://example.com/loop': () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }),
    });
    await expect(fetchText('https://example.com/loop')).rejects.toThrow(/exceeded \d+ redirects/);
  });

  it('re-validates every redirect hop, refusing a hop to a blocked host', async () => {
    stubFetch({
      'https://example.com/start': () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1/pivot' } }),
    });
    await expect(fetchText('https://example.com/start')).rejects.toThrow(/loopback or private address/);
  });

  it('re-validates a LATER hop in a multi-hop chain, not just the first redirect', async () => {
    // Proves the per-hop check isn't something a future refactor could
    // accidentally hoist out of the loop and run only once.
    stubFetch({
      'https://example.com/hop1': () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/hop2' } }),
      'https://example.com/hop2': () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    });
    await expect(fetchText('https://example.com/hop1')).rejects.toThrow(/loopback or private address/);
  });

  it('rejects a non-2xx response', async () => {
    stubFetch({
      'https://example.com/gone': () => new Response('nope', { status: 500, statusText: 'oops' }),
    });
    await expect(fetchText('https://example.com/gone')).rejects.toThrow(/HTTP 500/);
  });

  it('refuses a blocked host up front, without ever calling fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchText('http://127.0.0.1/')).rejects.toThrow(FetchError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchBytes', () => {
  it('fetches binary content and reports content-type', async () => {
    stubFetch({
      'https://example.com/img': () =>
        new Response(new Uint8Array([1, 2, 3, 4, 255]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    });
    const result = await fetchBytes('https://example.com/img');
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 255]);
    expect(result.contentType).toBe('image/png');
  });

  it('rejects a body larger than maxBytes', async () => {
    stubFetch({
      'https://example.com/img': () => new Response(new Uint8Array(4096), { status: 200 }),
    });
    await expect(fetchBytes('https://example.com/img', { maxBytes: 1024 })).rejects.toThrow(
      /exceeded 1024 bytes/,
    );
  });

  it('rejects a declared Content-Length over the limit before reading the body', async () => {
    stubFetch({
      'https://example.com/img': () =>
        new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '999999999' } }),
    });
    await expect(fetchBytes('https://example.com/img', { maxBytes: 1024 })).rejects.toThrow(
      /declares 999999999 bytes/,
    );
  });

  it('reassembles multi-chunk bodies in order', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.enqueue(new Uint8Array([7, 8, 9]));
        controller.close();
      },
    });
    stubFetch({ 'https://example.com/img': () => new Response(body, { status: 200 }) });
    const result = await fetchBytes('https://example.com/img');
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('follows a redirect the same way fetchText does', async () => {
    stubFetch({
      'https://example.com/start': () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/target' } }),
      'https://example.com/target': () =>
        new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    });
    const result = await fetchBytes('https://example.com/start');
    expect(Array.from(result.bytes)).toEqual([9, 9, 9]);
    expect(result.contentType).toBe('image/jpeg');
  });

  it('re-validates redirect hops, refusing a pivot to a blocked host', async () => {
    stubFetch({
      'https://example.com/start': () =>
        new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/pivot' } }),
    });
    await expect(fetchBytes('https://example.com/start')).rejects.toThrow(/loopback or private address/);
  });

  it('refuses a blocked host up front, without ever calling fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchBytes('http://127.0.0.1:1/')).rejects.toThrow(FetchError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a non-2xx response', async () => {
    stubFetch({
      'https://example.com/gone': () => new Response('nope', { status: 404, statusText: 'not found' }),
    });
    await expect(fetchBytes('https://example.com/gone')).rejects.toThrow(/HTTP 404/);
  });

  it('returns empty bytes for a null body rather than throwing', async () => {
    stubFetch({ 'https://example.com/empty': () => new Response(null, { status: 204 }) });
    const result = await fetchBytes('https://example.com/empty');
    expect(result.bytes.length).toBe(0);
  });
});
