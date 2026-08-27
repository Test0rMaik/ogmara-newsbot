/**
 * Bounded HTTP fetching for untrusted remote content.
 *
 * The feed URL itself is operator-configured, but content pulled *from* a
 * feed — an item's own image URL, in particular — is not: on any aggregator
 * feed that carries third-party items, that URL is attacker-influenceable,
 * and it is the literal request target, not just a redirect pivot. So this
 * is a genuine SSRF boundary (`assertFetchableUrl`'s blocklist), not only
 * defence against a feed hanging, growing unbounded, or redirecting
 * somewhere unexpected — though it guards all of those too, and an
 * unattended bot must survive all of it without operator intervention.
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

/** Maximum redirect hops before giving up. */
const MAX_REDIRECTS = 5;

/**
 * Host patterns a feed must never resolve to.
 *
 * Literal-address check only: this deliberately does not do a DNS lookup, so
 * it stops the obvious `302 -> http://127.0.0.1/` pivot without pretending to
 * be full SSRF protection (which would need resolve-then-pin to defeat DNS
 * rebinding).
 *
 * **This is no longer only a redirect-pivot guard.** Since `fetchBytes` (see
 * below) is called with a URL lifted directly out of feed XML
 * (`<enclosure>`/`media:thumbnail`/etc.), the *initial* request URL — not
 * just a redirect target — is now attacker-influenceable on any aggregator
 * feed that carries third-party items. `assertFetchableUrl` is therefore a
 * real SSRF boundary, not just a defence against a hostile publisher
 * redirecting a feed's own URL. (Security audit, 0.11.0.)
 */
const BLOCKED_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  // CGNAT (RFC 6598) — 100.64.0.0/10.
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
  /^\[?::1\]?$/,
  // The IPv6 unspecified address — resolves to localhost like 0.0.0.0 does.
  /^\[?::\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  // IPv6 link-local — the 169.254.0.0/16 equivalent, previously unblocked.
  /^\[?fe80:/i,
];

/**
 * Recover the embedded IPv4 address from an IPv4-mapped IPv6 hostname
 * (`::ffff:a.b.c.d` or the hex form `::ffff:XXXX:YYYY` the WHATWG URL parser
 * normalizes it to — e.g. `[::ffff:127.0.0.1]` becomes hostname
 * `[::ffff:7f00:1]`), so it can be checked against the IPv4 rules above.
 * Verified bypass: without this, `http://[::ffff:127.0.0.1]/` reached IPv4
 * loopback on a dual-stack host despite `127.` being blocked — the mapped
 * address never matched any pattern in its hex form. (Security audit, 0.11.0.)
 */
function ipv4MappedDotted(hostname: string): string | undefined {
  const bare = hostname.replace(/^\[|\]$/g, '');
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(bare);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return undefined;
}

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
  const mapped = ipv4MappedDotted(parsed.hostname);
  const blocked =
    BLOCKED_HOST_PATTERNS.some((re) => re.test(parsed.hostname)) ||
    (mapped !== undefined && BLOCKED_HOST_PATTERNS.some((re) => re.test(mapped)));
  if (blocked) {
    throw new FetchError(`refusing to fetch a loopback or private address (${parsed.hostname})`, url);
  }
  return parsed;
}

/**
 * Follow redirects manually, re-validating every hop.
 *
 * Shared by every fetch helper in this module: with `redirect: 'follow'` only
 * the initial URL is checked, and a hostile or MITM'd server can bounce the
 * request to a loopback or RFC1918 address — a blind SSRF probe of the
 * operator's LAN from a long-lived unattended process. (Audit 2026-08-26,
 * M15.) Duplicating this loop per fetch helper would risk the two drifting
 * out of sync on exactly the check that matters, so there is exactly one
 * copy.
 */
async function fetchFollowingValidatedRedirects(
  url: string,
  accept: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    assertFetchableUrl(current);
    const resp = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { accept, 'user-agent': userAgent },
    });

    if (resp.status < 300 || resp.status >= 400) return resp;

    const location = resp.headers.get('location');
    if (location === null) return resp;
    if (hop >= MAX_REDIRECTS) {
      throw new FetchError(`exceeded ${MAX_REDIRECTS} redirects`, url);
    }
    // Drain the redirect body so the socket is released promptly.
    await resp.body?.cancel().catch(() => undefined);
    current = new URL(location, current).toString();
  }
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
    const resp = await fetchFollowingValidatedRedirects(
      url,
      'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      userAgent,
      controller.signal,
    );

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

/** A binary fetch's result: the bytes plus whatever the server said they are. */
export interface FetchedBytes {
  bytes: Uint8Array;
  /** The `Content-Type` header, if the server sent one. Not validated here — callers decide what to trust it for. */
  contentType: string | undefined;
}

/**
 * Fetch a URL as raw bytes, enforcing the same size/time/SSRF bounds as
 * {@link fetchText}.
 *
 * Used to pull a candidate's illustrative image (an RSS `<enclosure>` or
 * `media:thumbnail` URL) — that URL comes from the same untrusted feed as
 * everything else in a {@link Candidate}, so it gets the same treatment: no
 * loopback/RFC1918 targets, bounded size, bounded time, every redirect hop
 * re-validated.
 */
export async function fetchBytes(url: string, options: FetchOptions = {}): Promise<FetchedBytes> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    userAgent = DEFAULT_USER_AGENT,
  } = options;

  assertFetchableUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchFollowingValidatedRedirects(url, 'image/*', userAgent, controller.signal);

    if (!resp.ok) {
      throw new FetchError(`HTTP ${resp.status} ${resp.statusText}`, url);
    }

    const declared = Number(resp.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new FetchError(`response declares ${declared} bytes, limit is ${maxBytes}`, url);
    }

    const contentType = resp.headers.get('content-type') ?? undefined;
    if (resp.body === null) return { bytes: new Uint8Array(0), contentType };

    let received = 0;
    const chunks: Uint8Array[] = [];

    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        await resp.body.cancel().catch(() => undefined);
        throw new FetchError(`response exceeded ${maxBytes} bytes`, url);
      }
      chunks.push(chunk);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { bytes, contentType };
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
