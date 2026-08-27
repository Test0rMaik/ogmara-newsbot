/**
 * Control-panel authentication — wallet-signature login, no passwords.
 *
 * This mirrors the l2-node dashboard's model (node spec §5): the bot keeps its
 * own wallet, and the config names a separate set of wallets allowed to *drive*
 * it. An operator proves ownership of one of those wallets by signing a
 * one-time challenge; the resulting session lets them take actions that the
 * bot then performs **with the bot's own wallet**. The operator's wallet is
 * an authorisation credential only — its key never leaves their extension, and
 * the bot never sees it.
 *
 * Three properties do the actual security work here, and all three are easy to
 * lose in a rewrite:
 *
 * 1. **The client never supplies the string it signed.** `consumeChallenge`
 *    rebuilds the message from server-held state keyed by nonce. If the client
 *    sent the message, an attacker could get a wallet to sign text of their
 *    choosing and present it as a login.
 * 2. **Nonces are single-use and expire.** `consumeChallenge` removes the entry
 *    before it can succeed, so a captured login body cannot be replayed.
 * 3. **The challenge is bound to this bot and this network.** A signature
 *    harvested by one bot is useless against another, and a testnet login
 *    cannot be replayed against a mainnet instance. (Same reasoning as the
 *    2026-08-16 C1 audit finding: a signature that is the sole authority for an
 *    action must carry its own network binding.)
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { addressToPubkey, normalizeWalletSig } from '@ogmara/sdk';

/** How long a challenge nonce stays valid. Matches the node dashboard. */
export const NONCE_TTL_MS = 5 * 60_000;

/**
 * Cap on unconsumed challenges held in memory.
 *
 * `GET /auth/challenge` is necessarily unauthenticated — it is the entry point
 * to logging in — so without a cap it is a free memory-growth primitive for
 * anyone who can reach the port. Reaching the cap evicts the oldest pending
 * challenge rather than refusing the new one — see `createChallenge`.
 */
export const MAX_PENDING_CHALLENGES = 100;

/**
 * Klever message-signing prefix: 0x17 (23, the length of the label) followed by
 * the label itself. Must match the SDK's `signKleverMessage` byte for byte or
 * no real wallet signature will ever verify.
 */
const KLEVER_MSG_PREFIX = new Uint8Array([
  23,
  ...new TextEncoder().encode('Klever Signed Message:\n'),
]);

/**
 * Verify a Klever-format message signature against a bech32 address.
 *
 * Format: `prefix || byteLength || message` → Keccak-256 → Ed25519 verify.
 * The length is the *byte* count of the encoded message, not its character
 * count — they differ for any non-ASCII input.
 *
 * Uses the async Ed25519 API deliberately: the sync API requires wiring
 * `etc.sha512Sync` on the module instance before first use, which is global
 * mutable state we would rather not depend on.
 *
 * @returns `true` only for a valid signature; never throws for malformed input.
 */
export async function verifyKleverMessage(
  address: string,
  message: string,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const pubkey = addressToPubkey(address);
    const encoded = new TextEncoder().encode(message);
    const lengthStr = new TextEncoder().encode(encoded.length.toString());

    const data = new Uint8Array(KLEVER_MSG_PREFIX.length + lengthStr.length + encoded.length);
    data.set(KLEVER_MSG_PREFIX, 0);
    data.set(lengthStr, KLEVER_MSG_PREFIX.length);
    data.set(encoded, KLEVER_MSG_PREFIX.length + lengthStr.length);

    return await ed.verifyAsync(signature, keccak_256(data), pubkey);
  } catch {
    // A bad address, a wrong-length signature or a non-canonical point all
    // land here. They are all simply "not authenticated".
    return false;
  }
}

/** A challenge awaiting its signature. */
interface PendingChallenge {
  timestampMs: number;
  createdAt: number;
}

/** What a valid session token carries. */
interface SessionPayload {
  address: string;
  issuedAt: number;
  expiresAt: number;
}

/** Options for {@link PanelAuth}. */
export interface PanelAuthOptions {
  /** Wallets permitted to log in. Empty disables remote login entirely. */
  adminWallets: readonly string[];
  /** The bot's own wallet address — binds challenges to this instance. */
  botAddress: string;
  /** Klever network the bot is attached to. */
  network: string;
  /** Session lifetime in hours. */
  sessionTtlHours: number;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Challenge/response login and session issuance.
 *
 * The HMAC secret is generated per process, so restarting the bot invalidates
 * every outstanding session. That is intentional — it gives an operator a
 * guaranteed way to revoke access (restart) without any session store.
 */
export class PanelAuth {
  readonly #challenges = new Map<string, PendingChallenge>();
  readonly #hmacSecret = randomBytes(32);
  readonly #adminWallets: readonly string[];
  readonly #botAddress: string;
  readonly #network: string;
  readonly #sessionTtlHours: number;
  readonly #now: () => number;

  constructor(options: PanelAuthOptions) {
    this.#adminWallets = options.adminWallets;
    this.#botAddress = options.botAddress;
    this.#network = options.network;
    this.#sessionTtlHours = options.sessionTtlHours;
    this.#now = options.now ?? Date.now;
  }

