/**
 * Thin wrapper over `@ogmara/sdk` holding everything the bot needs to publish.
 *
 * The SDK already handles envelope construction, signing, host-bound auth
 * headers and the one-time proof-of-work gate (it auto-solves a `pow_required`
 * 429 and retries). This wrapper adds only what the SDK deliberately leaves to
 * the caller: a local posting budget, plain rate-limit 429 handling, and
 * payload validation against the protocol caps before anything is signed.
 */

import { OgmaraClient, WalletSigner } from '@ogmara/sdk';
import { MAX_CONTENT_CHARS, MAX_TITLE_BYTES, type Config, type Secrets } from './config.js';

const UTF8 = new TextEncoder();

// Re-exported so the pipeline enforces the protocol cap without importing the
// config module for a constant.
export { MAX_TITLE_BYTES } from './config.js';

/** A post ready to publish, already tag-normalized. */
export interface ComposedPost {
  title: string;
  content: string;
  tags: string[];
}

/** Outcome of a publish attempt. */
export type PublishResult =
  | { status: 'published'; msgId: string }
  | { status: 'dry-run' }
  | { status: 'rate-limited'; retryAfterMs: number };

/** Raised when a post violates a protocol cap. Never retried — it won't get better. */
export class InvalidPostError extends Error {
  override readonly name = 'InvalidPostError';
}

/**
 * Token-bucket limiter for the bot's own cadence.
 *
 * This exists so the bot self-throttles *before* hitting the node, rather than
 * discovering the limit through rejections. Node-side limits are enforced per
 * ingress node and are invisible over the API, so the bot cannot query its
 * remaining budget — it has to track its own.
 */
export class RateBudget {
  #capacity: number;
  #tokens: number;
  #refillPerMs: number;
  #lastRefill: number;

  constructor(postsPerHour: number, now: number = Date.now()) {
    // Burst of one: the bot should spread posts out, not fire a backlog at once.
    this.#capacity = 1;
    this.#tokens = 1;
    this.#refillPerMs = postsPerHour / 3_600_000;
    this.#lastRefill = now;
  }

  /** Consume a token if available. Returns false (without consuming) if not. */
  tryConsume(now: number = Date.now()): boolean {
    this.#refill(now);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /** Milliseconds until the next token is available; 0 if one is ready now. */
  msUntilNext(now: number = Date.now()): number {
    this.#refill(now);
    if (this.#tokens >= 1) return 0;
    return Math.ceil((1 - this.#tokens) / this.#refillPerMs);
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefill = now;
  }
}

/**
 * Extract an HTTP status code from an SDK error.
 *
 * The SDK throws `Error("API error (429): ...")` for non-OK responses rather
 * than a typed error, so the status has to be recovered from the message. This
 * is string-matching against another package's format and will silently stop
 * working if that format changes — hence one place, and a fallback that treats
 * an unrecognized error as non-retryable rather than guessing.
 */
export function httpStatusFromError(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = /^API error \((\d{3})\)/.exec(err.message);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

/** Validate a composed post against the protocol caps (spec §3.5). */
export function validatePost(post: ComposedPost): void {
  const titleBytes = UTF8.encode(post.title).length;
  if (titleBytes === 0) throw new InvalidPostError('post title is empty');
  if (titleBytes > MAX_TITLE_BYTES) {
    throw new InvalidPostError(
      `title is ${titleBytes} bytes, protocol maximum is ${MAX_TITLE_BYTES}`,
    );
  }
  if (post.content.length === 0) throw new InvalidPostError('post content is empty');
  if (post.content.length > MAX_CONTENT_CHARS) {
    throw new InvalidPostError(
      `content is ${post.content.length} characters, protocol maximum is ${MAX_CONTENT_CHARS}`,
    );
  }
}

/** Node identity and capabilities, read once at startup. */
export interface NodeHealth {
  version: string;
  peers: number;
  /** False when the node has no reachable IPFS backend — image posts must be skipped. */
  mediaUploads: boolean;
}

/** Publishes composed posts to an Ogmara node. */
export class OgmaraPublisher {
  readonly #client: OgmaraClient;
  readonly #signer: WalletSigner;
  readonly #config: Config;
  readonly #budget: RateBudget;

  private constructor(client: OgmaraClient, signer: WalletSigner, config: Config) {
    this.#client = client;
    this.#signer = signer;
    this.#config = config;
    this.#budget = new RateBudget(config.posting.maxPostsPerHour);
  }

  /** Build a publisher, deriving the bot's wallet address from its key. */
  static async create(config: Config, secrets: Secrets): Promise<OgmaraPublisher> {
    const signer = await WalletSigner.fromHex(secrets.walletKeyHex);
    const client = new OgmaraClient({
      nodeUrl: config.node.url,
      timeout: config.node.timeoutMs,
    }).withSigner(signer);

    // Surface the one-time PoW solve rather than letting the bot look hung —
    // it takes a couple of seconds and happens on the very first post.
    client.onPowStart = (): void => {
      console.log('  solving one-time proof-of-work for this wallet…');
    };
    client.onPowComplete = (ms: number): void => {
      console.log(`  proof-of-work solved in ${ms} ms`);
    };

    return new OgmaraPublisher(client, signer, config);
  }

  /** The bot's wallet address — the identity every post is attributed to. */
  get address(): string {
    return this.#signer.address;
  }

  /** Check the node is reachable and report its capabilities. */
  async health(): Promise<NodeHealth> {
    const raw = await this.#client.health();
    return {
      version: raw.version,
      peers: raw.peers,
      // Nodes older than 0.48.7 omit the field entirely; absence means
      // "no signal", which the spec says to treat as available.
      mediaUploads: raw.media_uploads !== false,
    };
  }

  /** Milliseconds until the bot's own budget allows another post. */
  msUntilNextSlot(): number {
    return this.#budget.msUntilNext();
  }

  /**
   * Publish a post, honouring dry-run and the local rate budget.
   *
   * Throws {@link InvalidPostError} for payloads that can never succeed, and
   * rethrows transport errors. A node-side rate limit comes back as a
   * `rate-limited` result rather than an exception, since it is expected and
   * the caller should re-queue rather than treat it as failure.
   */
  async publish(post: ComposedPost): Promise<PublishResult> {
    validatePost(post);

    if (this.#config.posting.dryRun) {
      return { status: 'dry-run' };
    }

    if (!this.#budget.tryConsume()) {
      return { status: 'rate-limited', retryAfterMs: this.#budget.msUntilNext() };
    }

    try {
      const { msg_id } = await this.#client.postNews(post.title, post.content, {
        tags: post.tags,
      });
      return { status: 'published', msgId: msg_id };
    } catch (err) {
      if (httpStatusFromError(err) === 429) {
        // The node disagrees with our budget — most likely this wallet posted
        // from elsewhere, or the node's limit is lower than configured. Back
        // off for a full node window rather than retrying into the same wall.
        const retryAfterMs = Math.ceil(3_600_000 / this.#config.posting.nodeNewsLimitPerHour);
        return { status: 'rate-limited', retryAfterMs };
      }
      throw err;
    }
  }
}
