import { request as httpRequest } from 'node:http';
import { WalletSigner, type OgmaraClient } from '@ogmara/sdk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProfileResult, RegisterResult, RegistrationStatus } from '../identity.js';
import { PanelAuth } from './auth.js';
import { type Panel, type PanelDeps, startPanel } from './server.js';
import { TrustedProxies } from './clientip.js';

/**
 * GET a path with an explicit Host header.
 *
 * `fetch`/undici forbid overriding `Host` (it's a forbidden header name per
 * the WHATWG spec) and silently substitute the URL's own host instead — so
 * testing the Host-header check at all requires dropping to raw `http`.
 */
function getWithHost(baseUrl: string, path: string, host: string): Promise<number> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const REGISTERED: RegistrationStatus = {
  registered: true,
  registeredAt: 1_700_000_000,
  balanceKlv: 50,
  canAfford: true,
};
const UNREGISTERED: RegistrationStatus = {
  registered: false,
  registeredAt: 0,
  balanceKlv: 3,
  canAfford: false,
};

let operator: WalletSigner;
let bot: WalletSigner;
let outsider: WalletSigner;

beforeAll(async () => {
  operator = await WalletSigner.generate();
  bot = await WalletSigner.generate();
  outsider = await WalletSigner.generate();
});

let panel: Panel | undefined;

afterEach(async () => {
  await panel?.close();
  panel = undefined;
});

interface StartOptions {
  adminWallets?: string[];
  registration?: RegistrationStatus;
  trustedProxyCidrs?: string[];
  checkRegistration?: PanelDeps['checkRegistration'];
  applyProfile?: PanelDeps['applyProfile'];
  registerWallet?: PanelDeps['registerWallet'];
  allowedHosts?: string[];
  requireLogin?: boolean;
}

async function start(options: StartOptions = {}): Promise<{
  panel: Panel;
  baseUrl: string;
  auth: PanelAuth;
  fns: {
    checkRegistration: ReturnType<typeof vi.fn>;
    applyProfile: ReturnType<typeof vi.fn>;
    registerWallet: ReturnType<typeof vi.fn>;
  };
}> {
  const auth = new PanelAuth({
    adminWallets: options.adminWallets ?? [operator.address],
    botAddress: bot.address,
    network: 'testnet',
    sessionTtlHours: 24,
  });

  const checkRegistrationFn = vi.fn(
    options.checkRegistration ?? (async () => options.registration ?? REGISTERED),
  );
  const applyProfileFn = vi.fn(
    options.applyProfile ?? (async (): Promise<ProfileResult> => ({ status: 'nothing-to-do' })),
  );
  const registerWalletFn = vi.fn(
    options.registerWallet ??
      (async (): Promise<RegisterResult> => ({
        status: 'registered',
        txHash: 'deadbeef',
        explorerUrl: 'https://example.test/tx/deadbeef',
      })),
  );

  const deps: PanelDeps = {
    auth,
    trustedProxies: new TrustedProxies(options.trustedProxyCidrs ?? []),
    network: 'testnet',
    client: {} as OgmaraClient, // opaque — only ever forwarded to applyProfileFn
    signer: bot,
    botAddress: bot.address,
    walletKeyHex: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
    dailyLimitFn: () => 300,
    burstLimitFn: () => 20,
    dryRunFn: () => true,
    checkRegistration: checkRegistrationFn,
    applyProfile: applyProfileFn,
    registerWallet: registerWalletFn,
    allowedHosts: options.allowedHosts ?? [],
    requireLogin: options.requireLogin ?? false,
  };

  const started = await startPanel('127.0.0.1', 0, deps);
  panel = started;
  return {
    panel: started,
    baseUrl: `http://127.0.0.1:${started.port}`,
    auth,
    fns: { checkRegistration: checkRegistrationFn, applyProfile: applyProfileFn, registerWallet: registerWalletFn },
  };
}

/** Parse a fetch response body as JSON, typed loosely for test assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

/** Full challenge → sign → login flow, returning the session cookie. */
async function loginAs(baseUrl: string, signer: WalletSigner, extraHeaders: Record<string, string> = {}) {
  const challengeRes = await fetch(`${baseUrl}/api/auth/challenge`, { headers: extraHeaders });
  const challenge = (await challengeRes.json()) as { nonce: string; message: string };
  const signature = await signer.signKleverMessage(new TextEncoder().encode(challenge.message));
  const hex = Buffer.from(signature).toString('hex');

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ address: signer.address, nonce: challenge.nonce, signature: hex }),
  });
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { loginRes, cookie, setCookieHeader: setCookie };
}