  /** Whether any wallet is authorised, i.e. whether remote login is possible. */
  get remoteLoginEnabled(): boolean {
    return this.#adminWallets.length > 0;
  }

  /** Session lifetime in hours, for cookie `Max-Age` and the login response. */
  get sessionTtlHours(): number {
    return this.#sessionTtlHours;
  }

  /**
   * Mint a challenge for the client to sign.
   *
   * Always succeeds. `GET /api/auth/challenge` is necessarily unauthenticated
   * — it's the entry point to logging in — so refusing once the cap is hit
   * would let anyone who can reach the port lock every real operator out of
   * login for as long as they keep sending requests (~20/minute keeps the map
   * permanently full). Evicting the oldest pending challenge instead costs
   * nothing an attacker can exploit: nonces are single-use, unguessable and
   * self-expiring, so the worst case is a legitimate in-flight challenge
   * being evicted, which the UI already recovers from by fetching a new one
   * on any login failure.
   */
  createChallenge(): { nonce: string; timestamp: number; message: string } {
    const now = this.#now();

    // Prune first, so a burst of abandoned challenges cannot force eviction of
    // ones that are still legitimately live.
    for (const [nonce, challenge] of this.#challenges) {
      if (now - challenge.createdAt > NONCE_TTL_MS) this.#challenges.delete(nonce);
    }
    if (this.#challenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.#challenges.keys().next().value;
      if (oldest !== undefined) this.#challenges.delete(oldest);
    }

    const nonce = randomBytes(32).toString('hex');
    this.#challenges.set(nonce, { timestampMs: now, createdAt: now });
    return { nonce, timestamp: now, message: this.#buildMessage(nonce, now) };
  }

  /**
   * Consume a nonce and return the exact message that was issued for it.
   *
   * Removes the nonce whether or not the caller goes on to authenticate, so a
   * failed attempt cannot be retried against the same challenge.
   */
  consumeChallenge(nonce: string): string | undefined {
    const challenge = this.#challenges.get(nonce);
    if (challenge === undefined) return undefined;
    this.#challenges.delete(nonce);
    if (this.#now() - challenge.createdAt > NONCE_TTL_MS) return undefined;
    return this.#buildMessage(nonce, challenge.timestampMs);
  }

  /** Whether an address appears in the configured allowlist. */
  isAdminWallet(address: string): boolean {
    return this.#adminWallets.includes(address);
  }

  /**
   * Full login check: consume the nonce, verify the wallet is allowed, and
   * verify the signature over the server's own copy of the message.
   *
   * The allowlist check runs *before* signature verification only to avoid
   * wasted work; both must pass, and the caller must not distinguish the two
   * failures to a remote client.
   */
  async login(
    address: string,
    nonce: string,
    signature: string | Uint8Array,
  ): Promise<{ token: string; expiresAt: number } | undefined> {
    const message = this.consumeChallenge(nonce);
    if (message === undefined) return undefined;
    if (!this.isAdminWallet(address)) return undefined;

    let sigBytes: Uint8Array;
    try {
      // The Klever Extension returns hex and K5 returns base64-of-hex; the SDK
      // normalises both to raw bytes. Never compare the string forms.
      sigBytes = normalizeWalletSig(signature);
    } catch {
      return undefined;
    }

    if (!(await verifyKleverMessage(address, message, sigBytes))) return undefined;
    return this.issueSession(address);
  }

  /** Issue a session token for an already-authenticated address. */
  issueSession(address: string): { token: string; expiresAt: number } {
    const issuedAt = this.#now();
    const expiresAt = issuedAt + this.#sessionTtlHours * 3_600_000;
    const payload: SessionPayload = { address, issuedAt, expiresAt };

    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = this.#hmacSign(body);
    return { token: `${body}.${sig}`, expiresAt };
  }

  /** Verify a session token, returning the authenticated address. */
  verifySession(token: string): string | undefined {
    const dot = token.indexOf('.');
    if (dot <= 0) return undefined;

    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!constantTimeEqual(sig, this.#hmacSign(body))) return undefined;

    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    } catch {
      return undefined;
    }

    if (typeof payload.address !== 'string' || typeof payload.expiresAt !== 'number') {
      return undefined;
    }
    if (this.#now() > payload.expiresAt) return undefined;

    // Re-check the allowlist on every request rather than trusting the token
    // alone: removing a wallet from the config and restarting must revoke it,
    // and a still-valid token must not outlive that removal.
    if (!this.isAdminWallet(payload.address)) return undefined;

    return payload.address;
  }

  /**
   * The canonical string an operator's wallet signs.
   *
   * `Bot` and `Network` are the replay bindings — see the module comment.
   */
  #buildMessage(nonce: string, timestampMs: number): string {
    return (
      'Ogmara Newsbot Login\n' +
      `Bot: ${this.#botAddress}\n` +
      `Network: ${this.#network}\n` +
      `Nonce: ${nonce}\n` +
      `Timestamp: ${timestampMs}`
    );
  }

  #hmacSign(data: string): string {
    return createHmac('sha256', this.#hmacSecret).update(data).digest('base64url');
  }
}

/** Length-safe constant-time string comparison. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; compare lengths first and still run the constant-time check.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
