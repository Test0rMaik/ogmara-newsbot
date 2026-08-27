/**
 * The control panel HTTP server.
 *
 * Trust model (per operator direction, matching the l2-node dashboard —
 * node spec §5): the bot holds its own wallet and performs every action with
 * it. `panel.adminWallets` names *separate* operator wallets allowed to log in
 * and drive those actions. An operator's wallet key never reaches the bot —
 * it only ever signs a login challenge in their own extension/K5.
 *
 * No framework: this is a handful of routes behind one auth check, and a
 * dependency here is a dependency in everyone's self-hosted bot.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OgmaraClient, ScNetwork, WalletSigner } from '@ogmara/sdk';
import type { ProfileResult, ProfileSpec, RegisterResult, RegistrationStatus } from '../identity.js';
import { REGISTRATION_COST_KLV } from '../klever.js';
import { PanelAuth } from './auth.js';
import { TrustedProxies, isLoopback, resolveClientIp } from './clientip.js';
import { renderPage, renderScript } from './ui.js';

/** Largest request body accepted. Every panel action fits in a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * What the panel needs from the running bot to serve requests.
 *
 * The three identity operations are injected as functions — rather than
 * imported from `identity.ts` directly — for the same reason `RateBudget`
 * takes an injectable `now` and `ImageDirSource` an injectable `random`: it
 * lets tests exercise the real routing, auth and error-mapping logic without
 * a live chain, using fakes instead of network mocks.
 */
export interface PanelDeps {
  auth: PanelAuth;
  trustedProxies: TrustedProxies;
  network: ScNetwork;
  client: OgmaraClient;
  signer: WalletSigner;
  botAddress: string;
  /** Raw wallet key, for the one action (`registerWallet`) that needs it directly. */
  walletKeyHex: string;
  dailyLimitFn: () => number;
  burstLimitFn: () => number;
  dryRunFn: () => boolean;
  checkRegistration: (network: ScNetwork, address: string) => Promise<RegistrationStatus>;
  applyProfile: (client: OgmaraClient, spec: ProfileSpec) => Promise<ProfileResult>;
  registerWallet: (
    network: ScNetwork,
    signer: WalletSigner,
    privateKey: Uint8Array,
  ) => Promise<RegisterResult>;
  /**
   * Hostnames (without port) additionally accepted by the `Host` header
   * check, beyond the always-allowed `localhost` / `127.0.0.1` / `::1`.
   * Required when `bind` is not loopback, or every request 400s — see
   * config.ts's superRefine, which enforces that pairing.
   */
  allowedHosts: readonly string[];
  /**
   * Disable the localhost bypass entirely, so every route — including from
   * 127.0.0.1 — needs a signed-in session. An escape hatch for an operator
   * who knows their reverse proxy forwards to the bot without ever setting
   * X-Forwarded-For (undetectable from the HTTP side — see clientip.ts).
   */
  requireLogin: boolean;
  /**
   * Whether a bot-generated wallet key is still awaiting the operator's
   * backup confirmation (see `walletBackup.ts`). Surfaced on `/api/status`
   * so the UI can keep showing a reminder banner across restarts — a
   * one-time terminal message at generation time is easy to miss entirely.
   */
  isWalletBackupPending: () => boolean;
  /** Record that the operator has confirmed the backup. */
  acknowledgeWalletBackup: () => void;
}

/** Per-instance mutable state, kept out of PanelDeps because it isn't config. */
interface PanelState {
  /**
   * True while a registration transaction is in flight.
   *
   * `registerWallet` is check-then-act against the chain (read current status,
   * then submit) with real network latency in between. Two overlapping
   * requests — a slow double-click, a retried curl, two open tabs — would
   * both observe "not yet registered" and both submit, spending the
   * non-refundable registration fee twice for one registration. This flag
   * makes the second request fail fast instead of racing the first.
   */
  registering: boolean;
}

/** A running panel instance. */
export interface Panel {
  readonly port: number;
  close: () => Promise<void>;
}

/** JSON body shapes accepted by the mutating endpoints, checked by hand at the call site. */
interface LoginBody {
  address?: unknown;
  nonce?: unknown;
  signature?: unknown;
}
interface ProfileBody {
  displayName?: unknown;
  bio?: unknown;
  avatarCid?: unknown;
}
interface RegisterBody {
  confirm?: unknown;
}

/**
 * Start the panel server.
 *
 * @param bind Interface to listen on.
 * @param port Port to listen on.
 */
