/**
 * Client-IP resolution behind reverse proxies.
 *
 * This exists for one reason: the panel grants unauthenticated access to
 * loopback clients, so *whatever decides "is this loopback"* is an
 * authentication boundary. Getting it wrong is a full auth bypass.
 *
 * The naive implementation — trust the leftmost `X-Forwarded-For` entry — is
 * exactly that bypass, because the header is attacker-controlled: anyone can
 * send `X-Forwarded-For: 127.0.0.1` and inherit the localhost exemption. This
 * module follows the l2-node's approach (`trusted_proxies::resolve_client_ip`):
 *
 * 1. **Ignore the header entirely unless the TCP peer is itself trusted.** A
 *    direct connection from a stranger has its headers discarded, so it can
 *    never forge its own address.
 * 2. **Walk the chain right-to-left, skipping trusted hops**, and return the
 *    first *untrusted* address. The rightmost entries are appended by
 *    infrastructure you control; the leftmost are whatever the client claimed.
 *    Taking the first untrusted hop from the right yields the earliest address
 *    that some trusted component actually observed.
 * 3. **Fall back to the TCP peer** when every hop is trusted or the header is
 *    absent or unparseable — never to a claimed value.
 *
 * Only `X-Forwarded-For` is parsed. RFC 7239 `Forwarded` is deliberately *not*
 * consulted: an operator using it exclusively falls through to the TCP peer,
 * which denies the loopback bypass rather than granting it wrongly.
 */

import { BlockList, isIP } from 'node:net';

/**
 * Longest `X-Forwarded-For` chain considered.
 *
 * The header is attacker-controlled and unbounded; a chain this long already
 * means something is wrong, and parsing further is pure attacker-directed work.
 */
const MAX_CHAIN_ENTRIES = 50;

/** Raised when a configured trusted-proxy entry cannot be parsed. */
export class TrustedProxyError extends Error {
  override readonly name = 'TrustedProxyError';
}

/**
 * A compiled set of addresses whose forwarding headers may be believed.
 *
 * Loopback is always trusted, matching the node: an operator reverse-proxying
 * on the same host must work without extra configuration.
 */
export class TrustedProxies {
  readonly #list = new BlockList();

  /**
   * @param entries Bare addresses (`10.0.0.5`) or CIDRs (`10.0.0.0/8`).
   * @throws {TrustedProxyError} on any entry that is not a valid address or CIDR.
   */
  constructor(entries: readonly string[] = []) {
    // Loopback, always. `::ffff:127.x` is covered by BlockList's built-in
    // handling of IPv4-mapped addresses.
    this.#list.addSubnet('127.0.0.0', 8, 'ipv4');
    this.#list.addAddress('::1', 'ipv6');

    for (const raw of entries) {
      const entry = raw.trim();
      if (entry === '') continue;

      const slash = entry.indexOf('/');
      if (slash === -1) {
        const family = isIP(entry);
        if (family === 0) {
          throw new TrustedProxyError(`"${entry}" is not a valid IP address or CIDR`);
        }
        this.#list.addAddress(entry, family === 6 ? 'ipv6' : 'ipv4');
        continue;
      }

      const addr = entry.slice(0, slash);
      const prefixText = entry.slice(slash + 1);
      const family = isIP(addr);
      if (family === 0) {
        throw new TrustedProxyError(`"${entry}" has an invalid network address`);
      }
      const max = family === 6 ? 128 : 32;
      const prefix = Number(prefixText);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
        throw new TrustedProxyError(
          `"${entry}" has an invalid prefix length (expected 0-${max})`,
        );
      }
      this.#list.addSubnet(addr, prefix, family === 6 ? 'ipv6' : 'ipv4');
    }
  }

  /** Whether forwarding headers from this address may be believed. */
  trusts(ip: string): boolean {
    const family = isIP(ip);
    if (family === 0) return false;
    // BlockList returns false rather than throwing on malformed input, so a
    // junk address is simply untrusted.
    return this.#list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  }
}

/**
 * Whether an address is loopback, including the IPv4-mapped IPv6 form.
 *
 * Lowercased first so an uppercase `::FFFF:` prefix (valid, if unusual) isn't
 * missed. Does not decode the non-canonical pure-hex mapped form
 * (`::ffff:7f00:1`) — Node's own address-formatting and any well-behaved
 * proxy always emit the dotted-decimal form (`::ffff:127.0.0.1`) per RFC 5952,
 * so that form is unreachable in practice, and this fails CLOSED (denies the
 * bypass) rather than open if it were ever seen.
 */
export function isLoopback(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  const bare = lower.startsWith('::ffff:') ? lower.slice(7) : lower;
  return isIP(bare) === 4 && bare.startsWith('127.');
}

/**
 * Determine the real client address for an incoming request.
 *
 * @param peerIp    The TCP peer address (`socket.remoteAddress`).
 * @param forwarded The raw `X-Forwarded-For` header, if any.
 * @param trusted   Compiled trusted-proxy set.
 * @returns The resolved client IP — always either the peer or an address
 *          vouched for by a trusted hop, never an unvouched claim.
 */
export function resolveClientIp(
  peerIp: string,
  forwarded: string | string[] | undefined,
  trusted: TrustedProxies,
): string {
  // The peer is a stranger: its headers are worthless, and believing them is
  // the bypass this whole module exists to prevent.
  if (!trusted.trusts(peerIp)) return peerIp;
  if (forwarded === undefined) return peerIp;

  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  // Keep the RIGHTMOST entries, not the leftmost. The rightmost entries are
  // the ones appended by infrastructure we trust; the leftmost are whatever
  // the original (possibly attacker-controlled) request claimed. Slicing from
  // the front here previously discarded the trusted tail on an oversized
  // header and left only attacker-authored entries to walk — a full
  // loopback-bypass auth bypass when the peer is a trusted local proxy that
  // appends the real client (verified with a working PoC during audit).
  const chain = header
    .split(',')
    .slice(-MAX_CHAIN_ENTRIES)
    .map((part) => normalizeEntry(part));

  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i];
    if (hop === undefined || hop === '') continue;
    if (trusted.trusts(hop)) continue;
    return hop;
  }

  // Every hop was trusted (or the header was empty): the true origin is not
  // knowable from the header, so fall back to the peer.
  return peerIp;
}

/**
 * Clean one `X-Forwarded-For` entry down to a bare address.
 *
 * Handles the bracketed-IPv6-with-port form (`[::1]:443`) some proxies emit,
 * and strips a trailing port from IPv4. Anything that is not a valid address
 * afterwards becomes `''` and is skipped by the caller — which, being an
 * untrusted-but-unusable hop, correctly falls through rather than being
 * returned as a client address.
 */
function normalizeEntry(part: string): string {
  let value = part.trim();
  if (value === '') return '';

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close !== -1) value = value.slice(1, close);
  } else if (isIP(value) === 0) {
    // Only strip a port when the value is not already a bare address — a plain
    // IPv6 address is full of colons and must not be truncated.
    const colon = value.lastIndexOf(':');
    if (colon !== -1) value = value.slice(0, colon);
  }

  return isIP(value) === 0 ? '' : value;
}
