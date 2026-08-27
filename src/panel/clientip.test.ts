import { describe, expect, it } from 'vitest';
import { TrustedProxies, TrustedProxyError, isLoopback, resolveClientIp } from './clientip.js';

const NO_PROXIES = new TrustedProxies();

describe('TrustedProxies', () => {
  it('always trusts loopback without configuration', () => {
    expect(NO_PROXIES.trusts('127.0.0.1')).toBe(true);
    expect(NO_PROXIES.trusts('127.5.6.7')).toBe(true);
    expect(NO_PROXIES.trusts('::1')).toBe(true);
  });

  it('does not trust anything else by default', () => {
    expect(NO_PROXIES.trusts('10.0.0.1')).toBe(false);
    expect(NO_PROXIES.trusts('8.8.8.8')).toBe(false);
  });

  it('trusts configured addresses and CIDRs', () => {
    const t = new TrustedProxies(['10.0.0.0/8', '192.168.1.5']);
    expect(t.trusts('10.99.1.1')).toBe(true);
    expect(t.trusts('192.168.1.5')).toBe(true);
    expect(t.trusts('192.168.1.6')).toBe(false);
    expect(t.trusts('11.0.0.1')).toBe(false);
  });

  it('trusts IPv6 CIDRs', () => {
    const t = new TrustedProxies(['fd00::/8']);
    expect(t.trusts('fd00::1234')).toBe(true);
    expect(t.trusts('fe80::1')).toBe(false);
  });

  it('treats an IPv4-mapped IPv6 peer as its IPv4 self', () => {
    // Node hands out `::ffff:10.0.0.1` on dual-stack sockets; a proxy allowlist
    // written in IPv4 must still match, or the operator is silently locked out.
    const t = new TrustedProxies(['10.0.0.0/8']);
    expect(t.trusts('::ffff:10.0.0.1')).toBe(true);
  });

  it('rejects malformed entries at construction rather than at request time', () => {
    // Failing loudly at startup beats a config typo silently narrowing trust.
    expect(() => new TrustedProxies(['not-an-ip'])).toThrow(TrustedProxyError);
    expect(() => new TrustedProxies(['10.0.0.0/99'])).toThrow(TrustedProxyError);
    expect(() => new TrustedProxies(['10.0.0.0/abc'])).toThrow(TrustedProxyError);
    expect(() => new TrustedProxies(['999.1.1.1/8'])).toThrow(TrustedProxyError);
  });

  it('does not trust a malformed address at check time', () => {
    expect(NO_PROXIES.trusts('garbage')).toBe(false);
    expect(NO_PROXIES.trusts('')).toBe(false);
  });
});

describe('isLoopback', () => {
  it('recognises every loopback form', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.1.2.3')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects non-loopback and junk', () => {
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('128.0.0.1')).toBe(false);
    expect(isLoopback('1.2.3.4')).toBe(false);
    expect(isLoopback('garbage')).toBe(false);
  });
});

describe('resolveClientIp — spoofing defence', () => {
  it('IGNORES the header from an untrusted peer', () => {
    // The core bypass: a stranger claiming to be localhost must not become
    // localhost. This is the single most important assertion in the file.
    const resolved = resolveClientIp('203.0.113.9', '127.0.0.1', NO_PROXIES);
    expect(resolved).toBe('203.0.113.9');
    expect(isLoopback(resolved)).toBe(false);
  });

  it('does not let a spoofed LEFTMOST entry win behind a real proxy', () => {
    // nginx on localhost appends the true client, so the header reads
    // "<claim>, <real>". Taking the leftmost value would hand the attacker
    // whatever they typed.
    const resolved = resolveClientIp('127.0.0.1', '127.0.0.1, 203.0.113.9', NO_PROXIES);
    expect(resolved).toBe('203.0.113.9');
    expect(isLoopback(resolved)).toBe(false);
  });

  it('does not let a long spoofed prefix win', () => {
    const spoof = '127.0.0.1, 127.0.0.1, 10.0.0.1, 203.0.113.9';
    expect(resolveClientIp('127.0.0.1', spoof, NO_PROXIES)).toBe('203.0.113.9');
  });

  it('cannot be bypassed by claiming to be a trusted proxy from outside', () => {
    const t = new TrustedProxies(['10.0.0.0/8']);
    // Peer is a stranger, so the header is discarded wholesale.
    expect(resolveClientIp('203.0.113.9', '127.0.0.1, 10.0.0.5', t)).toBe('203.0.113.9');
  });

  it('falls back to the peer when the whole chain is trusted', () => {
    const t = new TrustedProxies(['10.0.0.0/8']);
    // Every hop is infrastructure; the true origin is unknowable, so we must
    // not invent one from the header.
    expect(resolveClientIp('10.0.0.1', '10.0.0.5, 10.0.0.6', t)).toBe('10.0.0.1');
  });
});

