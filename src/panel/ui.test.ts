import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderPage, renderScript } from './ui.js';

/**
 * Regression coverage for the panel's browser UI.
 *
 * This whole layer had ZERO tests before the bug this file guards against
 * shipped: `<p id="error">` was nested inside `#login-card`, which gets
 * `hidden = true` the moment login succeeds. Every `showError()` call after
 * that point — including a genuine "Profile updated." success message —
 * wrote into an element the browser was no longer rendering at all. From the
 * operator's side, clicking "Update profile" looked like it silently did
 * nothing, even on requests that fully succeeded server-side.
 *
 * `renderPage`/`renderScript` return plain strings (no framework, no build
 * step, by design — see the module comment in ui.ts), so these are
 * string/structural checks rather than a real DOM, matching that same
 * dependency-free philosophy for the tests.
 */

const page = renderPage({ botAddress: 'klv1test', network: 'testnet' });
const script = renderScript();

/** The page's top-level `<div id="...">...</div>` blocks, by id, non-nested. */
function topLevelDivs(html: string): Map<string, string> {
  const divs = new Map<string, string>();
  const re = /<div id="([a-z-]+)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const id = match[1]!;
    const start = match.index;
    // Balanced scan for the matching close tag, so nested <div>s (there are
    // none inside these specific blocks today, but the scan doesn't assume
    // that) don't terminate early on the first </div>.
    let depth = 1;
    let i = start + match[0].length;
    const tagRe = /<div\b[^>]*>|<\/div>/g;
    tagRe.lastIndex = i;
    let t: RegExpExecArray | null;
    while (depth > 0 && (t = tagRe.exec(html)) !== null) {
      depth += t[0].startsWith('</') ? -1 : 1;
      i = tagRe.lastIndex;
    }
    divs.set(id, html.slice(start, i));
  }
  return divs;
}

