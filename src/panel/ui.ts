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
  .banner { background: #3a2a12; border: 1px solid #a86a1e; border-radius: 8px; padding: 1rem;
            margin: 0 0 1rem; color: #ffd9a0; }
  button { background: #3a6ff7; color: white; border: none; border-radius: 6px; padding: 0.5rem 1rem;
           cursor: pointer; font-size: 0.95rem; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { background: #d64545; }
  input { background: #12141a; color: #e6e6e6; border: 1px solid #2a2e38; border-radius: 6px;
          padding: 0.4rem; width: 100%; box-sizing: border-box; }
  label { display: block; margin: 0.6rem 0 0.2rem; font-size: 0.85rem; color: #b8bcc4; }
  #error { white-space: pre-wrap; }
  .error { color: #ff8a8a; }
  .success { color: #7fd88f; }
  #status dt { color: #9aa0a8; font-size: 0.85rem; }
  #status dd { margin: 0 0 0.5rem; font-size: 1rem; }
  code { background: #12141a; padding: 0.1rem 0.3rem; border-radius: 4px; }

  .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .tabs { display: flex; gap: 0.5rem; border-bottom: 1px solid #2a2e38; margin-bottom: 1rem; }
  .tab-btn { background: none; color: #9aa0a8; border: none; border-bottom: 2px solid transparent;
             border-radius: 0; padding: 0.5rem 0.25rem; margin-bottom: -1px; }
  .tab-btn.active { color: #e6e6e6; border-bottom-color: #3a6ff7; }
  .tab-btn:hover:not(.active) { color: #c8ccd2; }

  .quick-stats { display: flex; gap: 1.5rem; flex-wrap: wrap; margin: 0 0 1.2rem; }
  .quick-stats div { min-width: 6rem; }
  .quick-stats dt { color: #9aa0a8; font-size: 0.8rem; }
  .quick-stats dd { margin: 0; font-size: 1.3rem; }

  .post-row { border-bottom: 1px solid #2a2e38; padding: 0.6rem 0; }
  .post-row:last-child { border-bottom: none; }
  .post-title { font-size: 0.95rem; }
  .post-meta { color: #9aa0a8; font-size: 0.8rem; margin-top: 0.2rem; }
  .post-meta span { margin-right: 1rem; }

  .hashtag-list { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0; margin: 0; list-style: none; }
  .hashtag-list li { background: #12141a; border: 1px solid #2a2e38; border-radius: 999px;
                      padding: 0.2rem 0.7rem; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>Ogmara Newsbot</h1>
  <p class="muted">Bot wallet: <code>${bot}</code> — ${network}</p>

  <p id="error"></p>

  <div id="login-card" class="card">
    <p>Sign in with the wallet authorised to operate this bot.</p>
    <button id="login-btn">Connect wallet</button>
  </div>

  <div id="backup-banner" class="banner" hidden>
    <strong>Back up your wallet key now.</strong> This bot's wallet key was
    generated automatically, and its only copy is the <code>.env</code> file
    on this machine — it cannot be recovered if lost, and anyone who obtains
    it can post as this bot. Copy it somewhere safe now.
    <p><button id="backup-ack-btn">I've backed it up</button></p>
  </div>

  <div id="panel" class="card" hidden>
    <div class="panel-header">
      <p class="muted">Signed in as <code id="whoami"></code></p>
      <button id="logout-btn">Log out</button>
    </div>

    <nav class="tabs">
      <button class="tab-btn active" id="tab-btn-dashboard" data-tab="dashboard">Dashboard</button>
      <button class="tab-btn" id="tab-btn-settings" data-tab="settings">Settings</button>
    </nav>

    <div id="tab-dashboard" class="tab-content">
      <p id="dashboard-error" class="error"></p>
      <dl class="quick-stats" id="quick-stats"></dl>

      <h2>Recent posts</h2>
      <p class="muted" id="posts-empty" hidden>No posts yet.</p>
      <div id="posts-list"></div>

      <h2>Hashtags</h2>
      <p class="muted" id="hashtags-empty" hidden>No hashtags yet.</p>
      <p class="muted" id="hashtags-note">Counted across the posts shown above, not your full history.</p>
      <ul class="hashtag-list" id="hashtag-list"></ul>
    </div>

    <div id="tab-settings" class="tab-content" hidden>
      <dl id="status"></dl>

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
const backupBanner = document.getElementById('backup-banner');
const dashboardErrorEl = document.getElementById('dashboard-error');

function showError(message) {
  errorEl.textContent = message;
  errorEl.className = message ? 'error' : '';
}

function showSuccess(message) {
  errorEl.textContent = message;
  errorEl.className = 'success';
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // status AND body carried on the error: refresh() needs the status code
    // to tell "not logged in" (401) apart from every other failure, and the
    // body itself because /api/status still includes walletBackupPending on
    // a 502 (chain unreachable) precisely so a node outage can't make the
    // backup reminder disappear along with everything else in the response.
    const err = new Error(body.error || ('request failed: ' + res.status));
    err.status = res.status;
    err.body = body;
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
  } catch (err) {
    showError(err.message || String(err));
    return;
  }
  // Login itself succeeded at this point. status and posts are refreshed
  // independently from here rather than chained — /api/posts has no
  // dependency on whatever /api/status might fail on (most likely the chain
  // being unreachable), so one failing must not silently prevent the other
  // from ever being tried.
  await refresh().catch((err) => {
    if (err && err.status !== 401) showError(err.message || String(err));
  });
  await refreshPosts();
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  loginCard.hidden = false;
  panel.hidden = true;
  backupBanner.hidden = true;
  showError('');
}

function setField(dl, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function switchTab(name) {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const content of document.querySelectorAll('.tab-content')) {
    content.hidden = content.id !== 'tab-' + name;
  }
  // Otherwise the dashboard only ever reflects whatever was true at page
  // load — "Queued" in particular is the one genuinely live number here
  // (the retry queue actually drains over time), so leaving it frozen is
  // exactly the "looks like nothing is happening" failure mode this panel
  // already had once this session.
  if (name === 'dashboard') refreshPosts();
}

/**
 * "3 minutes ago" / "5 hours ago" / "2 days ago", falling back to a plain
 * date once it's old enough that a relative count stops being useful at a
 * glance. This is the actual point of the stat: noticing at a glance that
 * the bot has gone quiet, not precise timekeeping.
 */
function formatRelativeTime(ms) {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's') + ' ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  return new Date(ms).toLocaleDateString();
}

function setQuickStat(dl, label, value) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.appendChild(dt);
  wrap.appendChild(dd);
  dl.appendChild(wrap);
}

function renderPost(post) {
  const row = document.createElement('div');
  row.className = 'post-row';

  const title = document.createElement('div');
  title.className = 'post-title';
  title.textContent = post.title;
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'post-meta';
  const parts = [
    formatRelativeTime(post.timestamp),
    'reactions: ' + post.reactionCount,
    'reposts: ' + post.repostCount,
    'comments: ' + post.commentCount,
  ];
  for (const part of parts) {
    const span = document.createElement('span');
    span.textContent = part;
    meta.appendChild(span);
  }
  row.appendChild(meta);

  return row;
}

async function refreshPosts() {
  dashboardErrorEl.textContent = '';
  try {
    const stats = await api('/api/posts', { method: 'GET' });

    const quickStats = document.getElementById('quick-stats');
    quickStats.textContent = '';
    setQuickStat(quickStats, 'Published', String(stats.totalPublished));
    setQuickStat(quickStats, 'Queued', String(stats.queuedCount));
    setQuickStat(
      quickStats,
      'Last post',
      stats.lastPostedAt ? formatRelativeTime(stats.lastPostedAt) : 'never',
    );

    const postsList = document.getElementById('posts-list');
    postsList.textContent = '';
    document.getElementById('posts-empty').hidden = stats.posts.length > 0;
    for (const post of stats.posts) {
      postsList.appendChild(renderPost(post));
    }

    const hashtagList = document.getElementById('hashtag-list');
    hashtagList.textContent = '';
    const tags = Object.entries(stats.hashtagCounts).sort((a, b) => b[1] - a[1]);
    document.getElementById('hashtags-empty').hidden = tags.length > 0;
    document.getElementById('hashtags-note').hidden = tags.length === 0;
    for (const [tag, count] of tags) {
      const li = document.createElement('li');
      li.textContent = '#' + tag + ' (' + count + ')';
      hashtagList.appendChild(li);
    }
  } catch (err) {
    dashboardErrorEl.textContent = err.message || String(err);
  }
}

async function refresh() {
  let status;
  try {
    status = await api('/api/status', { method: 'GET' });
  } catch (err) {
    if (err.status === 401) {
      loginCard.hidden = false;
      panel.hidden = true;
      backupBanner.hidden = true;
      throw err;
    }
    // Authenticated, but something else failed (most likely the chain being
    // unreachable) — still worth showing the panel shell and the backup
    // reminder rather than leaving the operator looking at the login screen
    // as if they were never signed in. /api/status includes
    // walletBackupPending even on its error responses for exactly this.
    loginCard.hidden = true;
    panel.hidden = false;
    backupBanner.hidden = !(err.body && err.body.walletBackupPending);
    throw err;
  }
  loginCard.hidden = true;
  panel.hidden = false;
  backupBanner.hidden = !status.walletBackupPending;
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
    if (!displayName) {
      showError('Enter a display name first.');
      return;
    }
    const result = await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    });
    showSuccess(
      result.status === 'updated' ? 'Profile updated.' : 'Nothing to update.',
    );
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
      showSuccess('Registered. Transaction: ' + result.txHash);
    } else if (result.status === 'already-registered') {
      showSuccess('Already registered — nothing was spent.');
    } else if (result.status === 'insufficient-funds') {
      showError('Insufficient balance: need ' + result.requiredKlv + ' KLV, have ' + result.balanceKlv + '.');
    }
    await refresh();
  } catch (err) {
    showError(err.message || String(err));
    btn.disabled = false;
  }
}

async function ackBackup() {
  const btn = document.getElementById('backup-ack-btn');
  btn.disabled = true;
  try {
    await api('/api/wallet/ack-backup', { method: 'POST', body: '{}' });
    backupBanner.hidden = true;
  } catch (err) {
    showError(err.message || String(err));
    btn.disabled = false;
  }
}

document.getElementById('login-btn').addEventListener('click', login);
document.getElementById('logout-btn').addEventListener('click', logout);
document.getElementById('profile-btn').addEventListener('click', updateProfile);
document.getElementById('register-btn').addEventListener('click', register);
document.getElementById('backup-ack-btn').addEventListener('click', ackBackup);
for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

// If a session cookie is already valid (page reload, or localhost bypass),
// the status call succeeds immediately and skips the login screen. A 401
// just means "not logged in yet" and stays silent; anything else (the chain
// being unreachable, a server error) is worth surfacing rather than leaving
// the operator looking at an unexplained login screen.
//
// Run independently rather than chained: /api/posts has no dependency on
// whatever /api/status might fail on, so a status failure (most likely the
// chain being unreachable) must not silently prevent the post list from
// ever loading.
refresh().catch((err) => {
  if (err && err.status !== 401) showError(err.message || String(err));
});
refreshPosts();
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
