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

describe('chart per-period deltas (Monthly/Yearly bucketing)', () => {
  // Snapshots store a CUMULATIVE lifetime total (statsHistory.ts). Plotting
  // that raw under "Monthly" — a day-labeled view — looked like a flat line
  // that jumps once, which read as "reactions are summarizing" rather than
  // showing per-day activity. bucketDeltaSeries converts the cumulative
  // series into per-period NEW activity; these tests execute the real
  // function against synthetic snapshot data rather than just pattern-
  // matching the source, since the bucketing math is exactly the part that
  // was wrong. (User feedback, 0.15.0.)
  function loadBucketDeltaSeries() {
    const bucketKeyFn = extractFunction(script, 'bucketKey');
    const bucketDeltaSeriesFn = extractFunction(script, 'bucketDeltaSeries');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`${bucketKeyFn}\n${bucketDeltaSeriesFn}\nreturn bucketDeltaSeries;`)();
  }

  function loadFormatChartDate() {
    const fn = extractFunction(script, 'formatChartDate');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`return (${fn});`)();
  }

  const DAY = 86_400_000;

  it('computes per-day new activity as the delta between the last snapshot of each day, not the raw cumulative total', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime(); // arbitrary local-time anchor, matching bucketKey's local getters
    const history = [
      { timestamp: day0 + 1000, totalReactions: 10 },
      { timestamp: day0 + 2000, totalReactions: 12 }, // still day 0 — only the LAST value of the day should count
      { timestamp: day0 + DAY + 1000, totalReactions: 15 }, // day 1
      { timestamp: day0 + 2 * DAY + 1000, totalReactions: 15 }, // day 2, no new reactions at all
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points.map((p: any) => p.y)).toEqual([12, 3, 0]);
  });

  it('nets the first bucket in the window against the last snapshot BEFORE the window, not against zero', () => {
    // Without this, the very first visible day would show its entire
    // lifetime-to-date total as "new today" every time the window slides —
    // e.g. a 30-day-old bot would show day -30's cumulative total as a
    // single-day spike once it first entered the Monthly window.
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 - 5 * DAY, totalReactions: 5 }, // before the window — the real baseline
      { timestamp: day0 + 1000, totalReactions: 12 }, // first day inside the window
      { timestamp: day0 + DAY + 1000, totalReactions: 20 },
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points.map((p: any) => p.y)).toEqual([7, 8]); // 12-5, then 20-12 — never 12-0
  });

  it('treats the very first snapshot ever as its own baseline (0), not an error', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [{ timestamp: day0 + 1000, totalReactions: 9 }];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points).toEqual([{ timestamp: day0 + 1000, y: 9 }]);
  });

  it('allows a negative delta (net un-reactions within a period) rather than clamping it away', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 + 1000, totalReactions: 20 },
      { timestamp: day0 + DAY + 1000, totalReactions: 15 }, // net decrease
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points[1].y).toBe(-5);
  });

  it('finds the correct baseline even when history is not sorted ascending', () => {
    // bucketDeltaSeries must not silently depend on statsHistory.ts's own
    // sort-on-append guarantee — a hand-edited or externally rewritten
    // stats-history.json could arrive out of order. (Code audit, 0.15.0.)
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 + 1000, totalReactions: 50 }, // in-window, but listed FIRST despite being later
      { timestamp: day0 - 5 * DAY, totalReactions: 5 }, // the real pre-window baseline, listed SECOND
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points).toEqual([{ timestamp: day0 + 1000, y: 45 }]); // 50 - 5, never 50 - 0
  });

  it('picks the later snapshot within a bucket even when two share the exact same millisecond', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const day0 = new Date(2026, 7, 28).getTime();
    const history = [
      { timestamp: day0 + 1000, totalReactions: 5 },
      { timestamp: day0 + 1000, totalReactions: 9 }, // identical timestamp, listed second — should win
    ];
    const points = bucketDeltaSeries(history, day0 - DAY, 'day', 'totalReactions');
    expect(points).toEqual([{ timestamp: day0 + 1000, y: 9 }]);
  });

  it('buckets by calendar month for the Yearly granularity, not by day', () => {
    const bucketDeltaSeries = loadBucketDeltaSeries();
    const monthStart = new Date(2026, 0, 1).getTime(); // Jan 2026, local time
    const history = [
      { timestamp: new Date(2026, 0, 5).getTime(), totalReactions: 10 },
      { timestamp: new Date(2026, 0, 25).getTime(), totalReactions: 18 }, // same month as above
      { timestamp: new Date(2026, 1, 3).getTime(), totalReactions: 30 }, // February
    ];
    const points = bucketDeltaSeries(history, monthStart - DAY, 'month', 'totalReactions');
    expect(points.map((p: any) => p.y)).toEqual([18, 12]); // Jan: 18-0, Feb: 30-18
  });

  it("renderChart only applies the raw-cumulative path (no bucketing) for the 'all' range", () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/if \(granularity === 'raw'\) \{\s*\n\s*points = chartHistory\.map/);
  });

  it('only forces the y-axis floor to 0 when NOT plotting deltas — a bucketed delta must be able to show negative', () => {
    // Tracked via the usingDeltas flag, not "granularity === raw" directly —
    // the sparse-data fallback (see below) also produces a cumulative
    // series even under a bucketed range, and that path needs the same
    // floor-at-0 treatment a true raw/Overall series gets.
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/if \(!usingDeltas\) minY = Math\.min\(0, minY\);/);
  });

  it('falls back to raw within-window snapshots when bucketing yields fewer than 2 periods, instead of a blank chart', () => {
    // Regression coverage: a brand-new bot (or several same-day snapshots)
    // used to show "Not enough history yet" on Monthly/Yearly even with
    // real data on screen for every OTHER tab, because bucketing by
    // calendar day/month collapsed same-day data into a single point.
    // (Code audit, 0.15.0.)
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/if \(bucketed\.length >= 2\)/);
    expect(fn).toContain('usingDeltas = true;');
    expect(fn).toMatch(/points = chartHistory\s*\n\s*\.filter\(\(s\) => s\.timestamp >= windowStart\)/);
  });

  it('snaps the window start to a bucket boundary before bucketing, so the first period is never partial', () => {
    // Regression coverage: without this, the leftmost bucket only covered
    // whatever fraction of the day/month happened to fall after
    // `now - windowMs`, undercounting it — reproduced at ~15x low for a
    // monthly bucket a few hours into the day. (Code audit, 0.15.0.)
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toContain('const windowStart = bucketStart(now - windowMs, granularity);');
  });

  it('labels the latest value as "so far" only when it is a still-in-progress bucketed period, not a cumulative total', () => {
    const fn = extractFunction(script, 'renderChart');
    expect(fn).toMatch(/usingDeltas \? ys\[ys\.length - 1\] \+ ' so far' : String\(ys\[ys\.length - 1\]\)/);
  });

  it('formats a day bucket (and the raw/Overall path) as M/D', () => {
    const formatChartDate = loadFormatChartDate();
    const ms = new Date(2026, 7, 5, 12).getTime(); // Aug 5 2026, noon local time
    expect(formatChartDate(ms, 'day')).toBe('8/5');
    // 'raw' isn't a real branch in the function — it falls through to the
    // same numeric path as 'day', which is what the Overall range relies on.
    expect(formatChartDate(ms, 'raw')).toBe('8/5');
  });

  it('formats a month bucket using the environment\'s own locale formatting, not a hardcoded assumption', () => {
    // Comparing against the SAME toLocaleDateString call the production code
    // makes (rather than a hardcoded English-locale regex like /Aug.*2026/)
    // means this test passes under any runtime locale instead of failing
    // outside en-*/de-* environments while the real code is doing exactly
    // the right, locale-aware thing. (Code audit, 0.15.0.)
    const formatChartDate = loadFormatChartDate();
    const ms = new Date(2026, 7, 5, 12).getTime();
    const expected = new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    expect(formatChartDate(ms, 'month')).toBe(expected);
  });

  it('bucketStart snaps to the start of the calendar day or month, in local time', () => {
    const fn = extractFunction(script, 'bucketStart');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const bucketStart = new Function(`return (${fn});`)();
    const midDay = new Date(2026, 7, 15, 14, 30, 0).getTime(); // Aug 15 2026, 14:30 local
    expect(bucketStart(midDay, 'day')).toBe(new Date(2026, 7, 15, 0, 0, 0, 0).getTime());
    expect(bucketStart(midDay, 'month')).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).getTime());
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

