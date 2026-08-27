import { WalletSigner } from '@ogmara/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_PENDING_CHALLENGES, PanelAuth, verifyKleverMessage } from './auth.js';

const BOT = 'klv1botwalletaddressplaceholder';
const HOUR = 3_600_000;

/**
 * A real signer, so signature tests exercise the same Klever message format a
 * live wallet produces rather than a mock that agrees with our own bug.
 */
let operator: WalletSigner;
let outsider: WalletSigner;

beforeAll(async () => {
  operator = await WalletSigner.generate();
  outsider = await WalletSigner.generate();
});

function auth(overrides: Partial<ConstructorParameters<typeof PanelAuth>[0]> = {}) {
  return new PanelAuth({
    adminWallets: [operator.address],
    botAddress: BOT,
    network: 'testnet',
    sessionTtlHours: 24,
    ...overrides,
  });
}

/** Sign a challenge exactly as a wallet extension would. */
async function sign(signer: WalletSigner, message: string): Promise<Uint8Array> {
  return signer.signKleverMessage(new TextEncoder().encode(message));
}

describe('verifyKleverMessage', () => {
  it('accepts a genuine signature', async () => {
    const msg = 'Ogmara Newsbot Login\nNonce: abc';
    expect(await verifyKleverMessage(operator.address, msg, await sign(operator, msg))).toBe(
      true,
    );
  });

  it('rejects a signature from a different wallet', async () => {
    const msg = 'Ogmara Newsbot Login\nNonce: abc';
    expect(await verifyKleverMessage(operator.address, msg, await sign(outsider, msg))).toBe(
      false,
    );
  });

  it('rejects a signature over a different message', async () => {
    const sig = await sign(operator, 'message one');
    expect(await verifyKleverMessage(operator.address, 'message two', sig)).toBe(false);
  });

  it('handles non-ASCII, where byte length and character length differ', async () => {
    // The Klever prefix commits to the BYTE length. Using `.length` on the
    // string would produce a different hash than any real wallet.
    const msg = 'Ogmara Newsbot Login\nNote: schöne Grüße — 日本語';
    expect(await verifyKleverMessage(operator.address, msg, await sign(operator, msg))).toBe(
      true,
    );
  });

  it('returns false rather than throwing on malformed input', async () => {
    const msg = 'x';
    const good = await sign(operator, msg);
    expect(await verifyKleverMessage('not-an-address', msg, good)).toBe(false);
    expect(await verifyKleverMessage(operator.address, msg, new Uint8Array(0))).toBe(false);
    expect(await verifyKleverMessage(operator.address, msg, new Uint8Array(64))).toBe(false);
  });
});

describe('PanelAuth challenges', () => {
  it('binds the challenge to this bot and network', () => {
    const challenge = auth().createChallenge()!;
    expect(challenge.message).toContain(`Bot: ${BOT}`);
    expect(challenge.message).toContain('Network: testnet');
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
  });

  it('issues a distinct nonce each time', () => {
    const a = auth();
    const seen = new Set(Array.from({ length: 20 }, () => a.createChallenge()!.nonce));
    expect(seen.size).toBe(20);
  });

  it('rebuilds the message from server state, not from the client', () => {
    const a = auth();
    const challenge = a.createChallenge()!;
    expect(a.consumeChallenge(challenge.nonce)).toBe(challenge.message);
  });

  it('consumes a nonce exactly once', () => {
    const a = auth();
    const challenge = a.createChallenge()!;
    expect(a.consumeChallenge(challenge.nonce)).toBeDefined();
    expect(a.consumeChallenge(challenge.nonce)).toBeUndefined();
  });

  it('rejects an unknown nonce', () => {
    expect(auth().consumeChallenge('deadbeef')).toBeUndefined();
  });

  it('expires a nonce after its TTL', () => {
    let now = 1_000_000;
    const a = auth({ now: () => now });
    const challenge = a.createChallenge()!;
    now += 6 * 60_000;
    expect(a.consumeChallenge(challenge.nonce)).toBeUndefined();
  });

  it('never refuses a challenge, even at capacity', () => {
    // GET /api/auth/challenge is necessarily unauthenticated (it's the entry
    // point to logging in), so refusing here would let anyone who can reach
    // the port lock every real operator out of login. Eviction, not refusal,
    // is the DoS defence — verified below.
    const a = auth();
    for (let i = 0; i < MAX_PENDING_CHALLENGES + 10; i++) {
      expect(a.createChallenge()).toBeDefined();
    }
  });

  it('evicts the oldest pending challenge once at capacity, rather than refusing', () => {
    const a = auth();
    const first = a.createChallenge();
    for (let i = 1; i < MAX_PENDING_CHALLENGES; i++) a.createChallenge();
    // The map is now full; one more push must evict `first` rather than fail.
    const overflow = a.createChallenge();
    expect(overflow).toBeDefined();
    expect(a.consumeChallenge(first.nonce)).toBeUndefined();
    expect(a.consumeChallenge(overflow.nonce)).toBeDefined();
  });
});

