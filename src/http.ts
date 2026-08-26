/**
 * Bounded HTTP fetching for untrusted remote content.
 *
 * Feeds are operator-configured, so this is not a hostile-input boundary in the
 * way a user-submitted URL would be — but a feed can still be enormous, hang,
 * or redirect somewhere unexpected, and an unattended bot must survive all
 * three without operator intervention. Every fetch is therefore capped on
 * size, time and redirects.
 */

/** Raised when a fetch fails or violates a bound. */
export class FetchError extends Error {
  override readonly name = 'FetchError';
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

/** Options for {@link fetchText}. */
export interface FetchOptions {
  /** Abort after this many milliseconds. */
  timeoutMs?: number;
  /** Reject responses larger than this many bytes. */
  maxBytes?: number;
  /** User-Agent to send. */
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'ogmara-newsbot (+https://github.com/Test0rMaik/ogmara-newsbot)';

/**
 * Assert a URL is safe to fetch.
 *
 * Only http/https — this blocks `file:`, `data:` and other schemes that a
 * hand-edited or copy-pasted config could otherwise smuggle in and turn into a
 * local file read.
 */
export function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchError('not a valid URL', url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FetchError(`unsupported protocol "${parsed.protocol}" (only http/https)`, url);
  }
  return parsed;
}

/**
 * Fetch a URL as text, enforcing size and time bounds.
 *
 * The body is read incrementally and aborted the moment it exceeds `maxBytes`,
 * rather than buffered first and checked after — otherwise a multi-gigabyte
 * response would exhaust memory before any check could run. `Content-Length` is
 * only a hint (it is absent on chunked responses and can lie), so it is used as
 * an early reject but never trusted as the sole guard.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  assertFetchableUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'user-agent': userAgent,
      },
    });

    if (!resp.ok) {
      throw new FetchError(`HTTP ${resp.status} ${resp.statusText}`, url);
    }

    const declared = Number(resp.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new FetchError(`response declares ${declared} bytes, limit is ${maxBytes}`, url);
    }

    if (resp.body === null) return '';

    const decoder = new TextDecoder('utf-8');
    let received = 0;
    let text = '';

    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        await resp.body.cancel().catch(() => undefined);
        throw new FetchError(`response exceeded ${maxBytes} bytes`, url);
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();

    return text;
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FetchError(`timed out after ${timeoutMs}ms`, url);
    }
    throw new FetchError(err instanceof Error ? err.message : String(err), url);
  } finally {
    clearTimeout(timer);
  }
}