describe('renderPage structure', () => {
  it('places the status/error message element OUTSIDE both the login and panel containers', () => {
    // The regression itself: an element inside a container that later gets
    // `hidden = true` is unreachable from that point on, no matter what JS
    // later writes into it.
    const divs = topLevelDivs(page);
    expect(divs.get('login-card')).toBeDefined();
    expect(divs.get('panel')).toBeDefined();
    expect(divs.get('login-card')).not.toContain('id="error"');
    expect(divs.get('panel')).not.toContain('id="error"');
  });

  it('has exactly one #error element, so there is only one place messages can go missing', () => {
    const matches = page.match(/id="error"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('places the backup banner outside the panel container too, for the same reason', () => {
    // walletBackupPending can legitimately be true while `#panel` is what's
    // showing (see server.ts's /api/status) — the banner must not be nested
    // inside something that could independently hide it.
    const divs = topLevelDivs(page);
    expect(divs.get('panel')).not.toContain('id="backup-banner"');
  });

  it('every element id the script looks up actually exists in the rendered page', () => {
    // A generic guard against the whole bug class: a getElementById() call
    // aimed at an id that doesn't exist (a typo, a removed element) returns
    // null and silently no-ops or throws deep in an event handler — exactly
    // the "nothing happens" failure mode, just from a different cause.
    const ids = [...script.matchAll(/getElementById\('([a-z-]+)'\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(page).toContain(`id="${id}"`);
    }
  });
});

describe('renderScript success/error feedback', () => {
  it('is syntactically valid JavaScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'newsbot-ui-script-'));
    try {
      const file = join(dir, 'app.js');
      writeFileSync(file, script);
      expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defines a distinct success path, not just showError, for a genuinely successful action', () => {
    expect(script).toContain('function showSuccess');
  });

  it('calls showSuccess on a successful profile update', () => {
    const fn = extractFunction(script, 'updateProfile');
    expect(fn).toMatch(/showSuccess\(/);
    // The specific regression: it must not silently succeed with no call to
    // either message function at all.
    expect(fn).toMatch(/showSuccess|showError/);
  });

  it('calls showSuccess (not showError) for a successful registration', () => {
    const fn = extractFunction(script, 'register');
    expect(fn).toMatch(/showSuccess\(\s*'Registered/);
  });

  it('reports both other register outcomes (already-registered, insufficient-funds), not just the happy path', () => {
    const fn = extractFunction(script, 'register');
    expect(fn).toContain('already-registered');
    expect(fn).toContain('insufficient-funds');
  });

  it('refuses to submit an empty display name rather than silently no-op-ing', () => {
    const fn = extractFunction(script, 'updateProfile');
    expect(fn).toMatch(/if \(!displayName\)/);
  });

  it('clears the message on logout, so a stale success/error doesn\'t linger past a state change', () => {
    const fn = extractFunction(script, 'logout');
    expect(fn).toMatch(/showError\(''\)/);
  });
});

describe('dashboard tab', () => {
  it('is the default visible tab, with Settings starting hidden', () => {
    // Direct check of the actual requirement: "below topics as default
    // dashboard, while the settings are an extra tab/page".
    const dashboardDiv = /<div id="tab-dashboard"[^>]*>/.exec(page)![0];
    const settingsDiv = /<div id="tab-settings"[^>]*>/.exec(page)![0];
    expect(dashboardDiv).not.toContain('hidden');
    expect(settingsDiv).toContain('hidden');
  });

  it('has exactly one tab button per tab-content div, matching data-tab to id', () => {
    const buttons = [...page.matchAll(/class="tab-btn[^"]*" id="tab-btn-([a-z]+)"/g)].map((m) => m[1]);
    const contents = [...page.matchAll(/<div id="tab-([a-z]+)" class="tab-content"/g)].map((m) => m[1]);
    expect(buttons.sort()).toEqual(contents.sort());
  });

  it('the dashboard tab button starts active, matching the visible content', () => {
    expect(page).toMatch(/class="tab-btn active" id="tab-btn-dashboard"/);
  });

  it('switchTab toggles both the active class and the hidden state together', () => {
    const fn = extractFunction(script, 'switchTab');
    expect(fn).toContain("classList.toggle('active'");
    expect(fn).toMatch(/\.hidden\s*=/);
  });

  it('fetches /api/posts and never uses innerHTML to render remote-derived post content', () => {
    const fn = extractFunction(script, 'refreshPosts');
    expect(fn).toContain("api('/api/posts'");
    expect(script).not.toContain('innerHTML');
  });

  it('sorts hashtags by descending count, not insertion order', () => {
    const fn = extractFunction(script, 'refreshPosts');
    expect(fn).toMatch(/sort\(\(a, b\) => b\[1\] - a\[1\]\)/);
  });

  it('refreshes both status and posts after a successful login', () => {
    const fn = extractFunction(script, 'login');
    expect(fn).toMatch(/await refresh\(\)/);
    expect(fn).toMatch(/await refreshPosts\(\);/);
  });

  it('refreshes posts even when the status refresh fails for a reason other than 401', () => {
    // The two must run independently, not chained — a status/chain failure
    // has no bearing on whether /api/posts would succeed, and must not
    // silently prevent it from ever being tried.
    const fn = extractFunction(script, 'login');
    expect(fn).not.toMatch(/await refresh\(\);\s*await refreshPosts\(\);/);
    expect(fn).toMatch(/refresh\(\)\.catch/);
  });

  it('switching to the dashboard tab refreshes its data', () => {
    const fn = extractFunction(script, 'switchTab');
    expect(fn).toMatch(/refreshPosts\(\)/);
  });

  it('the initial page-load sequence also runs refresh and refreshPosts independently, not chained', () => {
    // Same reasoning as login(): a top-level `refresh().then(refreshPosts)`
    // would mean a chain-unreachable /api/status failure on first load
    // prevents the post list from ever appearing, even though /api/posts
    // doesn't depend on it at all.
    expect(script).not.toMatch(/refresh\(\)\s*\.then\(refreshPosts\)/);
  });

  it('shows "never" rather than a broken date/NaN when there are no posts yet', () => {
    const fn = extractFunction(script, 'refreshPosts');
    expect(fn).toContain("'never'");
  });

  it('uses roughly 80% of the screen width rather than a fixed narrow column', () => {
    expect(page).toMatch(/width:\s*80%/);
  });

  it('links a post title to its ogmara.org detail page, using a validated msgId', () => {
    const constDecl = /const MSG_ID_RE = [^;]+;/.exec(script)![0];
    const fn = extractFunction(script, 'newsPostUrl');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const newsPostUrl = new Function(`${constDecl}\nreturn (${fn});`)();
    const validId = 'a'.repeat(64);
    expect(newsPostUrl(validId)).toBe('https://ogmara.org/app/#/news/' + validId);
    // A node-supplied msgId is untrusted input — anything not exactly 64 hex
    // chars must not become a link at all (renderPost falls back to plain
    // text), the same defensive posture web/src/lib/share.ts's own
    // sanitizeMsgId takes.
    expect(newsPostUrl('not-hex')).toBeNull();
    expect(newsPostUrl('a'.repeat(63))).toBeNull();
    expect(newsPostUrl('a'.repeat(65))).toBeNull();
    expect(newsPostUrl('')).toBeNull();
  });

  it('renderPost opens the link in a new tab without granting it window.opener', () => {
    const fn = extractFunction(script, 'renderPost');
    expect(fn).toContain("target = '_blank'");
    expect(fn).toMatch(/rel = ['"]noopener noreferrer['"]/);
  });

  it('formatRelativeTime never divides by zero or returns NaN-shaped output for "now"', () => {
    // Executed for real, not just pattern-matched — this one is pure and
    // side-effect-free, so there's no reason to settle for a string check.
    const fn = extractFunction(script, 'formatRelativeTime');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const formatRelativeTime = new Function(`return (${fn});`)();
    expect(formatRelativeTime(Date.now())).toBe('just now');
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5 minutes ago');
    expect(formatRelativeTime(Date.now() - 60_000)).toBe('1 minute ago');
    expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe('3 hours ago');
    expect(formatRelativeTime(Date.now() - 2 * 86_400_000)).toBe('2 days ago');
  });
});

describe('engagement history chart', () => {
  it('is the first content section inside the dashboard tab, right after the toolbar', () => {
    const dashboardDiv = /<div id="tab-dashboard"[^>]*>([\s\S]*?)<div id="tab-settings"/.exec(page);
    expect(dashboardDiv).not.toBeNull();
    const dashboardStart = dashboardDiv![1]!.trimStart();
    expect(dashboardStart.startsWith('<div class="dashboard-toolbar">')).toBe(true);
    // The chart itself is the first thing after the toolbar — still "first
    // part of the dashboard" in the sense that matters (before quick-stats,
    // posts, hashtags), just not literally byte zero of the tab.
    const afterToolbar = dashboardStart.slice(dashboardStart.indexOf('</div>') + '</div>'.length).trimStart();
    expect(afterToolbar.startsWith('<div class="chart-card">')).toBe(true);
  });

  it('has one metric button per reactions/reposts/comments, and one range button per monthly/yearly/overall', () => {
    for (const metric of ['reactions', 'reposts', 'comments']) {
      expect(page).toContain(`data-metric="${metric}"`);
    }
    for (const range of ['month', 'year', 'all']) {
      expect(page).toContain(`data-range="${range}"`);
    }
  });

  it("the chart's own metric/range buttons don't collide with the dashboard/settings tab switcher", () => {
    // A shared `.tab-btn` class here would mean the generic
    // `document.querySelectorAll('.tab-btn')` click handler (wired to
    // switchTab) also fires for these buttons, calling switchTab(undefined)
    // since they carry data-metric/data-range, not data-tab — which would
    // hide every tab-content pane. Distinct classes are load-bearing, not
    // cosmetic.
    const metricButtons = /<button class="([^"]*)"[^>]*data-metric=/.exec(page);
    const rangeButtons = /<button class="([^"]*)"[^>]*data-range=/.exec(page);
    expect(metricButtons![1]).not.toMatch(/\btab-btn\b/);
    expect(rangeButtons![1]).not.toMatch(/\btab-btn\b/);
  });

  it('minMax never uses Math.min(...arr)/Math.max(...arr), which blows the call stack on a large array', () => {
    const fn = extractFunction(script, 'minMax');
    expect(fn).not.toMatch(/Math\.(min|max)\(\.\.\./);
  });

  it('renderChart clears the SVG via replaceChildren, never innerHTML', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toContain('replaceChildren()');
  });

  it('shows the empty state when there are fewer than two points in the selected range', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/points\.length < 2/);
  });

  it('refreshChart fetches /api/stats-history and never uses innerHTML', () => {
    const fn = extractFunction(script, 'refreshChart');
    expect(fn).toContain("api('/api/stats-history'");
    expect(script).not.toContain('innerHTML');
  });

  it('refreshChart clears any stale chart and hides the empty-state text on a fetch failure, rather than showing both messages at once', () => {
    const fn = extractFunction(script, 'refreshChart');
    expect(fn).toMatch(/catch[\s\S]*replaceChildren\(\)/);
    expect(fn).toMatch(/catch[\s\S]*chart-empty['"]\)\.hidden = true/);
  });

  it('renderChart matches the SVG viewBox to its actual rendered width, so the polyline and labels are never stretched non-uniformly', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toContain('svg.clientWidth');
    expect(fn).toMatch(/setAttribute\('viewBox'/);
  });

  it('refreshChart is called alongside refreshPosts on login, tab switch, and initial load', () => {
    expect(extractFunction(script, 'login')).toMatch(/await refreshChart\(\);/);
    expect(extractFunction(script, 'switchTab')).toMatch(/refreshChart\(\)/);
    // Initial load: both run independently at the bottom of the script, not
    // just inside a function — same "must not be chained" reasoning as
    // refreshPosts already carries for this exact spot.
    const tail = script.slice(script.lastIndexOf('refresh().catch'));
    expect(tail).toContain('refreshPosts();');
    expect(tail).toContain('refreshChart();');
  });

  it('wires click listeners for both the metric and range buttons', () => {
    expect(script).toContain("querySelectorAll('.chart-metric-btn')");
    expect(script).toContain("querySelectorAll('.range-btn')");
  });
});

describe('dashboard refresh button', () => {
  it('exists and is wired to a click listener', () => {
    expect(page).toContain('id="refresh-dashboard-btn"');
    expect(script).toContain("getElementById('refresh-dashboard-btn').addEventListener('click', refreshDashboard)");
  });

  it('reloads both posts and the chart, without a full page reload', () => {
    const fn = extractFunction(script, 'refreshDashboard');
    expect(fn).toContain('refreshPosts()');
    expect(fn).toContain('refreshChart(true)');
    expect(script).not.toContain('location.reload');
  });

  it('forces a brand-new snapshot rather than just re-reading the last one — the whole point of this button', () => {
    // Prior behavior: clicking Refresh re-fetched /api/stats-history, which
    // only reflects whatever the periodic (default 6h) scheduled snapshot
    // last recorded — the chart looked unchanged even right after a click.
    const fn = extractFunction(script, 'refreshDashboard');
    expect(fn).toContain('refreshChart(true)');
  });

  it('disables itself while the refresh is in flight, and re-enables afterward even on failure', () => {
    const fn = extractFunction(script, 'refreshDashboard');
    expect(fn).toMatch(/\.disabled = true/);
    expect(fn).toMatch(/finally[\s\S]*\.disabled = false/);
  });
});

describe('refreshChart force parameter', () => {
  it('POSTs /api/stats-history/refresh (forcing a new snapshot) only when force is true', () => {
    const fn = extractFunction(script, 'refreshChart');
    expect(fn).toContain("api('/api/stats-history/refresh', { method: 'POST'");
    expect(fn).toContain("api('/api/stats-history', { method: 'GET' }");
  });

  it('plain loads (login, tab switch, initial page load) never force a new snapshot', () => {
    // Only the button's own handler should ever call refreshChart(true) —
    // every routine load stays a cheap local read, since forcing a fresh
    // node aggregation on every tab switch would be needless extra load.
    expect(extractFunction(script, 'login')).toMatch(/refreshChart\(\);/);
    expect(extractFunction(script, 'switchTab')).toMatch(/refreshChart\(\);/);
    const tail = script.slice(script.lastIndexOf('refresh().catch'));
    expect(tail).toMatch(/refreshChart\(\);/);
  });
});

/** Pull one `[async] function name() { ... }` body out of the generated script, braces balanced. */
function extractFunction(source: string, name: string): string {
  const start =
    source.indexOf(`async function ${name}(`) !== -1
      ? source.indexOf(`async function ${name}(`)
      : source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const bodyStart = source.indexOf('{', start);
  let depth = 1;
  let i = bodyStart + 1;
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}