describe('profile: current display name and avatar', () => {
  it('switching to the Settings tab loads the current profile', () => {
    const fn = extractFunction(script, 'switchTab');
    expect(fn).toContain('refreshProfile()');
  });

  it('refreshProfile fetches /api/profile and never uses innerHTML', () => {
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toContain("api('/api/profile'");
    expect(script).not.toContain('innerHTML');
  });

  it('only prefills the display-name input while it has not been edited this session (tracked via a dirty flag, not just emptiness)', () => {
    // A bare "is the input empty" check would re-clobber a value the
    // operator typed and then deleted back to empty. An explicit dirty flag
    // — set on the input's own 'input' event, cleared after a successful
    // save — is what actually distinguishes "never touched" from "touched
    // and then cleared." (Code audit, 0.14.0.)
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toMatch(/if \(!displayNameDirty\)/);
    expect(script).toContain(
      "getElementById('display-name').addEventListener('input', () => {\n  displayNameDirty = true;\n});",
    );
    expect(extractFunction(script, 'updateProfile')).toContain('displayNameDirty = false;');
  });

  it('builds the avatar preview URL from nodeUrl + the media endpoint, and hides it when there is no avatar', () => {
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toContain("'/api/v1/media/'");
    expect(fn).toMatch(/preview\.hidden = true/);
  });

  it('never overwrites a locally staged, not-yet-uploaded avatar with the old server-confirmed one', () => {
    // Regression coverage: switching tabs away and back used to re-run
    // refreshProfile(), which unconditionally reset the preview to the OLD
    // avatar even while a newly picked file was still staged and the
    // Upload button still enabled — so what was on screen and what Upload
    // would actually publish could silently diverge. (Code audit, 0.14.0.)
    const fn = extractFunction(script, 'refreshProfile');
    expect(fn).toMatch(/if \(selectedAvatarFile === null\) \{/);
  });

  it('has a file input restricted to the four accepted image types', () => {
    expect(page).toMatch(
      /accept="image\/jpeg,image\/png,image\/gif,image\/webp"/,
    );
  });

  it('validates the chosen file client-side against the exact same four types the server allows, plus size', () => {
    // Previously `file.type.startsWith('image/')` — broader than the
    // server's allowlist, so an SVG (or anything else "image/*") would
    // preview locally before being rejected server-side with a confusing
    // error. (Code audit, 0.14.0.)
    expect(script).toContain(
      "const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];",
    );
    const fn = extractFunction(script, 'onAvatarFileChange');
    expect(fn).toContain('ALLOWED_AVATAR_TYPES.includes(file.type)');
    expect(fn).toMatch(/file\.size === 0/);
    expect(fn).toMatch(/file\.size > MAX_AVATAR_BYTES/);
    expect(fn).toContain('uploadBtn.disabled = true');
  });

  it('resets the preview when a chosen file is rejected, rather than leaving a stale image showing', () => {
    const fn = extractFunction(script, 'onAvatarFileChange');
    const rejectionBranches = fn.split('return;').slice(0, -1);
    for (const branch of rejectionBranches) {
      if (branch.includes('showError(')) expect(branch).toMatch(/preview\.hidden = true/);
    }
  });

  it('shows an immediate local preview via a blob: URL on file selection, revoking any previous one first', () => {
    const fn = extractFunction(script, 'onAvatarFileChange');
    expect(fn).toContain('setAvatarPreviewBlobUrl(URL.createObjectURL(file))');
    const revokeFn = extractFunction(script, 'setAvatarPreviewBlobUrl');
    expect(revokeFn).toContain('URL.revokeObjectURL(avatarPreviewBlobUrl)');
  });

  it('uploadSelectedAvatar reads the file as base64 and posts it to /api/profile/avatar', () => {
    const fn = extractFunction(script, 'uploadSelectedAvatar');
    expect(fn).toContain("api('/api/profile/avatar'");
    expect(fn).toContain('readAsDataURL');
    // Strips the "data:image/png;base64," prefix rather than sending the
    // whole data URL — the server expects raw base64.
    expect(fn).toMatch(/dataUrl\.slice\(dataUrl\.indexOf\(','\) \+ 1\)/);
  });

  it('re-fetches the confirmed profile after a successful upload, rather than trusting the local preview alone', () => {
    const fn = extractFunction(script, 'uploadSelectedAvatar');
    expect(fn).toMatch(/showSuccess\(/);
    expect(fn).toContain('refreshProfile()');
  });

  it('disables the upload button again after a successful upload, but leaves it enabled to retry after a failure', () => {
    const fn = extractFunction(script, 'uploadSelectedAvatar');
    expect(fn).toMatch(/finally[\s\S]*btn\.disabled = selectedAvatarFile === null/);
  });

  it('wires both the file-input change and the upload-button click', () => {
    expect(script).toContain(
      "getElementById('avatar-file-input').addEventListener('change', onAvatarFileChange)",
    );
    expect(script).toContain(
      "getElementById('avatar-upload-btn').addEventListener('click', uploadSelectedAvatar)",
    );
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
