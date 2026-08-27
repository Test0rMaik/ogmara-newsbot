import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
