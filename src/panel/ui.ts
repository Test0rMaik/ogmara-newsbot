/**
 * The control panel's browser UI.
 *
 * Deliberately no build step, no framework, no dependency: this whole panel is
 * one HTML page and one script file, generated as strings. Anyone cloning this
 * bot to self-host it should be able to read the entire client in one file.
 *
 * The page and script are served as two routes rather than one inline
 * `<script>` block so the server can set `script-src 'self'` with no
 * `'unsafe-inline'` — the strongest CSP available without a nonce, and it
 * removes an entire class of XSS lever even though this page renders mostly
 * operator-supplied data.
 *
 * Wallet interaction reuses the same `window.klever` / `window.kleverWeb`
 * provider surface the main web client uses (see `web/src/lib/klever.ts`), so
 * an operator logs in with the extension they already have installed.
 */

/** Data the initial page needs before any JS runs. */
export interface PageContext {
  botAddress: string;
  network: string;
}

export function renderPage(ctx: PageContext): string {
  // Values come from the bot's own config/signer, not from any request input,
  // but are still escaped — defence in depth costs nothing here.
  const bot = escapeHtml(ctx.botAddress);
  const network = escapeHtml(ctx.network);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ogmara Newsbot Panel</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem;
         background: #12141a; color: #e6e6e6; }
  h1 { font-size: 1.2rem; }
  .muted { color: #9aa0a8; font-size: 0.85rem; }
  .card { background: #1c1f27; border: 1px solid #2a2e38; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  button { background: #3a6ff7; color: white; border: none; border-radius: 6px; padding: 0.5rem 1rem;
           cursor: pointer; font-size: 0.95rem; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { background: #d64545; }
  input { background: #12141a; color: #e6e6e6; border: 1px solid #2a2e38; border-radius: 6px;
          padding: 0.4rem; width: 100%; box-sizing: border-box; }
  label { display: block; margin: 0.6rem 0 0.2rem; font-size: 0.85rem; color: #b8bcc4; }
  #error { color: #ff8a8a; white-space: pre-wrap; }
  #status dt { color: #9aa0a8; font-size: 0.85rem; }
  #status dd { margin: 0 0 0.5rem; font-size: 1rem; }
  code { background: #12141a; padding: 0.1rem 0.3rem; border-radius: 4px; }
</style>
</head>
<body>
  <h1>Ogmara Newsbot</h1>
  <p class="muted">Bot wallet: <code>${bot}</code> — ${network}</p>

  <div id="login-card" class="card">
    <p>Sign in with the wallet authorised to operate this bot.</p>
    <button id="login-btn">Connect wallet</button>
    <p id="error"></p>
  </div>

  <div id="panel" class="card" hidden>
    <p class="muted">Signed in as <code id="whoami"></code></p>
    <dl id="status"></dl>
    <button id="logout-btn">Log out</button>

    <hr>
    <h2>Display name</h2>
    <label for="display-name">Display name</label>
    <input id="display-name" maxlength="64">
    <p><button id="profile-btn">Update profile</button></p>

    <hr>
    <h2>Wallet registration</h2>
    <p class="muted">Registering on-chain raises the daily posting ceiling. Costs real KLV, non-refundable.</p>
    <button id="register-btn" class="danger">Register wallet</button>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
}

/**
 * The panel's client-side script.
 *
 * All dynamic content is set via `textContent`/`value`, never `innerHTML` —
 * the status endpoint reflects the bot's own address and node-reported
 * numbers, not arbitrary remote text, but the discipline is cheap and the
 * alternative is a rule that erodes the first time someone adds a field.
 */
export function renderScript(): string {
  return `'use strict';

const errorEl = document.getElementById('error');
const loginCard = document.getElementById('login-card');
const panel = document.getElementById('panel');

function showError(message) {
  errorEl.textContent = message;
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // status carried on the error so callers can tell "not logged in" (401)
    // apart from every other failure — refresh() relies on this to avoid
    // showing "please sign in" when the real problem is an unreachable chain.
    const err = new Error(body.error || ('request failed: ' + res.status));
    err.status = res.status;
    throw err;
  }
  return body;
}

function getProvider() {
  if (window.klever && window.klever.signMessage) return window.klever;
  if (window.kleverWeb && window.kleverWeb.signMessage) return window.kleverWeb;
  return null;
}

async function login() {
  showError('');
  const provider = getProvider();
  if (!provider) {
    showError('No Klever wallet extension found. Install the Klever Extension or open this page in K5.');
    return;
  }
  try {
    if (provider.initialize) await provider.initialize();
    const address = await provider.getWalletAddress();
    const challenge = await api('/api/auth/challenge', { method: 'GET' });
    const signature = await provider.signMessage(challenge.message);
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
    });
    await refresh();
  } catch (err) {
    showError(err.message || String(err));
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  loginCard.hidden = false;
  panel.hidden = true;
}

function setField(dl, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

async function refresh() {
  const status = await api('/api/status', { method: 'GET' });
  loginCard.hidden = true;
  panel.hidden = false;
  document.getElementById('whoami').textContent = status.authenticatedAs;

  const dl = document.getElementById('status');
  dl.textContent = '';
  setField(dl, 'Mode', status.dryRun ? 'Dry run' : 'LIVE');
  setField(dl, 'Registered', status.registered ? 'Yes' : 'No');
  setField(dl, 'Daily limit', String(status.dailyLimit));
  setField(dl, 'Burst limit (10 min)', String(status.burstLimit));
  setField(dl, 'Balance', status.balanceKlv.toFixed(4) + ' KLV');

  const registerBtn = document.getElementById('register-btn');
  if (status.registered) {
    registerBtn.disabled = true;
    registerBtn.textContent = 'Already registered';
  } else {
    registerBtn.disabled = !status.canAffordRegistration;
    registerBtn.textContent = status.canAffordRegistration
      ? 'Register wallet (' + status.registrationCostKlv + ' KLV)'
      : 'Insufficient balance to register';
  }
}

async function updateProfile() {
  showError('');
  try {
    const displayName = document.getElementById('display-name').value.trim();
    await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ displayName: displayName || undefined }),
    });
  } catch (err) {
    showError(err.message || String(err));
  }
}

async function register() {
  showError('');
  if (!window.confirm('Register this wallet on-chain? This spends real KLV and cannot be undone.')) {
    return;
  }
  // The server also guards against an overlapping second request (registering
  // is check-then-act against the chain, wide enough for a double-click to
  // race), but disabling the button here means a double-click never even
  // reaches the network for the common case.
  const btn = document.getElementById('register-btn');
  btn.disabled = true;
  try {
    const result = await api('/api/register', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (result.status === 'registered') {
      showError('Registered. Transaction: ' + result.txHash);
    }
    await refresh();
  } catch (err) {
    showError(err.message || String(err));
    btn.disabled = false;
  }
}

document.getElementById('login-btn').addEventListener('click', login);
document.getElementById('logout-btn').addEventListener('click', logout);
document.getElementById('profile-btn').addEventListener('click', updateProfile);
document.getElementById('register-btn').addEventListener('click', register);

// If a session cookie is already valid (page reload, or localhost bypass),
// the status call succeeds immediately and skips the login screen. A 401
// just means "not logged in yet" and stays silent; anything else (the chain
// being unreachable, a server error) is worth surfacing rather than leaving
// the operator looking at an unexplained login screen.
refresh().catch((err) => {
  if (err && err.status !== 401) showError(err.message || String(err));
});
`;
}

/** Escape the handful of characters that matter inside HTML text content. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
