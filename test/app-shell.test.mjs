import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/styles.css', import.meta.url), 'utf8');

/**
 * Every element the code reaches for must exist.
 *
 * Nothing here needs a browser, and it catches the class of bug that has cost
 * the most time in this project: code and markup drifting apart, which shows up
 * only as something silently missing on a real device.
 */
test('every id app.js queries exists in the markup', () => {
  const ids = [...js.matchAll(/\$\('#([a-z0-9-]+)'\)/gi)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `app.js queries ids that are not in index.html: ${missing}`);
});

test('the reader carries its own navigation', () => {
  const reader = html.slice(html.indexOf('<section id="reader"'), html.indexOf('</section>', html.indexOf('<section id="reader"')));
  for (const id of ['workskin', 'chapnav', 'prev', 'next', 'chappos']) {
    assert.ok(reader.includes(`id="${id}"`), `#${id} must live inside the reader, not outside it`);
  }
});

test('the tab bar does not own the reader', () => {
  const tabbed = js.match(/const TABBED = new Set\(\[([^\]]*)\]/)?.[1] ?? '';
  assert.ok(!tabbed.includes('reader'), 'chapter navigation replaces the tab bar while reading');
  assert.ok(tabbed.includes('home') && tabbed.includes('library'), 'the browsing views keep it');
});

test('a closed dialog is never given a display that overrides hiding it', () => {
  // `#x { display: flex }` beats the browser's `display: none` for a closed
  // dialog, which once left the chapter drawer visible on the setup screen
  for (const m of css.matchAll(/#([a-z-]*dialog[a-z-]*|filters)\s*(\[open\])?\s*\{([^}]*)\}/gi)) {
    if (!m[2] && /display:\s*(flex|block|grid)/.test(m[3])) {
      assert.fail(`#${m[1]} sets display without [open]; a closed dialog would show`);
    }
  }
});

test('every theme that is dark declares a dark color-scheme', () => {
  // without this the OS paints sliders and selects light on a dark panel
  for (const marker of ["[data-theme='dark']", "[data-theme='black']"]) {
    const at = css.indexOf(marker);
    assert.ok(at >= 0, `${marker} should exist`);
    assert.ok(css.slice(at, at + 220).includes('color-scheme: dark'),
      `${marker} must set color-scheme`);
  }
});

/** Relative luminance, per WCAG. */
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('link colours meet WCAG AA against every theme background', () => {
  // links inside a work inherited the body colour and were nearly invisible on
  // a dark theme; this keeps that from happening again quietly
  const pairs = [
    ['dark', '#7fb2ef', '#1a1c1e'],
    ['black', '#7fb2ef', '#000000'],
    ['light', '#1f5fa9', '#fbf9f5'],
    ['sepia', '#1f5fa9', '#f4ecd8'],
  ];
  for (const [theme, link, bg] of pairs) {
    const ratio = contrast(link, bg);
    assert.ok(ratio >= 4.5, `${theme}: ${ratio.toFixed(2)}:1 is below AA (4.5:1)`);
  }
});

test('body text meets WCAG AA against its own background', () => {
  for (const [theme, fg, bg] of [
    ['light', '#1b1a17', '#fbf9f5'], ['sepia', '#3b3227', '#f4ecd8'],
    ['dark', '#dcd9d4', '#1a1c1e'], ['black', '#c9c6c1', '#000000'],
  ]) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `${theme}: body text at ${ratio.toFixed(2)}:1 is below AA`);
  }
});

test("AO3's screen-reader landmarks are hidden visually but kept for assistive tech", () => {
  // "Chapter Text" and "Work" are navigation landmarks, not headings for the
  // eye; display:none would take them out of the accessibility tree entirely
  const rule = css.match(/\.ao3page \.landmark \{([^}]*)\}/)?.[1] ?? '';
  assert.ok(/font-size:\s*0/.test(rule), 'hidden by size, as AO3 does it');
  assert.ok(/opacity:\s*0/.test(rule));
  assert.ok(!/display:\s*none/.test(rule), 'display:none would remove it from screen readers');
});

test('the app is named consistently wherever a person can see it', () => {
  assert.ok(html.includes('<title>Fan Folio</title>'));
  assert.ok(!/Fan-folio/.test(html), 'no hyphenated spelling in the markup');
});

test('the sign-in window is never given the app bridge', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const start = java.indexOf('private void openSignIn()');
  const end = java.indexOf('private FrameLayout signInPanel');
  const body = java.slice(start, end);
  assert.ok(body.includes('signInView.loadUrl(LOGIN_URL)'), 'it loads the real login page');
  assert.ok(!body.includes('addJavascriptInterface'),
    'a page where a password is typed must have no route into this app');
});

test('the session cookie goes only to the archive', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const open = java.slice(java.indexOf('private HttpURLConnection open('), java.indexOf('private WebResourceResponse respond('));
  assert.ok(open.includes('archiveofourown.org'), 'the host is checked before the cookie is attached');
  const cookieAt = open.indexOf('setRequestProperty("Cookie"');
  const hostCheckAt = open.indexOf('host.endsWith');
  assert.ok(hostCheckAt > 0 && hostCheckAt < cookieAt,
    'the host must be checked before the session is sent, not after');
});

test('the read bridge refuses anything that is not a single read', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const q = java.slice(java.indexOf('public String query(String sql'), java.indexOf('/** Store a work'));
  // the page composes its own queries, so this is the boundary that decides
  // what it may ask for
  assert.ok(/regionMatches\(true, 0, "SELECT"/.test(q), 'reads only');
  assert.ok(q.includes("indexOf(';')"), 'no second statement riding along');
  assert.ok(q.includes('"--"') && q.includes('"/*"'), 'no comment markers hiding a tail');
  assert.ok(q.includes('PRAGMA_OR_ATTACH'), 'nothing reaching outside this archive');
});