describe('static routes', () => {
  it('serves the page with a strict CSP and no inline script allowance', async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline\'; script'); // unsafe-inline must not apply to script-src
    expect(await res.text()).toContain('/app.js');
  });

  it('serves app.js as same-origin JS', async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('404s on unknown routes', async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe('localhost bypass', () => {
  it('serves /api/status with no login when the peer is loopback', async () => {
    // The test client connects via 127.0.0.1, which the default TrustedProxies
    // and isLoopback both recognise — matching the node dashboard's behavior.
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.authenticatedAs).toBe('localhost');
    expect(body.registered).toBe(true);
  });

  it('requires login once a trusted proxy reports a non-loopback client', async () => {
    // Simulates the real deployment shape: nginx runs on localhost (so the TCP
    // peer IS loopback) but forwards the actual remote client's address.
    const { baseUrl } = await start({ trustedProxyCidrs: [] }); // loopback trusted by default
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    });
    expect(res.status).toBe(401);
  });

  it('cannot be bypassed by padding X-Forwarded-For with fake loopback hops', async () => {
    // The verified PoC from the security audit: with truncation keeping the
    // wrong end of the header, 51+ spoofed "127.0.0.1" hops pushed nginx's
    // real appended client out of the truncation window, every surviving hop
    // was trusted, and the resolver fell back to the (loopback) peer — 200 on
    // /api/status with no login, and registerWallet reachable with no auth at
    // all. Both must now require a session.
    const { baseUrl, fns } = await start({ registration: UNREGISTERED });
    const spoof = `${Array(60).fill('127.0.0.1').join(', ')}, 203.0.113.9`;

    const statusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { 'X-Forwarded-For': spoof },
    });
    expect(statusRes.status).toBe(401);

    const registerRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': spoof },
      body: JSON.stringify({ confirm: true }),
    });
    expect(registerRes.status).toBe(401);
    expect(fns.registerWallet).not.toHaveBeenCalled();
  });
});

describe('login flow', () => {
  it('logs in an allowlisted wallet and reuses the session for later requests', async () => {
    const { baseUrl } = await start();
    const { loginRes, cookie } = await loginAs(baseUrl, operator, {
      'X-Forwarded-For': '203.0.113.9',
    });
    expect(loginRes.status).toBe(200);
    expect(cookie).toContain('ogmara_newsbot_session=');

    const statusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookie, 'X-Forwarded-For': '203.0.113.9' },
    });
    expect(statusRes.status).toBe(200);
    const body = await json(statusRes);
    expect(body.authenticatedAs).toBe(operator.address);
  });

  it('accepts the session via Authorization: Bearer as well as cookie', async () => {
    const { baseUrl } = await start();
    const { cookie } = await loginAs(baseUrl, operator, { 'X-Forwarded-For': '203.0.113.9' });
    const token = cookie.split('=')[1]!;
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '203.0.113.9' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wallet that is not on the allowlist', async () => {
    const { baseUrl } = await start();
    const { loginRes } = await loginAs(baseUrl, outsider, { 'X-Forwarded-For': '203.0.113.9' });
    expect(loginRes.status).toBe(401);
  });

  it('sets Secure on the cookie only when the request arrived over HTTPS', async () => {
    const { baseUrl } = await start();
    const plain = await loginAs(baseUrl, operator, { 'X-Forwarded-For': '203.0.113.9' });
    expect(plain.setCookieHeader).not.toContain('Secure');

    const https = await loginAs(baseUrl, operator, {
      'X-Forwarded-For': '203.0.113.9',
      'X-Forwarded-Proto': 'https',
    });
    expect(https.setCookieHeader).toContain('Secure');
  });

  it('rejects login without Content-Type: application/json', async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ address: operator.address, nonce: 'x', signature: 'y' }),
    });
    expect(res.status).toBe(415);
  });

  it('rejects a malformed JSON body', async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'x'.repeat(20_000), nonce: 'y', signature: 'z' }),
    });
    expect(res.status).toBe(413);
  });

  it('logs out and invalidates the session going forward', async () => {
    const { baseUrl } = await start();
    const { cookie } = await loginAs(baseUrl, operator, { 'X-Forwarded-For': '203.0.113.9' });
    await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    });
    // Logout only clears the client's own cookie jar; the token itself is
    // still valid until expiry (stateless HMAC session), so re-sending it
    // must still work — logout is a client-side forget, not a revocation.
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookie, 'X-Forwarded-For': '203.0.113.9' },
    });
    expect(res.status).toBe(200);
  });
});