describe('resolveClientIp — normal operation', () => {
  it('returns the peer when there is no header', () => {
    expect(resolveClientIp('127.0.0.1', undefined, NO_PROXIES)).toBe('127.0.0.1');
  });

  it('returns the peer for an empty or junk header', () => {
    expect(resolveClientIp('127.0.0.1', '', NO_PROXIES)).toBe('127.0.0.1');
    expect(resolveClientIp('127.0.0.1', 'garbage, nonsense', NO_PROXIES)).toBe('127.0.0.1');
  });

  it('resolves a single hop through a loopback proxy', () => {
    expect(resolveClientIp('127.0.0.1', '203.0.113.9', NO_PROXIES)).toBe('203.0.113.9');
  });

  it('skips trusted hops appended to the right', () => {
    const t = new TrustedProxies(['10.0.0.0/8']);
    expect(resolveClientIp('127.0.0.1', '203.0.113.9, 10.0.0.5, 10.0.0.6', t)).toBe(
      '203.0.113.9',
    );
  });

  it('joins a repeated header the way proxies mean it', () => {
    expect(resolveClientIp('127.0.0.1', ['203.0.113.9', '10.0.0.5'], NO_PROXIES)).toBe(
      '10.0.0.5',
    );
  });

  it('strips ports without mangling IPv6', () => {
    expect(resolveClientIp('127.0.0.1', '203.0.113.9:51234', NO_PROXIES)).toBe('203.0.113.9');
    expect(resolveClientIp('127.0.0.1', '[2001:db8::1]:443', NO_PROXIES)).toBe('2001:db8::1');
    // A bare IPv6 address is all colons — truncating at the last one would
    // corrupt it into a different address.
    expect(resolveClientIp('127.0.0.1', '2001:db8::1', NO_PROXIES)).toBe('2001:db8::1');
  });

  it('ignores unparseable hops rather than returning them', () => {
    expect(resolveClientIp('127.0.0.1', 'garbage, 203.0.113.9', NO_PROXIES)).toBe(
      '203.0.113.9',
    );
  });

  it('finds the real client through an absurdly long header, promptly', () => {
    // The real client is always appended at the far right by our own trusted
    // proxy, however long an attacker-controlled prefix precedes it — so
    // truncation MUST keep the tail, not the head. This exact shape (many
    // spoofed loopback hops, then a real address) was a full auth bypass when
    // truncation kept the front instead: the trusted padding survived, the
    // real client was cut off, and every surviving hop being trusted made the
    // resolver fall back to the (loopback) peer — see resolveClientIp.
    const chain = `${Array(5000).fill('127.0.0.1').join(', ')}, 203.0.113.9`;
    const started = performance.now();
    const resolved = resolveClientIp('127.0.0.1', chain, NO_PROXIES);
    expect(performance.now() - started).toBeLessThan(100);
    expect(resolved).toBe('203.0.113.9');
    expect(isLoopback(resolved)).toBe(false);
  });

  it('cannot use a padded loopback prefix to push the real client out of the truncation window', () => {
    // The concrete PoC from the security audit: an attacker sends just over
    // MAX_CHAIN_ENTRIES fake loopback hops so a front-truncating slice would
    // drop the genuine client that nginx appends at the end.
    const spoofedPrefix = Array(60).fill('127.0.0.1').join(', ');
    const resolved = resolveClientIp('127.0.0.1', `${spoofedPrefix}, 203.0.113.9`, NO_PROXIES);
    expect(resolved).toBe('203.0.113.9');
    expect(isLoopback(resolved)).toBe(false);
  });

  it('falls back to the peer only when the real tail is ALSO trusted, not merely absent from a truncated view', () => {
    const t = new TrustedProxies(['10.0.0.0/8']);
    const allTrusted = Array(60).fill('10.0.0.1').join(', ');
    expect(resolveClientIp('127.0.0.1', allTrusted, t)).toBe('127.0.0.1');
  });
});