export function startPanel(bind: string, port: number, deps: PanelDeps): Promise<Panel> {
  const state: PanelState = { registering: false };

  const server = createServer((req, res) => {
    void handle(req, res, deps, state).catch((err) => {
      console.error('panel: unhandled error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  // Every panel request is sub-second local work; there is no legitimate
  // reason for Node's 5-minute default `requestTimeout` here, and that
  // default is exactly what lets a handful of slow-drip connections exhaust
  // file descriptors on a process that also needs sockets for its node/AI/RSS
  // calls. `maxConnections` bounds the same risk at the connection level.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 100;

  return new Promise((resolve, reject) => {
    // `once` so this listener is gone by the time `listen` succeeds — a
    // startup failure (most commonly EADDRINUSE) should reject the promise,
    // but a server-level error afterwards must not be silently absorbed by a
    // long-settled reject().
    const onStartupError = (err: NodeJS.ErrnoException): void => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`panel.port ${port} is already in use on ${bind}`)
          : err,
      );
    };
    server.once('error', onStartupError);

    server.listen(port, bind, () => {
      server.removeListener('error', onStartupError);
      server.on('error', (err) => {
        console.error('panel: server error:', err instanceof Error ? err.message : err);
      });

      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // `close()` alone waits for every in-flight request to finish —
            // including a slow-loris connection that never will — which
            // would otherwise turn Ctrl-C / SIGTERM into an apparent hang and
            // risk a systemd SIGKILL that skips the ledger/queue flush.
            // Idle keep-alives close immediately; anything still open after
            // a short grace period gets forced.
            server.closeIdleConnections();
            const forceTimer = setTimeout(() => server.closeAllConnections(), 2000);
            forceTimer.unref();
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PanelDeps,
  state: PanelState,
): Promise<void> {
  // Checked before anything else, for every route: a browser always sends
  // `Host` from the URL it navigated to, never from the IP that hostname
  // resolved to. So this defeats DNS rebinding — a page at an attacker's
  // domain whose DNS re-resolves to 127.0.0.1 becomes same-origin with the
  // panel (defeating both CORS and the loopback-bypass network boundary),
  // but its requests still carry `Host: attacker-domain`, which this rejects.
  if (!isAllowedHost(req.headers.host, deps.allowedHosts)) {
    sendJson(res, 400, { error: 'invalid Host header' });
    return;
  }

  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://panel.invalid');
  const path = url.pathname;

  const peerIp = req.socket.remoteAddress ?? '';
  const clientIp = resolveClientIp(peerIp, req.headers['x-forwarded-for'], deps.trustedProxies);
  // A forwarding header of ANY kind — even one that ultimately resolves back
  // to loopback — means something between us and the client is proxying, and
  // a bare loopback *peer* address is no longer sufficient evidence that the
  // request originated locally: an attacker padding X-Forwarded-For could
  // otherwise game the resolver into falling back to the (trusted) peer. Only
  // a connection with NO forwarding signal at all gets the bypass from IP
  // alone. This does not cover a proxy that forwards without adding any such
  // header — that is undetectable from HTTP alone; `requireLogin` is the
  // escape hatch for that deployment shape.
  const proxied =
    req.headers['x-forwarded-for'] !== undefined ||
    req.headers['x-real-ip'] !== undefined ||
    req.headers['forwarded'] !== undefined;
  const local = !deps.requireLogin && isLoopback(clientIp) && !proxied;

  // ── Unauthenticated routes ──────────────────────────────────────────
  if (method === 'GET' && path === '/') {
    sendHtml(res, 200, renderPage({ botAddress: deps.botAddress, network: deps.network }));
    return;
  }
  if (method === 'GET' && path === '/app.js') {
    sendScript(res, renderScript());
    return;
  }
  if (method === 'GET' && path === '/api/auth/challenge') {
    // createChallenge() always succeeds (it evicts the oldest pending
    // challenge under pressure rather than refusing) specifically so this
    // unauthenticated, necessarily-open endpoint can't be used to lock
    // legitimate operators out of logging in — see auth.ts.
    const challenge = deps.auth.createChallenge();
    sendJson(res, 200, { nonce: challenge.nonce, message: challenge.message });
    return;
  }
  if (method === 'POST' && path === '/api/auth/login') {
    if (!requireJsonContentType(req, res)) return;
    const body = await readJsonBody<LoginBody>(req, res);
    if (body === undefined) return;
    if (
      typeof body.address !== 'string' ||
      typeof body.nonce !== 'string' ||
      typeof body.signature !== 'string'
    ) {
      // Wallet providers return the signature as a string (hex, or K5's
      // base64-of-hex) — see normalizeWalletSig. Never anything else over JSON.
      sendJson(res, 400, { error: 'address, nonce and signature (string) are required' });
      return;
    }
    const session = await deps.auth.login(body.address, body.nonce, body.signature);
    if (session === undefined) {
      sendJson(res, 401, { error: 'login failed — wrong wallet, bad signature, or expired nonce' });
      return;
    }
    setSessionCookie(req, res, session.token, deps.auth.sessionTtlHours, deps.trustedProxies);
    sendJson(res, 200, { address: body.address, expiresAt: session.expiresAt });
    return;
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    // No real damage from a forged logout (it only clears the CALLER's own
    // cookie — see the comment at clearSessionCookie), but gated for
    // consistency with every other state-changing route rather than leaving
    // one silent exception to explain later.
    if (!requireJsonContentType(req, res)) return;
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Everything else requires the localhost bypass or a valid session ──
  const sessionAddress = local ? undefined : verifySession(req, deps.auth);
  if (!local && sessionAddress === undefined) {
    sendJson(res, 401, { error: 'not authenticated' });
    return;
  }

  if (method === 'GET' && path === '/api/status') {
    // Computed before the chain call and included in BOTH outcomes below —
    // this has no network dependency, and the backup reminder exists
    // specifically to survive things going wrong (see walletBackup.ts). A
    // node/chain outage must not be able to silently suppress the one
    // durable reminder that a freshly generated key still needs backing up.
    const walletBackupPending = deps.isWalletBackupPending();
    const authenticatedAs = sessionAddress ?? 'localhost';

    let registration;
    try {
      registration = await deps.checkRegistration(deps.network, deps.botAddress);
    } catch (err) {
      sendJson(res, 502, {
        error: `could not reach the chain: ${err instanceof Error ? err.message : String(err)}`,
        walletBackupPending,
        authenticatedAs,
      });
      return;
    }
    sendJson(res, 200, {
      botAddress: deps.botAddress,
      network: deps.network,
      dryRun: deps.dryRunFn(),
      dailyLimit: deps.dailyLimitFn(),
      burstLimit: deps.burstLimitFn(),
      registered: registration.registered,
      registeredAt: registration.registeredAt,
      balanceKlv: registration.balanceKlv,
      canAffordRegistration: registration.canAfford,
      registrationCostKlv: REGISTRATION_COST_KLV,
      authenticatedAs,
      walletBackupPending,
    });
    return;
  }

  if (method === 'POST' && path === '/api/wallet/ack-backup') {
    if (!requireJsonContentType(req, res)) return;
    // No body fields needed — reading one anyway keeps this consistent with
    // every other mutating route (JSON-only, size-capped) rather than being
    // the one exception a future change could silently regress.
    const body = await readJsonBody<Record<string, never>>(req, res);
    if (body === undefined) return;
    deps.acknowledgeWalletBackup();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && path === '/api/profile') {
    if (!requireJsonContentType(req, res)) return;
    const body = await readJsonBody<ProfileBody>(req, res);
    if (body === undefined) return;
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && typeof value !== 'string') {
        sendJson(res, 400, { error: `"${key}" must be a string` });
        return;
      }
    }
    const spec = {
      displayName: body.displayName as string | undefined,
      bio: body.bio as string | undefined,
      avatarCid: body.avatarCid as string | undefined,
    };
    try {
      const result = await deps.applyProfile(deps.client, spec);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, {
        error: `profile update failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }

  if (method === 'POST' && path === '/api/register') {
    if (!requireJsonContentType(req, res)) return;
    const body = await readJsonBody<RegisterBody>(req, res);
    if (body === undefined) return;
    // Spends real, non-refundable KLV. `confirm: true` must be sent
    // deliberately by the UI's confirmation step — this must never fire as a
    // side effect of any other action or default value.
    if (body.confirm !== true) {
      sendJson(res, 400, {
        error: 'registration spends real KLV and cannot be undone — resend with confirm: true',
      });
      return;
    }
    // registerWallet reads on-chain status, then submits — real network
    // latency sits between those two steps, wide enough for a second request
    // (a slow double-click, a retried curl, two open tabs) to also observe
    // "not yet registered" and also submit, paying the fee twice for one
    // registration. This turns the second overlapping request into a fast,
    // explicit 409 instead of a silent double-spend.
    if (state.registering) {
      sendJson(res, 409, { error: 'a registration is already in progress' });
      return;
    }
    state.registering = true;
    try {
      const key = hexToKey(deps.walletKeyHex);
      const result = await deps.registerWallet(deps.network, deps.signer, key);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, {
        error: `registration failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      state.registering = false;
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/**
 * Decode a 64-char hex wallet key to raw bytes.
 *
 * `loadSecrets` already enforces the `/^[0-9a-fA-F]{64}$/` shape, but that
 * guarantee lives three files away; checking it again here means this
 * function can't silently turn a malformed key into 32 zero bytes (a short or
 * non-hex string would otherwise NaN-coerce per byte) if that guarantee is
 * ever weakened or this function is reused from somewhere else.
 */
function hexToKey(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('wallet key must be 64 hex characters');
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether a `Host` header names an address this panel should answer to.
 *
 * Defeats DNS rebinding: a browser sends `Host` from the URL it navigated to,
 * never from whatever address that hostname resolved to, so an attacker
 * domain that re-resolves to 127.0.0.1 still shows up here as the attacker's
 * hostname, not as "localhost". Compares by hostname only (port ignored) —
 * the loopback family is the security boundary here, not the port, and
 * ignoring it sidesteps having to know the actual bound port (relevant for
 * ephemeral test ports) for no security cost.
 */
function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (hostHeader === undefined) return false;
  const hostname = hostnameOf(hostHeader);
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  return allowedHosts.some((h) => hostnameOf(h) === hostname);
}

/** Strip a `:port` suffix from a `Host`-header-shaped value, IPv6-bracket aware. */
function hostnameOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? trimmed : trimmed.slice(1, close);
  }
  // A bare (unbracketed) IPv6 address has more than one colon; only a single
  // colon means "host:port", which is the only case that should be split.
  const firstColon = trimmed.indexOf(':');
  const lastColon = trimmed.lastIndexOf(':');
  return firstColon !== -1 && firstColon === lastColon ? trimmed.slice(0, firstColon) : trimmed;
}

/**
 * Require `Content-Type: application/json` on state-changing requests.
 *
 * Defense in depth alongside `SameSite=Lax`: a plain cross-site HTML form
 * cannot set this header, so even a browser that mishandles `SameSite`
 * cannot trigger these endpoints via a bare form submission.
 */
function requireJsonContentType(req: IncomingMessage, res: ServerResponse): boolean {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().includes('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
}

/** Read and parse a JSON body, enforcing the size cap. Writes the error response itself on failure. */
function readJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    // Destroying the request also destroys its socket, which tears down the
    // TCP connection before the 413 response can be flushed — the client then
    // sees a bare connection reset instead of the error body. So on overflow
    // we still write a proper response and just stop accumulating; the
    // request keeps draining in the background so the connection can close
    // (or be reused) cleanly once the client finishes writing.
    const fail = (status: number, message: string): void => {
      if (settled) return;
      settled = true;
      sendJson(res, status, { error: message });
      resolve(undefined);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(413, 'request body too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value: unknown = text.length === 0 ? {} : JSON.parse(text);
        // JSON.parse accepts any value, not just objects — a body of `null`,
        // `"str"`, `42` or `[1,2]` all parse cleanly. Every route handler
        // then does `body.someField`, which throws on `null` (a TypeError
        // that only the outer .catch in startPanel saves from crashing the
        // process) and silently ignores every field on a non-object. An
        // unauthenticated caller could turn the first case into a 500 (and a
        // console.error) per request for free; reject both here instead.
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          sendJson(res, 400, { error: 'request body must be a JSON object' });
          resolve(undefined);
          return;
        }
        resolve(value as T);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        resolve(undefined);
      }
    });
    req.on('error', () => fail(400, 'error reading request body'));
  });
}

/** Extract and verify the session token from cookie or bearer header. */
function verifySession(req: IncomingMessage, auth: PanelAuth): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return auth.verifySession(authHeader.slice(7));
  }
  const cookie = req.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'ogmara_newsbot_session') {
      return auth.verifySession(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Whether the client actually arrived over HTTPS, directly or via a trusted
 * terminating proxy.
 *
 * The `Secure` cookie attribute is what stops a session token leaking over a
 * plaintext connection — but setting it unconditionally breaks the common
 * "reach the panel at http://192.168.1.50:8787" LAN setup: the browser drops
 * the cookie silently, and login appears to succeed while every following
 * request 401s with no visible reason. So this is checked, not assumed.
 */
function isHttps(req: IncomingMessage, trusted: TrustedProxies): boolean {
  const peerIp = req.socket.remoteAddress ?? '';
  if ('encrypted' in req.socket && req.socket.encrypted === true) return true;
  if (!trusted.trusts(peerIp)) return false;
  const proto = req.headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto?.split(',')[0];
  return first?.trim().toLowerCase() === 'https';
}

function setSessionCookie(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  ttlHours: number,
  trusted: TrustedProxies,
): void {
  const secure = isHttps(req, trusted) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `ogmara_newsbot_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlHours * 3600}${secure}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    'ogmara_newsbot_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // Defence in depth: the panel never intends to serve fetched JSON as HTML,
    // but if a browser did sniff, mismatched Content-Type is a stored-XSS lever.
    'X-Content-Type-Options': 'nosniff',
    // /api/status and the login response carry per-operator data and, for
    // login, a Set-Cookie with the session token — never let a caching
    // intermediary retain either.
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * `script-src 'self'` with no `unsafe-inline` — the page's only script is
 * `/app.js`, served from this same origin, which is exactly what lets the CSP
 * be this strict. `style-src 'unsafe-inline'` remains for the page's one
 * `<style>` block; that is a far weaker injection vector than script and not
 * worth a third file to eliminate.
 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

function sendScript(res: ServerResponse, script: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(script),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
  });
  res.end(script);
}