describe('/api/status error mapping', () => {
  it('maps a chain-check failure to 502 rather than crashing', async () => {
    const { baseUrl } = await start({
      checkRegistration: async () => {
        throw new Error('rpc unreachable');
      },
    });
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(502);
  });

  it('reports the unregistered tier and affordability', async () => {
    const { baseUrl } = await start({ registration: UNREGISTERED });
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await json(res);
    expect(body.registered).toBe(false);
    expect(body.canAffordRegistration).toBe(false);
  });
});

describe('/api/profile', () => {
  it('accepts a display-name update from an authenticated session', async () => {
    const { baseUrl, fns } = await start();
    const res = await fetch(`${baseUrl}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'World News Bot' }),
    });
    expect(res.status).toBe(200);
    expect(fns.applyProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ displayName: 'World News Bot' }),
    );
  });

  it('rejects a non-string field without calling applyProfile', async () => {
    const { baseUrl, fns } = await start();
    const res = await fetch(`${baseUrl}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 12345 }),
    });
    expect(res.status).toBe(400);
    expect(fns.applyProfile).not.toHaveBeenCalled();
  });

  it('requires authentication for a non-local caller', async () => {
    const { baseUrl, fns } = await start();
    const res = await fetch(`${baseUrl}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ displayName: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(fns.applyProfile).not.toHaveBeenCalled();
  });
});

describe('/api/register — spends real KLV, must never fire by accident', () => {
  it('refuses without explicit confirm: true, and never calls registerWallet', async () => {
    const { baseUrl, fns } = await start({ registration: UNREGISTERED });
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(fns.registerWallet).not.toHaveBeenCalled();
  });

  it('refuses a truthy-but-not-boolean-true confirm value', async () => {
    // Guards against a client bug (or a subtly malicious one) sending
    // confirm: "true" or confirm: 1 and treating it as consent.
    const { baseUrl, fns } = await start({ registration: UNREGISTERED });
    for (const confirm of ['true', 1, 'yes']) {
      const res = await fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      });
      expect(res.status).toBe(400);
    }
    expect(fns.registerWallet).not.toHaveBeenCalled();
  });

  it('proceeds once confirm: true is sent by an authenticated caller', async () => {
    const { baseUrl, fns } = await start({ registration: UNREGISTERED });
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    expect(fns.registerWallet).toHaveBeenCalledTimes(1);
    const body = await json(res);
    expect(body.status).toBe('registered');
  });

  it('requires authentication for a non-local caller, even with confirm: true', async () => {
    const { baseUrl, fns } = await start();
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(401);
    expect(fns.registerWallet).not.toHaveBeenCalled();
  });

  it('surfaces insufficient-funds as a normal 200 result, not an error', async () => {
    const { baseUrl } = await start({
      registration: UNREGISTERED,
      registerWallet: async () => ({
        status: 'insufficient-funds',
        balanceKlv: 3,
        requiredKlv: 4.4,
      }),
    });
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe('insufficient-funds');
  });

  it('rejects a second overlapping registration attempt instead of double-spending', async () => {
    // registerWallet is check-then-act against the chain (read status, then
    // submit) with real network latency in between — long enough for a
    // second request to also observe "not registered" and also submit,
    // paying the non-refundable fee twice. A slow registerWallet stands in
    // for that latency so both requests are genuinely in flight together.
    let resolveFirst!: (r: RegisterResult) => void;
    const first = new Promise<RegisterResult>((res) => {
      resolveFirst = res;
    });
    let calls = 0;
    const { baseUrl, fns } = await start({
      registration: UNREGISTERED,
      registerWallet: async () => {
        calls++;
        return first;
      },
    });

    const post = () =>
      fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });

    const firstReq = post();
    // Give the first request time to set the in-flight flag before firing
    // the second — this is what makes it "overlapping" rather than "after".
    await new Promise((r) => setTimeout(r, 20));
    const secondRes = await post();

    expect(secondRes.status).toBe(409);
    resolveFirst({ status: 'registered', txHash: 'abc', explorerUrl: 'https://x.test' });
    expect((await firstReq).status).toBe(200);
    expect(calls).toBe(1);
    expect(fns.registerWallet).toHaveBeenCalledTimes(1);
  });

  it('allows a new registration attempt once the previous one has finished', async () => {
    const { baseUrl, fns } = await start({ registration: UNREGISTERED });
    const first = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(second.status).toBe(200);
    expect(fns.registerWallet).toHaveBeenCalledTimes(2);
  });
});

describe('malformed JSON bodies', () => {
  it.each([['null', 'null'], ['a bare string', '"hello"'], ['a number', '42'], ['an array', '[1,2,3]']])(
    'rejects %s as a login body with 400, not 500',
    async (_label, body) => {
      const { baseUrl } = await start();
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
    },
  );

  it('rejects a non-object body on /api/profile without ever calling applyProfile', async () => {
    const { baseUrl, fns } = await start();
    const res = await fetch(`${baseUrl}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
    expect(fns.applyProfile).not.toHaveBeenCalled();
  });

  it('rejects a non-object body on /api/register without ever calling registerWallet', async () => {
    const { baseUrl, fns } = await start({ registration: UNREGISTERED });
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"confirm please"',
    });
    expect(res.status).toBe(400);
    expect(fns.registerWallet).not.toHaveBeenCalled();
  });
});