describe('PanelAuth login', () => {
  it('accepts an allowlisted wallet with a valid signature', async () => {
    const a = auth();
    const challenge = a.createChallenge()!;
    const sig = await sign(operator, challenge.message);
    expect(await a.login(operator.address, challenge.nonce, sig)).toBeDefined();
  });

  it('rejects a wallet that is not on the allowlist', async () => {
    const a = auth();
    const challenge = a.createChallenge()!;
    const sig = await sign(outsider, challenge.message);
    expect(await a.login(outsider.address, challenge.nonce, sig)).toBeUndefined();
  });

  it('rejects a valid signature over an attacker-chosen message', async () => {
    // The whole point of server-side message reconstruction: signing something
    // else, however genuinely, is not a login.
    const a = auth();
    const challenge = a.createChallenge()!;
    const sig = await sign(operator, 'Ogmara Newsbot Login\nBot: evil\nNonce: 00');
    expect(await a.login(operator.address, challenge.nonce, sig)).toBeUndefined();
  });

  it('cannot replay a captured login', async () => {
    const a = auth();
    const challenge = a.createChallenge()!;
    const sig = await sign(operator, challenge.message);
    expect(await a.login(operator.address, challenge.nonce, sig)).toBeDefined();
    expect(await a.login(operator.address, challenge.nonce, sig)).toBeUndefined();
  });

  it('burns the nonce even when the attempt fails', async () => {
    // Otherwise an attacker can grind signatures against one live challenge.
    const a = auth();
    const challenge = a.createChallenge()!;
    await a.login(operator.address, challenge.nonce, await sign(outsider, challenge.message));
    const sig = await sign(operator, challenge.message);
    expect(await a.login(operator.address, challenge.nonce, sig)).toBeUndefined();
  });

  it('accepts the hex form a Klever Extension returns', async () => {
    const a = auth();
    const challenge = a.createChallenge()!;
    const raw = await sign(operator, challenge.message);
    const hex = Buffer.from(raw).toString('hex');
    expect(await a.login(operator.address, challenge.nonce, hex)).toBeDefined();
  });

  it('accepts the base64-of-hex form K5 returns', async () => {
    // Per feedback_klever_signmessage_encoding: the two wallets disagree on
    // encoding, and normalizeWalletSig is what reconciles them.
    const a = auth();
    const challenge = a.createChallenge()!;
    const raw = await sign(operator, challenge.message);
    const hex = Buffer.from(raw).toString('hex');
    const k5 = Buffer.from(hex, 'utf8').toString('base64');
    expect(await a.login(operator.address, challenge.nonce, k5)).toBeDefined();
  });

  it('rejects a garbage signature without throwing', async () => {
    const a = auth();
    const challenge = a.createChallenge()!;
    expect(await a.login(operator.address, challenge.nonce, 'not-a-signature')).toBeUndefined();
  });
});

describe('PanelAuth sessions', () => {
  it('round-trips an issued session', () => {
    const a = auth();
    const { token } = a.issueSession(operator.address);
    expect(a.verifySession(token)).toBe(operator.address);
  });

  it('rejects a tampered payload', () => {
    const a = auth();
    const { token } = a.issueSession(operator.address);
    const forged = Buffer.from(
      JSON.stringify({ address: outsider.address, issuedAt: 0, expiresAt: Date.now() + HOUR }),
      'utf8',
    ).toString('base64url');
    expect(a.verifySession(`${forged}.${token.split('.')[1]}`)).toBeUndefined();
  });

  it('rejects a token signed by a different instance', () => {
    // Each process mints a fresh HMAC secret, so a restart revokes sessions.
    const { token } = auth().issueSession(operator.address);
    expect(auth().verifySession(token)).toBeUndefined();
  });

  it('rejects an expired token', () => {
    let now = 1_000_000;
    const a = auth({ now: () => now, sessionTtlHours: 1 });
    const { token } = a.issueSession(operator.address);
    now += 2 * HOUR;
    expect(a.verifySession(token)).toBeUndefined();
  });

  it('rejects a wallet removed from the allowlist', () => {
    // Re-checked per request, so editing the config and restarting genuinely
    // revokes access rather than waiting out the TTL.
    const issuer = auth();
    const { token } = issuer.issueSession(operator.address);
    const narrowed = auth({ adminWallets: [] });
    expect(narrowed.verifySession(token)).toBeUndefined();
  });

  it('rejects malformed tokens without throwing', () => {
    const a = auth();
    for (const bad of ['', '.', 'nodot', 'a.b', '.sig', 'YWJj.', '$$$.$$$']) {
      expect(a.verifySession(bad)).toBeUndefined();
    }
  });

  it('reports whether remote login is possible', () => {
    expect(auth().remoteLoginEnabled).toBe(true);
    expect(auth({ adminWallets: [] }).remoteLoginEnabled).toBe(false);
  });
});