describe('Host header validation (DNS rebinding defence)', () => {
  it('accepts the address the test client actually connects with', async () => {
    // Sanity check: every other test in this file depends on this passing.
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
  });

  it('rejects a Host header naming an unrelated domain', async () => {
    // A browser sends Host from the URL it navigated to, never from the IP
    // that hostname resolved to — so an attacker page whose domain's DNS
    // re-resolves to 127.0.0.1 (making it same-origin with the panel, and
    // thus immune to CORS/SameSite) still presents Host: attacker-domain.tld,
    // which this must reject even though the connection is genuinely local.
    const { baseUrl } = await start();
    expect(await getWithHost(baseUrl, '/api/status', 'attacker-domain.tld')).toBe(400);
  });

  it('accepts a configured allowedHosts entry', async () => {
    const { baseUrl } = await start({ allowedHosts: ['bot.example.internal'] });
    expect(await getWithHost(baseUrl, '/api/status', 'bot.example.internal:8787')).toBe(200);
  });

  it('applies the Host check even to the unauthenticated static routes', async () => {
    const { baseUrl } = await start();
    expect(await getWithHost(baseUrl, '/', 'attacker-domain.tld')).toBe(400);
  });
});

describe('requireLogin — escape hatch for a proxy that forwards without XFF', () => {
  it('demands a session from the loopback peer once requireLogin is set', async () => {
    const { baseUrl } = await start({ requireLogin: true });
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(401);
  });

  it('still allows a properly authenticated session through', async () => {
    const { baseUrl } = await start({ requireLogin: true });
    const { cookie } = await loginAs(baseUrl, operator);
    const res = await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });
});

describe('loopback bypass — forwarding-header presence gate', () => {
  it('refuses the bypass when XFF is present even though every hop resolves as trusted', async () => {
    // Before this gate: an attacker could send an X-Forwarded-For consisting
    // entirely of trusted addresses, causing the resolver to fall back to the
    // (loopback) peer — which then passed isLoopback and got the bypass.
    // Presence of ANY forwarding header must disqualify the bare-IP bypass.
    const { baseUrl } = await start({ trustedProxyCidrs: ['10.0.0.0/8'] });
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { 'X-Forwarded-For': '10.0.0.1, 10.0.0.2' },
    });
    expect(res.status).toBe(401);
  });

  it('still grants the bypass with no forwarding header at all', async () => {
    const { baseUrl } = await start({ trustedProxyCidrs: ['10.0.0.0/8'] });
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
  });
});
