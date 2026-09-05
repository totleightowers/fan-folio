import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA } from '../app/core/store/schema.js';
import { CHAPTERS } from '../app/core/query.js';

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

  /* This used to assert the shape of the check rather than what it guarantees,
     and the pattern it accepted — endsWith("archiveofourown.org") with no
     leading dot — is true of evilarchiveofourown.org, someone else's domain
     entirely. The test would have passed while the cookie leaked. It now
     asserts the property: a boundary-correct decision, made before the session
     is attached. */
  const decidesAt = open.indexOf('isArchiveHost(');
  const cookieAt = open.indexOf('setRequestProperty("Cookie"');
  assert.ok(decidesAt > 0, 'the host is decided by one shared, boundary-correct test');
  assert.ok(decidesAt < cookieAt, 'the host must be decided before the session is sent, not after');
});

test('a domain merely ending in the archive name is not the archive', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('private static boolean isArchiveHost('));
  const body = fn.slice(0, fn.indexOf('\n    }'));

  // the dot is the whole security boundary: without it, evilarchiveofourown.org
  // is accepted as the archive and handed a session cookie
  assert.match(body, /equals\("archiveofourown\.org"\)/, 'the archive itself must match exactly');
  assert.match(body, /endsWith\("\.archiveofourown\.org"\)/, 'a subdomain must be dot-anchored');
});

test('a redirect cannot take a signed-in write off the archive', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const post = java.slice(java.indexOf('private String postOnce('));
  const body = post.slice(0, post.indexOf('\n    }\n'));

  /* Where a redirect points is chosen by the response, not by us. Following one
     unchecked is a request this app makes on someone else's instruction, to any
     host they name — server-side request forgery, and CodeQL called it that. */
  const followAt = body.indexOf('open(next)');
  const checkAt = body.indexOf('isArchiveHost(resolved.getHost())');
  const rebuildAt = body.indexOf('archiveUrl(resolved.getFile())');
  assert.ok(checkAt > 0, 'the redirect target is checked');
  assert.ok(checkAt < followAt, 'and checked before it is followed');
  assert.ok(rebuildAt > checkAt && rebuildAt < followAt,
    'and rebuilt onto the constant host, so no response can choose where a write goes');
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

test('the shell proxy retries transient failures rather than reporting them', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const proxy = java.slice(java.indexOf('private WebResourceResponse proxy(String raw)'),
    java.indexOf('private WebResourceResponse proxyOnce'));
  assert.match(proxy, /for \(int attempt = 0; attempt < \d+/, 'more than one attempt');
  assert.ok(proxy.includes('IOException'), 'a handshake failure is retried, not surfaced');
  // a 404 is an answer; retrying it wastes the reader's time
  assert.match(proxy, /code < 500/, 'only server-side failures are retried');
});

test('a proxied url is not decoded twice', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  // getQueryParameter already decodes; decoding again turns a literal + into a
  // space and eats any %xx the url legitimately contains
  assert.ok(!java.includes('URLDecoder.decode'),
    'the query parameter arrives decoded already');
});

test('reading history is not handed to cloud backup by default', () => {
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:allowBackup="false"/,
    'a record of what someone reads should not sync anywhere unasked');
});

test('reading position is written to one place, not two', () => {
  // the reader once kept position in localStorage while every other view read
  // the database, so Home called a half-read work unopened
  assert.ok(js.includes('saveProgress('), 'the reader writes progress to the store');
  const scroll = js.slice(js.indexOf("addEventListener('scroll'"), js.indexOf("/* ------------------------------------------------------- feeling like an app */"));
  assert.ok(scroll.includes('saveProgress'), 'the scroll handler updates the shared store');
  assert.ok(scroll.includes('readingIsTransient'), 'a search excursion does not move the bookmark');
});

test('the manifest is well-formed XML', () => {
  // a comment inside an attribute list builds "successfully" right up until
  // aapt2 refuses it, which is a slow way to find a typo
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  const opens = (manifest.match(/</g) || []).length;
  const closes = (manifest.match(/>/g) || []).length;
  assert.equal(opens, closes, 'angle brackets must balance');
  assert.ok(!/<[a-z-]+\s[^>]*<!--/i.test(manifest), 'no comment inside a tag');
});

test('the app offers itself for work links and for shared text', () => {
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:pathPrefix="\/works"/, 'work links only, not the whole site');
  assert.match(manifest, /android\.intent\.action\.SEND/, 'sharing a link in works too');
  assert.match(manifest, /android\.intent\.category\.BROWSABLE/);
  // autoVerify would need a file served from the archive's domain, which is
  // not ours to publish — claiming verification we cannot do would be a lie
  assert.ok(!manifest.includes('android:autoVerify="true"'));
});

test('a link that arrives before the page is ready is not lost', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  assert.ok(java.includes('pendingLink'), 'the shell holds it');
  assert.ok(java.includes('takePendingLink'), 'and the page collects it when ready');
  assert.ok(java.includes('onNewIntent'), 'a link arriving while running is handled too');
});

test('a shared link is found by scanning, not by a backtracking pattern', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const send = java.slice(java.indexOf('ACTION_SEND.equals(action)'), java.indexOf('@Override protected void onNewIntent'));
  // shared text is chosen by somebody else; `https?://\S*/works/\d+\S*` reads
  // naturally and backtracks polynomially on "http://http://http://…"
  assert.ok(!/Pattern\s*\n?\s*\.compile/.test(send), 'no regex over shared text');
  assert.ok(send.includes('text.split'), 'each word looked at once');
});

/**
 * The interaction layer must keep up with the components.
 *
 * The app read as inert because three dozen surfaces were styled as tappable
 * and three of them acknowledged a press. That gap reopens every time a
 * component is added and its pressed state is not, so it is checked rather
 * than remembered.
 */
test('every tappable surface has a pressed state', () => {
  // the block appended under "interaction layer" is where presses are defined
  const layer = css.slice(css.indexOf('interaction layer'));

  const selectorsOf = (rule) => rule.split(',').map((s) => s.trim());
  const tappable = new Set();
  for (const m of css.matchAll(/([^{}]+)\{([^}]*cursor:\s*pointer[^}]*)\}/g)) {
    for (const sel of selectorsOf(m[1])) {
      // the last class or id in the selector is what the finger lands on
      const leaf = sel.match(/[.#][a-z0-9_-]+(?![^{]*\()/gi)?.at(-1);
      if (leaf && !sel.includes(':')) tappable.add(leaf);
    }
  }

  // form controls draw their own pressed state; a range thumb is not a button
  const drawsItsOwn = new Set(['#theme', '.swatch', '.slider']);
  const missing = [...tappable]
    .filter((sel) => !drawsItsOwn.has(sel))
    .filter((sel) => !layer.includes(sel));

  assert.deepEqual(missing, [],
    `styled as tappable but never acknowledges a press: ${missing.join(', ')}`);
});

test('the pointer layer and the stylesheet agree on what is tappable', () => {
  const listed = js.slice(js.indexOf('const TAPPABLE'), js.indexOf("].join(',')"));
  const selectors = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(selectors.length > 20, 'the pointer layer should cover the whole app');
  const layer = css.slice(css.indexOf('interaction layer'));
  const orphans = selectors.filter((sel) => !layer.includes(sel.split(' ').at(-1)));
  assert.deepEqual(orphans, [], `JS presses these but the CSS never styles them: ${orphans}`);
});

test('the default tap flash is replaced rather than joined', () => {
  assert.ok(css.includes('-webkit-tap-highlight-color: transparent'),
    "the WebView's own blue flash is the wrong shape, colour and timing");
});

/**
 * Navigation must be acknowledged before the data is fetched, not after.
 *
 * The regression this guards is easy to reintroduce: an await creeps above the
 * navigation, and the app goes back to tap, nothing, eventually a new screen.
 */
test('a destination opens before its data is awaited', () => {
  for (const [fn, nav] of [['openWork', "go('detail'"], ['openChapter', "go('reader'"]]) {
    const body = js.slice(js.indexOf(`async function ${fn}(`));
    const end = body.indexOf('\n}\n');
    const source = body.slice(0, end);
    assert.ok(source.includes(nav), `${fn} should navigate to its destination`);
    assert.ok(source.indexOf(nav) < source.indexOf('await api('),
      `${fn} awaits data before opening the destination, so the tap looks ignored`);
  }
});

test('a late response cannot overwrite a newer navigation', () => {
  // tap one work, go back, tap another: the first must not win when it lands
  for (const fn of ['openWork', 'openChapter']) {
    const body = js.slice(js.indexOf(`async function ${fn}(`));
    const source = body.slice(0, body.indexOf('\n}\n'));
    assert.ok(/const token = \+\+pending/.test(source), `${fn} should claim a token`);
    assert.ok(/token !== pending/.test(source), `${fn} should stand down if superseded`);
  }
});

/**
 * The back preview is driven by the shell, frame by frame, and the shell has
 * no way to know whether the page cleaned up after itself. A preview left
 * applied would leave a screen permanently shrunk and offset.
 */
test('every back-gesture hook the shell calls exists in the page', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  for (const hook of [...java.matchAll(/window\.(__on[A-Za-z]+)\s*&&/g)].map((m) => m[1])) {
    assert.ok(js.includes(`window.${hook} =`), `the shell calls ${hook}, the page never defines it`);
  }
});

test('navigating clears any half-finished back preview', () => {
  const show = js.slice(js.indexOf('function show(name, motion'), js.indexOf('\n}\n', js.indexOf('function show(name, motion')));
  assert.ok(show.includes('clearBackPreview()'),
    'a cancelled or completed gesture must not leave a screen shrunk and offset');
});

/**
 * A dialog opened or closed directly skips the entrance, the exit and the
 * drag — and looks like a web modal again. The helpers are the only door.
 */
test('every dialog opens and closes as a sheet', () => {
  const raw = [...js.matchAll(/^(?!function openSheet).*?\.showModal\(\)/gm)]
    .map((m) => m[0].trim())
    .filter((line) => !line.includes('d.showModal'));
  assert.deepEqual(raw, [], `these open a dialog without the sheet entrance: ${raw.join(' | ')}`);

  const closes = [...js.matchAll(/\$\('#([a-z-]+)'\)\.close\(\)/g)].map((m) => m[1]);
  assert.deepEqual(closes, [], `these close a dialog with no exit: ${closes.join(', ')}`);
});

test('a sheet is dragged by its own furniture, not its contents', () => {
  const drag = js.slice(js.indexOf('function draggableSheet('));
  const body = drag.slice(0, drag.indexOf('\n}\n'));
  assert.ok(body.includes(".closest('.sheet-grab, h2')"),
    'dragging a list inside a sheet is scrolling it; a sheet that closes when you scroll is unusable');
});

/**
 * A database on a phone keeps whatever shape it was exported with. The schema
 * is applied with CREATE TABLE IF NOT EXISTS, which does nothing at all to a
 * table that already exists — so a column added to the schema arrives for new
 * databases and for nobody else.
 *
 * That is how `rec` shipped: the library stopped loading entirely with
 * `no such column: w.rec`, because one missing column takes out the query that
 * lists every work. The shell migrates on open, and this keeps its list honest.
 */
test('the shell can migrate every column the schema declares', () => {
  const schema = readFileSync(new URL('../app/core/store/schema.js', import.meta.url), 'utf8');
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');

  const create = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS works'));
  const declared = [...create.slice(0, create.indexOf('\n);')).matchAll(/^\s{2}([a-z_]+)\s+(TEXT|INTEGER)/gm)]
    .map((m) => m[1])
    .filter((name) => name !== 'work_id');       // the primary key always exists

  const list = java.slice(java.indexOf('WORKS_COLUMNS = {'), java.indexOf('};', java.indexOf('WORKS_COLUMNS = {')));
  const migratable = [...list.matchAll(/\{"([a-z_]+)",/g)].map((m) => m[1]);

  const unmigratable = declared.filter((c) => !migratable.includes(c));
  assert.deepEqual(unmigratable, [],
    `the schema declares these but the shell cannot add them to an older database: ${unmigratable.join(', ')}`);

  const phantom = migratable.filter((c) => !declared.includes(c));
  assert.deepEqual(phantom, [], `the shell would add columns the schema does not declare: ${phantom.join(', ')}`);
});

/**
 * Two elements sharing an id is silent: `$()` returns the first, and the
 * second is simply dead. A settings screen with its own "import" button
 * shipped exactly that — the button existed, was styled, and did nothing.
 */
test('no id appears twice in the markup', () => {
  const ids = [...html.matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const twice = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual([...new Set(twice)], [],
    `these ids appear more than once, so the later one is unreachable: ${twice}`);
});

test('the settings screen reaches its own controls', () => {
  for (const id of ['backup', 'import-replace', 'account', 'library-facts', 'version']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing from the settings markup`);
    assert.ok(js.includes(`#${id}`), `#${id} exists in markup but nothing in app.js uses it`);
  }
});

/**
 * An icon set only works while it is a set.
 *
 * A `use` pointing at a symbol that was never defined renders as nothing at
 * all — no error, no fallback, just a gap where a control's meaning was.
 */
/**
 * An icon reaches the page two ways: written straight into the markup, or
 * named as a string that some helper turns into a `use`. Matching on the
 * helper's name meant the test broke every time one was added — twice already.
 * Matching on the symbol's own name does not care how it got there.
 */
const iconIsReferenced = (id, ...sources) => {
  const text = sources.join('');
  const bare = id.replace(/^i-/, '');
  return text.includes(`href="#${id}"`)
    || new RegExp(`['"\`]${bare}['"\`]`).test(text);
};

const definedIcons = (html) => [...html.matchAll(/<symbol id="(i-[a-z-]+)"/g)].map((m) => m[1]);

test('every icon referenced is defined in the sprite', () => {
  const defined = new Set(definedIcons(html));
  const used = [...`${html}${js}`.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `referenced but never drawn: ${missing.join(', ')}`);
  assert.ok(defined.size >= 12, 'the whole toolbar should be drawn, not part of it');
});

test('every symbol in the sprite is actually used', () => {
  const orphans = definedIcons(html).filter((id) => !iconIsReferenced(id, html, js));
  assert.deepEqual(orphans, [], `drawn but never referenced: ${orphans.join(', ')}`);
});

test('no control is drawn with a font glyph any more', () => {
  // these inherit whatever metrics the system font gives them, which is what
  // made the toolbar read as text rather than as a set of icons
  const glyphs = [...html.matchAll(/[←-⇿⌀-⏿■-◿☀-⛿‹›]/g)]
    .map((m) => m[0]);
  assert.deepEqual(glyphs, [], `Unicode glyphs still used as icons: ${glyphs.join(' ')}`);
  assert.ok(!css.includes('.glyph'), 'the glyph styles should have gone with the glyphs');
});

/**
 * The stylesheet animates; the code decides when the animation is over. If
 * they disagree the class comes off mid-movement, which reads as a snap at the
 * end of something smooth — the exact defect this scale was made to remove.
 */
test('the motion scale is the same in the stylesheet and the code', async () => {
  const { DURATION, EASING } = await import('../app/core/motion.js');
  const tokens = Object.fromEntries(
    [...css.matchAll(/--(dur[a-z-]*|ease-[a-z]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
  );

  assert.equal(tokens['dur-tap'], `${DURATION.tap}ms`);
  assert.equal(tokens['dur-quick'], `${DURATION.quick}ms`);
  assert.equal(tokens['dur'], `${DURATION.base}ms`);
  assert.equal(tokens['dur-enter'], `${DURATION.enter}ms`);
  assert.equal(tokens['ease-out'], EASING.out);
  assert.equal(tokens['ease-in'], EASING.in);
});

test('no motion value is written as a bare literal', () => {
  // one scale, or it stops being a scale
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');            // comments may mention ms
  const literals = [...rules.matchAll(/(?:transition|animation)[^;{]*?(\d+m?s)/g)].map((m) => m[1]);
  assert.deepEqual(literals, [], `durations outside the scale: ${literals.join(', ')}`);
});

test('nothing crossing the bridge can name a host for a write', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('public String archivePost('));
  const body = fn.slice(0, fn.indexOf('\n        }'));

  /* Checking a caller-supplied URL and hoping the check is airtight is the
     weaker arrangement — and the one CodeQL objected to. The host is a
     constant; the page supplies only a path. */
  assert.ok(!/new URL\(\s*(rawUrl|path)\s*\)/.test(body),
    'a write must not be sent to a URL the caller supplied');
  assert.match(body, /archiveUrl\(path\)/, 'the path is resolved against a constant host');

  const build = java.slice(java.indexOf('private static URL archiveUrl('));
  assert.match(build.slice(0, build.indexOf('\n    }')),
    /new URL\("https",\s*"archiveofourown\.org",/,
    'the host is its own argument, not part of a concatenated string');

  const safe = java.slice(java.indexOf('private static String safePath('));
  const guard = safe.slice(0, safe.indexOf('\n    }'));
  assert.match(guard, /startsWith\("\/\/"\)/, 'a protocol-relative //host must be refused');
  assert.match(guard, /contains\("::\/\/"|contains\(":\/\/"\)/, 'a scheme must be refused');
});

/**
 * Every bridge method the page calls must exist in the shell.
 *
 * `markWork` was deleted by an edit that replaced the span of code it happened
 * to sit inside. Java compiled perfectly — a missing method is only missing —
 * and the failure appeared on a real phone, on a real tap, as
 * "native.markWork is not a function". Nothing in the build could have caught
 * it, so this does.
 */
test('the shell exposes every bridge method the page calls', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../app/api.js', import.meta.url), 'utf8');

  const exposed = new Set(
    [...java.matchAll(/@JavascriptInterface\s+public\s+(?:final\s+)?[\w.<>[\]]+\s+(\w+)\s*\(/g)]
      .map((m) => m[1])
  );
  /* app.js reaches the bridge too, through its own handle. Reading only api.js
     is why keepAwake could be deleted and stay deleted for five releases. */
  const page = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
  const called = [...new Set([
    ...[...api.matchAll(/\bnative\.(\w+)\s*\(/g)].map((m) => m[1]),
    /* Optional chaining included: the call that went missing is written
       nativeShell?.keepAwake?.(), and a pattern that only matched a plain dot
       would have gone on not seeing it. */
    ...[...page.matchAll(/\bnativeShell\??\.(\w+)(?:\?\.)?\s*\(/g)].map((m) => m[1]),
    ...[...page.matchAll(/window\.ArchiveNative\??\.(\w+)(?:\?\.)?\s*\(/g)].map((m) => m[1]),
  ])];

  assert.ok(called.length > 5, 'the page should be calling the bridge at all');
  const missing = called.filter((name) => !exposed.has(name));
  assert.deepEqual(missing, [],
    `the page calls these but the shell does not expose them: ${missing.join(', ')}`);
});

/**
 * The reader must carry a way to every other chapter.
 *
 * The control existed and worked, but was styled as a caption — muted text
 * reading "3 / 12" that nobody would think to press — so mid-chapter there
 * appeared to be no chapter navigation at all.
 */
test('the reader offers chapter navigation, and it looks like a control', () => {
  const reader = html.slice(html.indexOf('<section id="reader"'),
    html.indexOf('</section>', html.indexOf('<section id="reader"')));
  assert.ok(reader.includes('id="chappos"'), 'the way to other chapters lives in the reader');
  assert.match(js, /\$\('#chappos'\)\.onclick/, 'and is wired to open the chapter list');

  const rule = css.slice(css.indexOf('#chappos {'), css.indexOf('}', css.indexOf('#chappos {')));
  assert.ok(!/color:\s*var\(--muted\)/.test(rule),
    'muted text reads as a label, and a label is not something anyone presses');
});

test('the chapter list fetches what it needs rather than doing nothing', () => {
  const fn = js.slice(js.indexOf('async function showChapterDrawer('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // it used to return silently when the work in hand was not the one asked for
  assert.ok(/await api\(`\/api\/works\//.test(body), 'it fetches the work it was asked about');
  assert.ok(/toast\(/.test(body), 'and says so when there is genuinely no list');
});

/**
 * The reader must carry its own way out.
 *
 * A card on the Continue reading shelf opens the chapter directly, so the
 * work's page is never visited and Back rightly returns to the shelf. Without
 * a control of its own there was no route to the work at all — no summary, no
 * tags, no chapter list, no kudos.
 */
test('the reader can reach the work it belongs to', () => {
  const reader = html.slice(html.indexOf('<section id="reader"'),
    html.indexOf('</section>', html.indexOf('<section id="reader"')));
  assert.ok(reader.includes('id="to-work"'), 'the way up to the work lives in the reader');
  assert.match(js, /\$\('#to-work'\)\.onclick[\s\S]{0,120}upToWork\(/,
    'and it goes up to the work — which is going back when the work is behind it, '
    + 'and rebuilding the work when it is not, rather than piling one on the other');
});

test('the chapter body is not a horizontal scroll container', () => {
  /* The archive's stylesheet makes #workskin one, and a touch beginning inside
     a scroll container is claimed by the browser before the page sees a
     pointermove — so the page-turn gesture never reached the code that
     implements it. Wide content gets its own scroller instead. */
  const rule = css.slice(css.indexOf('.ao3page #workskin {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /overflow-x:\s*clip/, 'the chapter itself must not scroll sideways');
  assert.match(body, /touch-action:\s*pan-y/, 'and must not claim horizontal touches');
  assert.match(css, /#workskin table[\s\S]{0,200}overflow-x:\s*auto/,
    'anything genuinely wider than the column keeps a scroller of its own');
});

/**
 * `hidden` must mean hidden, everywhere.
 *
 * The attribute works by a user-agent rule of `display: none`, and any author
 * rule setting display beats it. `#tabs` declared `display: flex`, so setting
 * `.hidden` on it did nothing: the tab bar stayed on screen in the reader, over
 * the chapter navigation — which was present and correct underneath it the
 * whole time.
 *
 * There was already a test for this exact bug shape, but it only looked at
 * dialogs. The rule below is global, and so is this.
 */
test('hidden is never overridden by a display rule', () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'one global rule, because the next element to grow a display rule will not remember either');
});

test('elements the code hides are not given a competing display', () => {
  const hiddenInJs = [...new Set(
    [...js.matchAll(/\$\('#([a-z0-9-]+)'\)\.hidden\s*=/g)].map((m) => m[1])
  )];
  assert.ok(hiddenInJs.length > 3, 'the app should be hiding things by attribute');

  // the global rule above is what saves these; without it each is a bug
  for (const id of hiddenInJs) {
    const rule = css.match(new RegExp(`^#${id}\\s*\\{([^}]*)\\}`, 'm'));
    if (!rule) continue;
    if (/display:\s*(flex|block|grid|inline)/.test(rule[1])) {
      assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
        `#${id} sets display and is hidden by attribute; only the global rule makes that safe`);
    }
  }
});

test('the reader bar sits above anything sharing the bottom edge', () => {
  const chapnav = css.slice(css.indexOf('#chapnav {'), css.indexOf('}', css.indexOf('#chapnav {')));
  const tabs = css.slice(css.indexOf('#tabs {'), css.indexOf('}', css.indexOf('#tabs {')));
  const z = (rule) => Number(rule.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
  assert.ok(z(chapnav) > z(tabs),
    'both are fixed to the bottom; the reader\'s own controls must not end up underneath');
});

/**
 * The reader's bar belongs to the column of text above it.
 *
 * It spans the window so its background does, but a full-width space-between
 * threw its controls to opposite edges with a void between them, while the
 * prose sat in a 40em measure up the centre.
 */
test('the chapter bar keeps to the reading measure', () => {
  const rule = css.slice(css.indexOf('#chapnav {'), css.indexOf('}', css.indexOf('#chapnav {')));
  assert.match(rule, /padding-inline:\s*max\([^)]*calc\(\(100% - \d+rem\)/,
    'the controls are held to a measure rather than flung to the window edges');
  assert.ok(!/justify-content:\s*space-between/.test(rule),
    'space-between across a tablet is what put an ocean between the controls');
});

test('the chapter bar is defined once', () => {
  // three separate #chapnav blocks had accumulated, each amending the last
  const blocks = [...css.matchAll(/^#chapnav \{/gm)].length;
  assert.equal(blocks, 1, 'one rule, not a stack of amendments to it');
});

/**
 * A chapter must say what it belongs to.
 *
 * It began with bare prose: nothing named the work, and scrolling to the top
 * to look for its front matter found nothing at all. The only route back was
 * an unlabelled book icon in a row of six.
 */
test('the reader names the work, above the chapter', () => {
  const reader = html.slice(html.indexOf('<section id="reader"'),
    html.indexOf('</section>', html.indexOf('<section id="reader"')));
  assert.ok(reader.includes('id="reader-head"'), 'the chapter carries a head');
  assert.ok(reader.indexOf('id="reader-head"') < reader.indexOf('id="workskin"'),
    'and it sits above the prose, where scrolling up arrives');

  for (const id of ['rh-title', 'rh-by', 'rh-chapter']) {
    assert.ok(reader.includes(`id="${id}"`), `#${id} is missing`);
    assert.ok(js.includes(`$('#${id}').textContent`), `#${id} is never filled in`);
  }
});

test('the head of the chapter names the work but does not navigate', () => {
  /* It carried a "the whole work" link, which went exactly where the book
     button in the chapter bar already goes — two routes to one place, one of
     them a text link in the middle of the reading column where nothing else is
     tappable. The bar has the button, on every work. */
  assert.ok(!html.includes('id="rh-go"'), 'the duplicate link is gone');
  assert.ok(!js.includes("$('#reader-head').onclick"), 'and the head is not a control');
  assert.ok(html.includes('id="to-work"'), 'the bar still carries the one route');
});

/**
 * Backwards from the first chapter is the work itself.
 *
 * The right swipe walked back a chapter at a time and then stopped dead at the
 * first one, resisting — honest about there being no chapter zero, wrong about
 * there being nowhere to go.
 */
test('swiping back from the first chapter leaves for the work', () => {
  const call = js.slice(js.indexOf("wireSwipe($('#reader')"));
  const body = call.slice(0, call.indexOf('});') + 3);
  assert.match(body, /current\.chapter > 1/, 'a later chapter steps back one');
  assert.match(body, /upToWork\(current\.workId\)/,
    'and the first one goes up to the work rather than pushing it, which is what '
    + 'made Reader and Work lead to each other for ever');
});

test('forwards still stops at the end of the work', () => {
  // past the last chapter there genuinely is nothing, and the resistance says so
  const wire = js.slice(js.indexOf('function wireSwipe('));
  const body = wire.slice(0, wire.indexOf('\n}\n'));
  assert.match(body, /canLeft \?\?[^\n]*current\.chapter < current\.count/,
    'the forward limit is still the last chapter');
  assert.match(body, /canLeft \?\?[^\n]*!viewingArchive/,
    'and an archived copy turns no pages at all: the chapter beside it is the current text');
});

/**
 * The app must be allowed to see what can open a web link.
 *
 * From Android 11 an app cannot see what else is installed unless it declares
 * what it is looking for. Without that, the chooser for "open on the archive"
 * resolved to nothing and reported that no app could perform the action — not
 * because no browser was installed, but because this app was not allowed to
 * know.
 */
test('the manifest declares what it needs to see', () => {
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  const queries = manifest.slice(manifest.indexOf('<queries>'), manifest.indexOf('</queries>'));
  assert.ok(queries.includes('android.intent.action.VIEW'), 'it looks for handlers of web links');
  assert.match(queries, /android:scheme="https"/, 'and says which scheme, rather than asking for everything');
});

test('a browser is chosen by name, not left to a chooser to work out', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('private void toBrowser('));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));

  /* Asking a chooser to exclude this app produced an empty chooser saying no
     app could perform the action, on a phone with browsers on it. Browsers are
     found by asking who handles an ordinary web address — an app that merely
     registered an archive link does not answer that — and the link is handed
     to one of them explicitly. */
  assert.match(body, /queryIntentActivities/, 'it asks who handles a web address');
  assert.match(body, /setPackage\(pkg\)/, 'and names the browser on the intent it launches');
  assert.ok(!body.includes('EXTRA_EXCLUDE_COMPONENTS'),
    'excluding ourselves from a chooser is what did not work');
  assert.match(body, /__noBrowser/, 'and it says so plainly when there is genuinely nobody');
  assert.ok(js.includes('window.__noBrowser ='), 'which the page defines');
});

/**
 * The version shown must be the version running.
 *
 * Settings reported v0.15.0 on a device running v0.19.0. Four places declared
 * a version — the page, the manifest, package.json and the git tag — and each
 * was maintained by remembering to. They had drifted to four different
 * answers. The build stamps the tag onto the package; the page asks the shell.
 */
test('the page does not carry its own idea of the version', () => {
  const line = js.match(/const VERSION = [\s\S]{0,220}/)?.[0] ?? '';
  assert.ok(!/v\d+\.\d+\.\d+/.test(line),
    'a version written in the page is a fourth place to remember, and it drifted five releases');
  assert.match(js, /fetch\('\/version\.txt'\)/, 'it reads what the build wrote');
});

test('the build writes the version where the page can read it', () => {
  const build = readFileSync(new URL('../android/build.sh', import.meta.url), 'utf8');
  assert.match(build, /git describe --tags/, 'the tag is the source of truth');
  assert.match(build, /version\.txt/, 'and it is written into the assets the page is served from');
});

test('the manifest declares no version of its own', () => {
  /* An attribute written there beats anything the build supplies, which is how
     the package came to report 0.1 through four attempts at stamping it. */
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  const tag = manifest.slice(manifest.indexOf('<manifest'), manifest.indexOf('>', manifest.indexOf('<manifest')));
  assert.ok(!/versionName|versionCode/.test(tag), 'the build generates them into a copy');
});

test('no XML comment carries a double hyphen', () => {
  /* `--version-name` inside a comment is not well-formed XML. The manifest
     became invalid, the build failed, and four rounds of checking read a stale
     APK because the failure was filtered out of the output. */
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  for (const c of manifest.match(/<!--[\s\S]*?-->/g) ?? []) {
    assert.ok(!c.slice(4, -3).includes('--'), `a comment contains "--", which XML forbids: ${c.slice(0, 60)}`);
  }
});

test('the shell reports the version it was stamped with', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /getPackageInfo\(getPackageName\(\), 0\)\.versionName/,
    'read from the package rather than a constant beside it');
});

test('the settings icon is a cog, not a sun', () => {
  const symbol = html.slice(html.indexOf('<symbol id="i-settings"'),
    html.indexOf('</symbol>', html.indexOf('<symbol id="i-settings"')));
  /* It was a circle with eight strokes radiating from it — which is a sun, and
     it sat two buttons from the actual brightness control. */
  const rays = [...symbol.matchAll(/M[\d.]+ [\d.]+v[\d.]+/g)].length;
  assert.ok(rays < 4, 'radiating strokes read as a sun, whatever they were meant to be');
  assert.ok(symbol.includes('<circle'), 'a cog has a hub');
});

/**
 * Kept chapters must be reachable.
 *
 * Versioning archived every replaced chapter from the day it went in, and
 * nothing surfaced one — which makes keeping them a gesture rather than a
 * feature. These copies are not on the archive any more; this is the only
 * place they exist.
 */
test('a work with earlier versions offers them', () => {
  const fn = js.slice(js.indexOf('function archiveActions('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /w\.versions > 0/, 'offered only when there is something to look at');
  assert.match(body, /showVersions\(/, 'and it opens the list');
});

test('reading an archived copy does not move your place', () => {
  const fn = js.slice(js.indexOf('async function openVersion('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /readingIsTransient = true/, 'an old copy must not move the bookmark');
  assert.match(body, /viewingArchive = true/, 'and the page turns know to refuse');
  assert.match(body, /#prev'\)\.disabled = true/, 'as do the buttons');
});

test('both backends can hand back a kept chapter', () => {
  const api = readFileSync(new URL('../app/api.js', import.meta.url), 'utf8');
  const serve = readFileSync(new URL('../tools/serve.mjs', import.meta.url), 'utf8');
  for (const [name, src] of [['api.js', api], ['serve.mjs', serve]]) {
    assert.match(src, /FROM chapter_versions WHERE work_id = \?/, `${name} lists versions`);
    assert.match(src, /versions\\\/(\(\\d\+\)|\\d)/, `${name} routes to one`);
  }
});

/**
 * A work can be fetched again from the archive.
 *
 * Some works came in from EPUBs and carry the exporter's marks rather than the
 * archive's — a table of contents counted as a first chapter, an empty last
 * one. Repairing that in the database means guessing at what the archive meant.
 */
test('a work offers to fetch itself again', () => {
  const fn = js.slice(js.indexOf('function archiveActions('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /Fetch again/, 'the control exists');
  assert.match(body, /addWork\(String\(w\.work_id\)\)/, 'and it asks the archive for this work');
});

/**
 * The app must keep what it replaces.
 *
 * Versioning was implemented once, in the development server, and the shell
 * never had it: it deleted a work's chapters outright and inserted the new
 * ones. So a work fetched again on the phone lost whatever the author had
 * changed — while the app said the opposite, because the claim had been
 * checked against the other path.
 */
test('the shell archives chapters before it replaces them', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const archiveAt = java.indexOf('archiveChapters(id, chapters)');
  const deleteAt = java.indexOf('db.delete("chapters", "work_id = ?"');
  assert.ok(archiveAt > 0, 'the shell archives at all');
  assert.ok(archiveAt < deleteAt, 'and does it before the rows are gone');
  assert.match(java, /insert\("chapter_versions"/, 'into the same table the other path uses');
});

test('an unchanged refetch archives nothing', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('private int archiveChapters('));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  // otherwise every refetch buries the real changes under untouched chapters
  assert.match(body, /continue;\s*\/\/ unchanged/, 'chapters that did not change are left alone');
  assert.match(body, /"removed"/, 'and a chapter with no replacement is recorded as gone');
});

/**
 * The app can bring itself up to date.
 *
 * Syncing only ever existed as a script on a laptop, so a bookmark made on the
 * archive stayed invisible until somebody ran a tool and carried a database
 * across. The dangerous part is pace: an app that walks somebody's bookmarks
 * impatiently gets their account limited and they will not know why.
 */
test('settings offers a sync, and it can be stopped', () => {
  for (const id of ['sync-now', 'sync-stop', 'sync-status']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing`);
  }
  assert.match(js, /\$\('#sync-stop'\)\.onclick/, 'a long job must be interruptible');
});

/*
 * This used to assert that the sync spaced its own work downloads — which is
 * the bug written down as a requirement. A second clock is not a schedule:
 * an author job and a bookmark sync each waiting their own half minute made
 * requests twice as fast as either believed it was.
 */
test('a sync owns no download loop of its own', () => {
  const fn = js.slice(js.indexOf('async function syncBookmarks('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /jobs\.add\(\{ author: 'New bookmarks'/,
    'the works it finds go to the one queue, like every other batch');
  assert.ok(!/fetchWorks\(/.test(body),
    'and it does not fetch them itself, at a rate only it knows about');
  assert.match(body, /shouldStop: \(\) => stopRequested/, 'the listing can still be stopped');
});

test('the sync reads who is signed in rather than asking', () => {
  const fn = js.slice(js.indexOf('async function whoAmI('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /signedInUser\(/, 'the archive already knows whose bookmarks these are');
});

/**
 * A work can be known without being held, and opening one gets it.
 *
 * The listings describe thousands of works never downloaded. Navigating to one
 * is the instruction to have it — the same way choosing this app for a link
 * is — so it fetches on arrival rather than asking again with a button that
 * did exactly what Fetch again does, by the same call.
 */
test('a work with no text fetches itself when opened', () => {
  const fn = js.slice(js.indexOf('async function openWork('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!w\.has_text\) await fetchOnArrival\(/,
    'opening it is the instruction to have it');

  const helper = js.slice(js.indexOf('async function fetchOnArrival('));
  const inner = helper.slice(0, helper.indexOf('\n}\n'));
  assert.match(inner, /await addWork\(String\(workId\)\)/, 'and it is one request');
  assert.match(inner, /token !== pending/,
    'which is dropped if the reader has moved on while it ran');
});

test('there is one way to fetch a work, not two', () => {
  /* "Fetch this work" and "Fetch again" called the identical function on the
     same work id; only the label and the state differed. */
  /* Scoped to the work page, which is where the two of them were. Fetching an
     author's catalogue is a different thing and lives somewhere else. */
  const fn = js.slice(js.indexOf('async function openWork('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const buttons = [...body.matchAll(/textContent = '(Fetch[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(buttons)].sort(), ['Fetching…'],
    `only the in-progress label remains: ${buttons}`);
});

test('a shelf row says when a work is not downloaded', () => {
  assert.match(js, /not-held/, 'the row is marked');
  assert.match(css, /\.not-held\s*\{/, 'and the mark is styled');
});

/**
 * Tapping an author asks what they have written, not only what is held.
 *
 * An index page describes twenty works for one request, so a catalogue is
 * cheap to know and expensive only to read. The size decides whether the app
 * walks it unasked.
 */

test('listing works never overwrites one already held', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('public String saveStubs('));
  const body = fn.slice(0, fn.indexOf('\n        }\n'));
  /* A blurb knows less than the work page a held copy came from, so a stub
     must never replace one. */
  assert.match(body, /CONFLICT_IGNORE/, 'existing rows are left alone');
  assert.match(body, /v\.put\("has_text", 0\)/, 'and what is written says the text is still to come');
});

/**
 * Downloading an author's catalogue is hundreds of requests over an hour.
 *
 * That is fine to spend, but not fine to spend invisibly: an app that is
 * quietly busy for an hour and never says so is indistinguishable from one
 * that is broken.
 */
test('asking about an author queues the works, not just their titles', () => {
  const fn = js.slice(js.indexOf('async function walkAuthor('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  /* Listing them is the cheap half. The point of asking about an author is to
     keep what they wrote. */
  assert.match(body, /jobs\.add\(\{/, 'what is missing is queued for download');
  assert.match(body, /needsFetching\(works\)/,
    'and what is already here and current is not fetched again');
});

/*
 * "Do we have a row for it" was the wrong question, and it was asked straight
 * after writing the stubs for that very page — so every work in an index
 * looked like one the app already had. It also stranded the 2,753 works
 * described from listings and never downloaded: a description counts as a row,
 * so opening their author could never fetch them.
 */
test('an index says what is worth asking the archive for', () => {
  const fn = js.slice(js.indexOf('function needsFetching('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!held\.has_text\) return true/,
    'a work described but not held is worth a request');
  assert.match(body, /listed && held\.updated && listed > held\.updated/,
    'so is one the index says changed after the copy on disk');
  assert.match(body, /work_id IN \(\$\{marks\}\)/,
    'and the checking is one query, not one per work');
  assert.ok(!/workIsHeld/.test(body),
    'having a row is not the same as having the work');
});

test('a listing date can be compared with a stored one', async () => {
  const { blurbDate } = await import('../app/core/ao3/parse.js');
  assert.equal(blurbDate({ updatedAt: 1724630400 }), '2024-08-26',
    'the epoch in the comment needs no parsing and cannot be ambiguous');
  assert.equal(blurbDate({ datetime: '26 Aug 2025' }), '2025-08-26');
  assert.equal(blurbDate({ datetime: '3 Jan 2021' }), '2021-01-03',
    'single-digit days are padded, or string comparison stops working');
  assert.equal(blurbDate({ datetime: 'sometime' }), null);
  assert.equal(blurbDate(null), null);
});

test('progress is reported as it happens', () => {
  const wiring = js.slice(js.indexOf('const jobs = createQueue('));
  const body = wiring.slice(0, wiring.indexOf('\n});'));
  assert.match(body, /e\.job\.added.*e\.job\.total/s, 'each work says which of how many');
  assert.match(body, /keepQueue\(\)/,
    'and what is left survives the app closing');
});

/*
 * The queue was saved on every event and then thrown away on the way back in.
 * `load` spread whatever it found into an object literal, which is right for
 * the settings and quietly wrong for a list: spreading an array gives
 * {0:…, 1:…}, which is not iterable, so restoring the queue threw. Run the
 * real function here rather than reading it, because the shape is the bug.
 */
test('a list comes back a list', () => {
  const start = js.indexOf('const load = (key, fallback) =>');
  const body = js.slice(start, js.indexOf('\n};\n', start) + 3);
  const stored = { 'fanfolio.jobs': '[{"author":"a"},{"author":"b"}]',
                   'fanfolio.prefs': '{"size":"18px"}' };
  const load = new Function('localStorage',
    `${body} return load;`)({ getItem: (k) => stored[k] ?? null });

  const jobs = load('fanfolio.jobs', []);
  assert.ok(Array.isArray(jobs), 'the queue is restored as an array, not as {0:…,1:…}');
  assert.equal(jobs.length, 2);
  assert.doesNotThrow(() => { for (const j of jobs) void j; }, 'and can be walked');

  assert.deepEqual(load('fanfolio.prefs', { size: '16px', face: 'serif' }),
    { size: '18px', face: 'serif' },
    'while settings still layer over their defaults, so a new key has a value');
  assert.deepEqual(load('nothing.saved', []), [], 'nothing saved is an empty list');
});

/*
 * A 5xx from the archive is Cloudflare saying the origin did not answer it,
 * and it comes and goes: the same address, seconds apart, answered 200 and
 * then 525. Every one of these was being treated as a refusal.
 */
/*
 * An author's catalogue takes an hour to come down, and the shelves it fills
 * were redrawn only when the whole job ended — so the library grew all
 * afternoon while the home screen showed what it had shown at the start.
 */
/*
 * A chapter is author-written HTML with an author-written stylesheet applied
 * unscoped beside it. 195 works in my library carry a skin. Any of them can
 * make the document wider than the screen, and when that happens the reading
 * column centres inside the wider document and every line is cut at both
 * edges.
 */
/*
 * A phone that folds changes the width of the column mid-chapter. The
 * manifest claims screenSize and screenLayout so the activity is not
 * recreated — which is what keeps the chapter open and the queue running —
 * and the cost is that nothing told the page, so it kept the width it was
 * laid out for and every line was cut at both edges.
 */
test('the page is told when the screen changes shape', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /public void onConfigurationChanged\(/,
    'the manifest claims the config change, so the activity has to handle it');
  const fn = java.slice(java.indexOf('public void onConfigurationChanged('));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  assert.match(body, /super\.onConfigurationChanged/);
  assert.match(body, /window\.__resized/, 'and tell the page, which is what reflows');
  assert.match(js, /window\.__resized = onScreenResized/, 'which the page answers to');
});

test('a fold does not lose your place', () => {
  const fn = js.slice(js.indexOf('function blockAtTop('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /getBoundingClientRect/);
  assert.match(body, /index: i, within/,
    'a pixel offset means nothing at a different width; a paragraph is the same paragraph');
});

/*
 * A `reading` row is not proof anybody read anything — an import writes one
 * for every work marked for later. So "Continue reading" asked for chapter 2
 * or later, and a work you were partway through the first chapter of never
 * appeared: most of them, and every single-chapter work there is.
 */
/*
 * Opened is opened. Where you are and whether you have it open are two
 * different facts, and only the first is worth protecting from a glance.
 */
test('a library already full of works called unfinished is put right', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('private void repairCompleteness('));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  assert.match(body, /chapter_count >= chapters_planned/,
    'what the archive already said is on disk; nothing needs fetching again');
  assert.match(body, /COALESCE\(complete, 0\) = 0/,
    'and a work already marked finished is left alone');
  assert.match(java, /migrateTable\(db, "reading"[\s\S]{0,300}repairCompleteness\(db\)/,
    'it runs where every other repair does, on opening the library');
});

test('a peek from a search still counts as having opened the work', () => {
  const fn = js.slice(js.indexOf('async function openChapter('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const opened = body.indexOf('markOpened(workId)');
  assert.ok(opened > -1, 'the open is recorded however the reader arrived');
  assert.ok(!/if \(!transient\) markOpened/.test(body),
    'only the position is skipped for a peek, never the fact of opening');
});

test('a glance expires into reading', () => {
  const start = js.indexOf('posTimer = setTimeout(');
  const body = js.slice(start, js.indexOf('}, 400);', start));
  assert.match(body, /Math\.abs\(window\.scrollY - transientFrom\) > window\.innerHeight/,
    'arriving from a search and then reading for an hour saved nothing at all');
  assert.match(body, /!transientForever/,
    'except an archived version, whose offsets point at words you no longer have');
  const archive = js.slice(js.indexOf('viewingArchive = true;'));
  assert.match(archive.slice(0, 400), /transientForever = true/);
});

test('opening a work is what puts it on the continue shelf', () => {
  const fn = js.slice(js.indexOf('async function openChapter('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!transient\) saveProgress\(workId, number, offset\)/,
    'nothing recorded an open before; only a scroll did');
  assert.ok(!/saveProgress\(workId, number, 0\)/.test(body),
    'and it is written at the offset it opens to, so it cannot cost somebody their place');
});

test('the shell migrates every reading column the query asks for', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const block = java.slice(java.indexOf('READING_COLUMNS = {'));
  const migrated = new Set([...block.slice(0, block.indexOf('};')).matchAll(/\{"([a-z_]+)"/g)]
    .map((m) => m[1]));

  const table = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS reading'));
  const declared = [...table.slice(0, table.indexOf('\n);')).matchAll(/^ {2}([a-z_]+)\s+[A-Z]/gm)]
    .map((m) => m[1]).filter((name) => name !== 'work_id');

  /* A column the schema declares and the shell does not add is a column an
     upgraded library does not have — and the library screen is one SELECT, so
     a single missing one takes the whole thing out. */
  assert.deepEqual(declared.filter((name) => !migrated.has(name)), []);
});

test('the shell and the query agree on how many chapters a work has', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const body = java.slice(java.indexOf('public String markFinished('));
  const sql = body.slice(0, body.indexOf('} catch')).replace(/"\s*\+\s*"/g, '').replace(/\s+/g, ' ');

  /* Finished has to mean exactly not-still-reading, and the two are written
     in different languages in different files. The shell cannot import the
     predicate, so it is held to it here. */
  assert.ok(sql.includes(CHAPTERS.replace(/\s+/g, ' ')),
    'the shell counts a finished work the same way the reading states do');
  assert.ok(!/chapter_count\b(?![,)])/.test(sql.replace(CHAPTERS.replace(/\s+/g, ' '), '')),
    'and does not fall back on the metadata column by itself');
});

test('the reader writes down reaching the end of the last chapter', () => {
  const fn = js.slice(js.indexOf('function noteReachedTheEnd('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /readingIsTransient/,
    'a peek from a search result that lands near the foot of a chapter is not finishing a work');
  assert.match(body, /finishedThisVisit === current\.workId/,
    'the last screenful fires the scroll handler over and over');
  assert.match(body, /markFinished\(current\.workId, true\)/);

  const opened = js.slice(js.indexOf('async function openChapter('));
  assert.match(opened.slice(0, opened.indexOf('\n}\n')), /if \(!transient\) noteReachedTheEnd\(\)/,
    'a last chapter that fits on one screen has no scrolling left to say it with');
});

test('both backends agree on what continue reading means', () => {
  const shelfOf = (src_) => {
    const at = src_.indexOf("key: 'reading', title: 'Continue reading'");
    return src_.slice(at, src_.indexOf('},', at)).replace(/\s+/g, ' ');
  };
  const native = shelfOf(readFileSync(new URL('../app/api.js', import.meta.url), 'utf8'));
  const server = shelfOf(readFileSync(new URL('../tools/serve.mjs', import.meta.url), 'utf8'));
  assert.match(native, /STATES\.reading/,
    'the shelf asks the Library filter its question, rather than writing out its own');
  assert.ok(!/opened_at IS NOT NULL/.test(native),
    'a predicate spelled out here is one that can disagree with the one over there');
  assert.match(native, /COALESCE\(r\.opened_at, r\.updated_at\) DESC/,
    'most recently opened first, whichever shelf it was opened from');
  assert.equal(native, server, 'the two backends must not drift on this');
});

test('nothing in a chapter can make the page scroll sideways', () => {
  const rule = css.slice(css.indexOf('html, body {'));
  const body_ = rule.slice(0, rule.indexOf('}'));
  assert.match(body_, /overflow-x: clip/,
    'clip, not hidden: hidden makes a scroll container and the sticky header stops sticking');

  const wide = css.slice(css.indexOf('#workskin table, #workskin pre'));
  assert.match(wide.slice(0, wide.indexOf('}')), /overflow-x: auto/,
    'and what is genuinely wide scrolls in its own box rather than being thrown away');
  assert.match(css, /#workskin, #endnotes \{ overflow-wrap: break-word; \}/,
    'a URL is one word and one word can be wider than a phone');
});

test('the shelves keep up with what is arriving', () => {
  const fn = js.slice(js.indexOf('async function refresh('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /force \|\| \$\(`#\$\{view_\}`\)\.hidden \|\| window\.scrollY < 40/,
    'a screen being read is not rebuilt under the reader; a hidden one is rebuilt freely');
  assert.match(body, /buildHome\(\), buildStartHere\(\)/,
    'the tiles are rebuilt with the shelves — forgetting them is what made this inconsistent');
  assert.match(body, /works && settled\('library'\)/,
    'and the list only when the set of works has actually changed');

  const soon = js.slice(js.indexOf('function freshenSoon('));
  assert.match(soon.slice(0, soon.indexOf('\n}\n')), /if \(freshenTimer\) return/,
    'two works landing together do not cause two rebuilds');
});

test('progress redraws, not only completion', () => {
  const start = js.indexOf('const jobs = createQueue({');
  const body = js.slice(start, js.indexOf('\n});\n', start));
  const progress = body.indexOf("e.type === 'progress'");
  const finished = body.indexOf("e.type === 'finished'");
  assert.ok(progress > -1 && finished > progress);
  assert.match(body.slice(progress, finished), /freshenSoon\(\)/,
    'an hour of downloading should not look like an hour of nothing happening');
  assert.match(body, /e\.type === 'finished'\) \{/,
    'and a job that ends refreshes whatever state it ended in');
});

/*
 * Five clocks. A walk, a download job, a bookmark sync and anything told to
 * start now each waited its own half minute, so four things running together
 * made a request every seven seconds while each believed it was making one
 * every twenty-eight. The archive sees the total, not the intent — which is
 * why a single fetch from a work page was never throttled and a queue always
 * was. The headers were identical the whole time.
 */
test('everything asked of the archive shares one pace', () => {
  const fn = js.slice(js.indexOf('function paced('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /await turn/, 'turns are taken, not taken simultaneously');
  assert.match(body, /nextGap\(\) - \(now - lastArchiveAt\)/,
    'measured from the last request anyone made, not from this caller last time');
  assert.match(body, /coolUntil - now/, 'and a cool-off everything honours');

  const page = js.slice(js.indexOf('async function archivePage('));
  assert.match(page.slice(0, page.indexOf('\n}\n')), /paced\(\(\) => fetch\(/,
    'index pages go through it');
  assert.match(js, /runTask: \(workId\) => paced\(/, 'and so does every work a job fetches');
});

test('being told to slow down slows everything, not just whoever was told', () => {
  const fn = js.slice(js.indexOf('function slowDown('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /coolUntil = Math\.max\(coolUntil/,
    'a longer cool-off already running is not shortened by a later one');
  assert.match(js, /if \(res\.status === 429\) slowDown\(\)/,
    'a 429 on an index page slows the downloads too');
  assert.match(js, /answered 429\|rate limit\|too many requests/i,
    'and a 429 on a work slows the walks');
});

test('a page the archive fumbled is asked for again', () => {
  const fn = js.slice(js.indexOf('async function archivePage('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /attempt < attempts/, 'more than one try');
  assert.match(body, /await wait\(retryDelay\(attempt\)\)/, 'and longer each time');
  assert.match(body, /if \(!isTransient\(failure\.message\)\) throw failure/,
    'a 404 is the archive answering, and is not asked again');
});

test('one bad page does not lose the pages after it', () => {
  const fn = js.slice(js.indexOf('async function walkAuthor('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const loop = body.slice(body.indexOf('for (let page = Math.max(2'));
  assert.match(loop, /try \{[\s\S]*catch \(e\) \{[\s\S]*missed\+\+/,
    'an author with 44 works is three pages, and page two throwing took two of them');
  assert.match(body, /if \(missed\) throw/,
    'but the walk still counts as unfinished, so the totals are not recorded');
});

test('a work that could not be fetched is not called deleted', () => {
  assert.ok(!/deleted or locked/.test(js),
    'the archive answering 500 is not the same as a work being gone');
});

test('what is owed is picked up again after a restart', () => {
  const fn = js.slice(js.indexOf('function resumeJobs('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /!held\.has\(id\)/,
    'anything fetched in the meantime is dropped rather than fetched twice');
});

/*
 * Resuming used to ask the bridge about one work at a time, and it ran before
 * the home screen was built — so a queue of a few hundred put a few hundred
 * round trips to Java in front of the first thing the reader looks at, and
 * the app opened on an empty page.
 */
/*
 * The same confusion, in the last place it survived. The bookmark sync walks
 * backwards and stops at the bookmarks it already has — and it decided that by
 * asking whether there was a row, so a work described by a listing and never
 * downloaded counted as one it had. With thousands of those in a library, the
 * walk stopped at the first one and reported itself up to date.
 */
/*
 * How much, what went wrong, and where it stands are three separate things.
 * They were one chained expression, so making the count read differently for a
 * record with no total silently took the skipped count, the state and the time
 * with it — a finished job became the words "36 downloaded" and nothing else.
 */
/*
 * The queue lived in web storage and was written as a description, then built
 * back up from that description. Every round trip through those two lost
 * something: first the totals, then the times, then the work still owed. The
 * cure is not a better description — it is to write down the job and read the
 * job back, beside the works rather than beside the browser.
 */
test('the queue is kept with the library, not with the browser', () => {
  const keep = js.slice(js.indexOf('function keepQueue('));
  assert.match(keep.slice(0, keep.indexOf('\n}\n')),
    /saveMeta\(QUEUE_KEY, JSON\.stringify\(list\)\)/,
    'so it survives site data being cleared, and travels in a backup');
  assert.match(keep.slice(0, keep.indexOf('\n}\n')), /save\(JOBS_KEY, list\)/,
    'with the browser as the fallback when there is no library open');

  const read = js.slice(js.indexOf('function storedQueue('));
  const rbody = read.slice(0, read.indexOf('\n}\n'));
  assert.match(rbody, /readMeta\(QUEUE_KEY\)/);
  assert.match(rbody, /if \(older\.length && isNative\) saveMeta/,
    'a queue saved by an older version is carried over, not dropped');

  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /public String saveMeta\(String key, String value\)/,
    'and the shell has one way to write it');
});

test('a job row says how much, what went wrong, and where it stands', () => {
  const paint = js.slice(js.indexOf('function paintJobs('));
  const body = paint.slice(0, paint.indexOf('\n}\n'));
  assert.match(body, /how\.textContent = count \+ trouble \+ standing/,
    'three things, each said or not on its own');
  assert.match(body, /const standing = counting \? ''/,
    'so a row with an unusual count keeps its state and its time');
  assert.match(body, /finished\$\{job\.at \? ` \$\{whenShort\(job\.at\)\}` : ''\}/);
});

test('a finished job can always be asked for again', () => {
  const fn = js.slice(js.indexOf('function runAgain('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(job\.unfinished && jobs\.rerun\(job\.id\)\) return/,
    'what it could not get, when the ids are still to hand');
  assert.match(body, /job\.author === STUBS_JOB\.author/,
    'and otherwise worked out from what the job was: the backlog off the database');
  assert.match(body, /walkAuthor\(job\.author, \{ listing: part, jobId: id \}\)/,
    'or the author walked again');

  const paint = js.slice(js.indexOf('function paintJobs('));
  assert.match(paint.slice(0, paint.indexOf('\n}\n')), /'Ask for this again', \(\) => runAgain\(job\)/,
    'a record that cannot be acted on is only half a record');
});

test('the bookmark sync stops at what it holds, not at what it has heard of', () => {
  const fn = js.slice(js.indexOf('const isHeld = (id) => {'));
  const body = fn.slice(0, fn.indexOf('\n    };'));
  assert.match(body, /heldWithText\(\[key\], \{ unknownIsHeld: false \}\)/,
    'a description is not a bookmark you have');
  assert.match(body, /known\.has\(key\)/, 'asked once per work, not once per page it appears on');
});

test('there is one question about whether a work is held', () => {
  assert.ok(!/workIsHeld/.test(js),
    'two spellings of it is how one of them stayed wrong for so long');
  assert.equal([...js.matchAll(/function heldWithText\(/g)].length, 1);
});

test('resuming asks whether the work is here, not whether a row is', () => {
  const fn = js.slice(js.indexOf('function heldWithText('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /has_text = 1/,
    'a listing writes a row for every work it names, so a row is a description');
  assert.match(body, /work_id IN \(\$\{marks\}\)/, 'one statement, not one per work');
  assert.match(body, /i \+= 400/, 'in blocks, because a statement can only bind so many');

  const resume = js.slice(js.indexOf('function resumeJobs('));
  const rbody = resume.slice(0, resume.indexOf('\n}\n'));
  assert.match(rbody, /heldWithText\(ids, \{ unknownIsHeld: false \}\)/,
    'every work still queued is a stub, so asking for a row emptied every job on launch');
  assert.ok(!/heldAmong/.test(js),
    'and the question that was wrong to ask is gone, not merely unused');
});

test('the home screen is not built last', () => {
  const fn = js.slice(js.indexOf('async function start('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const painted = body.indexOf('refresh(');
  const chores = body.indexOf('resumeJobs()');
  assert.ok(painted > -1 && chores > -1);
  assert.ok(painted < chores,
    'the screen the reader is looking at comes before the housekeeping');
  assert.match(body, /try \{ chore\(\); \} catch/,
    'and one chore failing does not take the rest of the startup with it');
});

test('a queued job can be started, reordered or deleted; a running one paused', () => {
  const fn = js.slice(js.indexOf('function paintJobs('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const [label, call] of [
    ['Pause', 'jobs.pause'], ['Stop', 'jobs.stop'], ['Resume', 'jobs.resume'],
    ['Start now', 'jobs.startNow'], ['Up', 'jobs.moveUp'], ['Down', 'jobs.moveDown'],
    ['Delete', 'jobs.remove'],
  ]) {
    assert.ok(body.includes(label) && body.includes(call), `${label} is missing`);
  }
});

test('a job row says whose it is, which half, and how far through', () => {
  const fn = js.slice(js.indexOf('function paintJobs('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /job\.author.*job\.part.*job\.added.*job\.total/s,
    'the three things somebody looking at a queue wants to know');
});


/**
 * A row of jobs is a list, and it should read like one.
 *
 * The controls repeat on every row, so they are icons: six words of buttons
 * would make each row three times as wide as the thing it describes. Progress
 * is a bar rather than a badge — a pill saying "downloading" spends a third of
 * the row restating a word already in the line above it and shows nothing
 * about how far along anything is.
 */
test('queue controls are icons with names, not words', () => {
  const fn = js.slice(js.indexOf('function paintJobs('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /setAttribute\('aria-label', label\)/, 'each icon keeps its name');
  assert.match(body, /icon\(icon_, 'ic'\)/, 'and is drawn from the sprite');
  for (const name of ['pause', 'play', 'stop', 'trash', 'bolt']) {
    assert.ok(html.includes(`id="i-${name}"`), `i-${name} is missing from the sprite`);
  }
});

test('progress is a bar, not a badge', () => {
  const fn = js.slice(js.indexOf('function paintJobs('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /job-bar/, 'the row shows how far along it is');
  assert.match(body, /job\.done \/ job\.total/, 'from the actual counts');
  assert.match(css, /\.job-bar\s*\{/, 'and it is styled');
});

test('background failures are shown in settings and nowhere else', () => {
  /* "the archive answered 503" over a shelf tells the reader something they
     cannot act on, while they are doing something else. */
  const walk = js.slice(js.indexOf('async function walkAuthor('));
  const body = walk.slice(0, walk.indexOf('\n}\n'));
  assert.match(body, /jobError =/, 'the failure is recorded for settings');
  assert.ok(!/authorSay\(e\.message\)/.test(body), 'and not printed over the library');
  assert.match(js, /jobError\b[\s\S]{0,400}job-error/, 'settings is where it appears');
});

/**
 * Opening a person queues both halves, without asking.
 *
 * Choosing between "their works" and "their bookmarks" is a decision nobody
 * wants to make on the way to reading something, and the answer is always
 * both. Settings is where a download is stopped.
 */
test('opening an author queues works and bookmarks, with no buttons to press', () => {
  const fn = js.slice(js.indexOf('async function catchUpOn('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /\['works', 'bookmarks'\]/, 'both halves, always');
  assert.ok(!html.includes('id="ab-works"') && !html.includes('id="ab-bookmarks"'),
    'and no buttons offering the choice');
});

test('opening the same author again does not walk their index over', () => {
  const fn = js.slice(js.indexOf('async function catchUpOn('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  /* The archive prints the totals on a person's own page. One request answers
     "has anything changed"; finding out by walking is a page per twenty works. */
  assert.match(body, /parseUserCounts\(/, 'the totals are read from their page');
  assert.match(body, /knownCount === total/, 'and compared with what was seen last time');
  assert.match(js, /AUTHORS_KEY/, 'which is remembered across restarts');

  /* A count is a cheap first question and a poor last one: delete one work,
     post another, and the number the app remembered is still right while the
     new work is invisible. The newest thing on the first page settles it. */
  assert.match(body, /stopIfTopIs: unchangedCount \? knownTop : null/,
    'so a matching count buys one request, not a decision');
  const walk = js.slice(js.indexOf('async function walkAuthor('));
  assert.match(walk.slice(0, walk.indexOf('\n}\n')),
    /if \(stopIfTopIs && top && top === stopIfTopIs\) return/,
    'and the walk ends there only when the newest one agrees too');
});

test('a failure worth retrying is retried rather than called unavailable', () => {
  const wiring = js.slice(js.indexOf('const jobs = createQueue('));
  const body = wiring.slice(0, wiring.indexOf('\n});'));
  assert.match(body, /shouldRetry: isTransient/, 'the queue knows what is worth another go');
  assert.match(body, /retryWait/, 'and waits longer each time');
});

/**
 * The app must ask the way the working client asks.
 *
 * The proxy sent a Chrome user agent and nothing else — no Accept, no
 * Accept-Language, none of the Sec-Fetch headers a browser sends on every
 * navigation. Claiming to be a browser and then not behaving like one is a
 * plain bot signature, and the archive sits behind Cloudflare: the same
 * account walking the same pages from a laptop with the full set ran hundreds
 * of requests without being throttled once, while the app took 5xx almost
 * straight away.
 */
test('the shell sends the same headers as the client that is not throttled', () => {
  const client = readFileSync(new URL('../tools/lib/client.mjs', import.meta.url), 'utf8');
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');

  const fn = client.slice(client.indexOf('function browserHeaders('));
  const wanted = [...fn.slice(0, fn.indexOf('\n}')).matchAll(/'?([A-Z][A-Za-z-]+)'?:/g)]
    .map((m) => m[1])
    // Java adds this itself and decompresses transparently, but only while
    // nothing has set it by hand
    .filter((h) => h !== 'Accept-Encoding');

  const sent = java.slice(java.indexOf('private void browserHeaders('));
  const body = sent.slice(0, sent.indexOf('\n    }'));
  const missing = wanted.filter((h) => !body.includes(`"${h}"`));
  assert.deepEqual(missing, [],
    `the client sends these and the shell does not: ${missing.join(', ')}`);
});

test('a referer is carried between archive pages', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  /* Somebody on page seven got there from page six. Arriving with no referer
     at all, page after page, is not what browsing looks like. */
  assert.match(java, /lastArchiveUrl/, 'the last archive page is remembered');
  assert.match(java, /setRequestProperty\("Referer", lastArchiveUrl\)/, 'and offered as the referer');
});

/**
 * The work page is built by the app, not borrowed from the archive.
 *
 * The archive's markup lays a work out for a wide page: labels floated in a
 * left-hand column a quarter of the width, values beside them. On a phone that
 * column is most of the screen and the values pile into it. Its stylesheet is
 * vendored to render an author's skin faithfully, which is a different job
 * from laying out our own furniture.
 */
test('the work page no longer takes its markup from the archive', () => {
  const api = readFileSync(new URL('../app/api.js', import.meta.url), 'utf8');
  assert.ok(!api.includes('meta_html'), 'the payload does not carry a block of markup');
  assert.ok(!api.includes('preface_html'), 'nor a preface');
  assert.ok(!js.includes('preface.innerHTML'), 'and the page does not paste one in');
});

test('the page is assembled as elements, so escaping cannot be got wrong', () => {
  const fn = js.slice(js.indexOf('async function openWork('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  /* A title, a summary and a tag are all somebody else's words. Set as
     textContent they are text; assembled into a string of HTML they are a
     question about escaping that has to be got right every time. */
  assert.match(body, /title\.textContent = w\.title/, 'the title is text');
  assert.match(body, /p\.textContent = para/, 'and so is the summary');
  assert.ok(!/innerHTML\s*=\s*(w\.|`)/.test(body), 'nothing from the work becomes markup');
});

test('one primary action, and the rest are not', () => {
  const fn = js.slice(js.indexOf('async function openWork('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const primaries = [...body.matchAll(/className = 'primary'/g)].length;
  assert.equal(primaries, 1, 'a screen with two primary actions has none');
});

/*
 * The visual pass that followed the work page. Each of these is a rule the
 * page is meant to hold to everywhere, and each is one a later edit could
 * quietly undo without breaking anything that would show up in a test run.
 */
/*
 * The work page is built by this app and dressed by this app's stylesheet.
 *
 * It used to be the archive's markup shown under the archive's stylesheet,
 * and the class that allowed that stayed behind after the page was rebuilt.
 * The vendored sheet sets `.ao3page h3` to Georgia at 1.286em, which outranks
 * a plain class selector, so every section label on the page came out as a
 * large serif headline instead of the small quiet label it is meant to be —
 * and no amount of adjusting `.group` could have changed that, because
 * `.group` was never the rule that won.
 */
/*
 * The three tabs are peers, so opening one empties the stack. That left Back
 * with nothing to pop on Library or Search, and it closed the app — one tap
 * to get there, and losing the app to get out.
 */
/*
 * Views are kept in the DOM rather than torn down, which is what makes going
 * back instant and what left Home frozen at whatever it showed when you left
 * it. Only the Home tab button rebuilt it, so reading a work and coming back
 * the way you came showed the shelves from before you read it.
 */
test('arriving at home rebuilds it', () => {
  const fn = js.slice(js.indexOf('function show(name, motion'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(name === 'home' && changing\) refresh\(\{ force: true \}\)/,
    'on arriving, not on every redraw, and by the same route as everything else');
});

/*
 * Six functions used to put the screens back in step with the library, each
 * written when it was needed and no two agreeing: three rebuilt the shelves
 * and forgot the tiles above them, so Surprise me and Never opened went stale
 * on some routes and not others. That is why the app felt different depending
 * on how you got somewhere.
 */
/*
 * The shelf card used to go into the reader when there was progress and to
 * the summary when there was not, so the same tap did two different things
 * depending on whether you had read it — and a different thing again from the
 * same work in the library, which has always shown the summary.
 */
/*
 * A shelf is mostly works you have never opened, and a title with an author
 * under it does not say what one is. The card already had a gap in the middle
 * holding nothing.
 */
/*
 * A card's spine is a hash of its fandom name, so the same fandom is the same
 * colour on every shelf. Tinting the browse chip with it makes that row a key
 * to what is underneath it rather than a separate decoration.
 */
/*
 * The archive keeps one date and changes what it calls it — Completed on a
 * finished work, Updated on one still going — so the word is as much of the
 * answer as the number. A work is the same work wherever it is shown, and two
 * renderers working that out separately is how they come to disagree.
 */
/*
 * A modal dialog fills the window and paints its backdrop through a
 * pseudo-element, so pressing what looks like the page behind is really
 * pressing the dialog — which is why nothing happened.
 */
/*
 * The archive answering 500 and the app never reaching the archive arrived on
 * the same path with the same status, which made them indistinguishable — and
 * the one that is always worth trying again looked like the one that might
 * not be.
 */
/*
 * A listing names a hundred works in one request, so a library fills up with
 * works it knows about and has never fetched — most of mine, after an import.
 * They were only reachable by opening each author in turn.
 */
test('everything described but not held can be asked for at once', () => {
  const fn = js.slice(js.indexOf('function stubIds('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /COALESCE\(has_text, 0\) = 0/,
    'a description is not the work; that column is what tells them apart');
  assert.match(body, /ORDER BY COALESCE\(updated, published\) DESC/,
    'newest first, because a run this long may not finish in one sitting');
  assert.match(body, /LIMIT \$\{Number\(limit\) \|\| STUBS_AT_ONCE\}/,
    'and capped, because a queue is a list held in memory');

  const paint = js.slice(js.indexOf('function paintStubs('));
  const pbody = paint.slice(0, paint.indexOf('\n}\n'));
  assert.match(pbody, /if \(!signedIn\(\)\)/,
    'the archive will not hand over most works to nobody');
  assert.match(pbody, /jobs\.add\(\{ \.\.\.STUBS_JOB/,
    'it goes through the queue, so it can be paused, stopped and resumed');
  assert.match(pbody, /Everything the library knows about has been downloaded/,
    'and says so when there is nothing left to get');
  assert.match(pbody, /hour\$\{hours === 1 \? '' : 's'\} of asking/,
    'half a minute per work is the whole cost, so it is said rather than discovered');
  assert.match(pbody, /total > STUBS_AT_ONCE/,
    'and it says when it is queuing part of the list rather than all of it');
});

test('failing to reach the archive is not the archive refusing', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const at = java.indexOf('String reason = e.getClass().getSimpleName()');
  const around = java.slice(at, at + 260);
  assert.match(around, /"text\/plain", "utf-8", 502/,
    'the shell says 502 when it could not get there at all');

  const api = readFileSync(new URL('../app/api.js', import.meta.url), 'utf8');
  assert.match(api, /if \(res\.status === 502\) \{/,
    'and the page reads that status, not the one the archive uses');
  assert.match(api, /The app could not reach the archive\$\{detail/,
    'the wording decides whether the work is tried again, so it leads with the cause');
  assert.ok(!/res\.status === 500\) throw/.test(api),
    'nothing still treats an archive 500 as the app failing');
});

test('pressing the dimmed part of the screen puts a sheet away', () => {
  const fn = js.slice(js.indexOf('function dismissOnBackdrop('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /e\.clientX < box\.left \|\| e\.clientX > box\.right/,
    'what separates backdrop from sheet is where the press landed');
  assert.match(body, /pointerdown/,
    'measured where it started: a drag out of a sheet is a drag, not a dismissal');
  assert.match(body, /startedOutside\) closeSheet\(d\)/,
    'and it closes the way everything else closes, with the animation');

  const open = js.slice(js.indexOf('function openSheet('));
  assert.match(open.slice(0, open.indexOf('\n}\n')), /dismissOnBackdrop\(d\)/,
    'wired in the one place every sheet is opened, so every sheet has it');
  assert.equal([...js.matchAll(/showModal\(\)/g)].length, 1,
    'and there is only one such place');
});

test('when a work last changed is answered in one place', () => {
  const fn = js.slice(js.indexOf('function whenOf('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /w\.complete \? 'Completed' : 'Updated'/,
    'the label is read off the work, not guessed');
  assert.match(body, /!w\.updated \? 'Published'/,
    'and a work never updated does not claim an update that never happened');

  for (const render of ['function workRow(', 'function workCard(']) {
    const part = js.slice(js.indexOf(render));
    assert.match(part.slice(0, part.indexOf('\n}\n')), /whenOf\(w\)/,
      `${render} asks the same question of the same function`);
  }
  assert.equal([...js.matchAll(/'Completed'/g)].length, 1,
    'and only one place decides what to call it');
});

test('a fandom chip is the colour of that fandom\'s spines', () => {
  const fn = js.slice(js.indexOf('function buildBrowse('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /spineColour\(item\.name\)/,
    'the same function the cards use, so the two cannot drift apart');
  assert.match(body, /if \(browseKind === 'fandom'\)/,
    'only fandoms: a pairing or a rating has no spine of its own to agree with');

  const card = js.slice(js.indexOf('function workCard('));
  assert.match(card.slice(0, card.indexOf('\n}\n')),
    /spineColour\(w\.fandom \|\| w\.title\)/,
    'and this is the side of the agreement the chip is matching');
});

test('a shelf card says what the work is about', () => {
  const fn = js.slice(js.indexOf('function workCard('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /class="card-sum"/, 'the summary is on the card');
  assert.match(body, /card\.querySelector\('\.card-sum'\)\.textContent = w\.summary/,
    'and set as text, because an author wrote it');

  const rule = css.slice(css.indexOf('.card .card-sum {'));
  assert.match(rule.slice(0, rule.indexOf('}')), /-webkit-line-clamp: 4/,
    'clamped, so every card on a shelf still ends at the same height');
});

test('both backends fetch what the card needs', () => {
  for (const [name, path] of [['native', '../app/api.js'], ['dev server', '../tools/serve.mjs']]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    const at = src.indexOf('const shelf = (where');
    const query = src.slice(at, src.indexOf('FROM works w', at));
    assert.match(query, /w\.summary/, `${name} must select the summary the card shows`);
  }
});

test('tapping a work shows the work, wherever it is tapped', () => {
  const card = js.slice(js.indexOf('function workCard('));
  assert.match(card.slice(0, card.indexOf('\n}\n')),
    /card\.onclick = \(\) => openWork\(w\.work_id\);/,
    'a shelf card shows the summary whether or not it has been read');

  const row = js.slice(js.indexOf('function workRow('));
  const body = row.slice(0, row.indexOf('\n}\n'));
  assert.match(body, /node\.onclick = \(\) => openWork\(w\.work_id\);/,
    'and so does the library row');
  assert.match(body, /open: \(\) => openChapter\(w\.work_id, p \? \(w\.at_chapter \?\? 1\) : 1\)/,
    'while Read and Continue are the ways into the reader, and say so');
});

test('there is one way to put the screens back in step', () => {
  const calls = [...js.matchAll(/buildHome\(\)/g)].length;
  assert.equal(calls, 2,
    'its definition and the one function that calls it, and nothing else');
  const startHere = [...js.matchAll(/buildStartHere\(\)/g)].length;
  assert.equal(startHere, 2, 'and the tiles are never rebuilt on their own');
});

/*
 * A job still reading an author's index was dropped on the way out: the list
 * it had was finished, the pages it had not reached were written down
 * nowhere, and the whole thing — walk included — was gone on restart.
 */
/*
 * The queue could say what it was doing and never what it had done. A job that
 * finished was dropped on the way out, so the app opened saying "Nothing
 * waiting" with no account of the night before — and no way to tell a job that
 * got everything from one that got none of it.
 */
test('what has already run can still be seen', () => {
  const src = readFileSync(new URL('../app/core/sync/queue.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function restore('));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /state: saved\.state === 'done' \? 'done' : 'queued'/,
    'a job comes back as what it was, rather than being guessed at from a list');
  assert.match(body, /wasTotal: Number\(saved\.total\) \|\| owed\.length/,
    'and how much it was about is a number that was written down');

  const resume = js.slice(js.indexOf('function resumeJobs('));
  assert.match(resume.slice(0, resume.indexOf('\n}\n')), /jobs\.restore\(\{ \.\.\.job, workIds: \[\] \}\)/,
    'a finished job comes back as a record rather than not at all');

  const paint = js.slice(js.indexOf('function paintJobs('));
  const pbody = paint.slice(0, paint.indexOf('\n}\n'));
  assert.match(pbody, /RANK = \{ running: 0/,
    'what is happening comes before what happened');
});

test('a queue still reading its index survives a restart', () => {
  const src = readFileSync(new URL('../app/core/sync/queue.js', import.meta.url), 'utf8');
  const save = src.slice(src.indexOf('save: () => jobs'));
  const body = save.slice(0, save.indexOf('\n  };'));
  assert.match(body, /open: Boolean\(j\.open\), page: j\.page \?\? 0/,
    'how far the walk got is part of what is saved');
  assert.match(body, /state: j\.state,/, 'and what state it was in');
  assert.match(body, /total: j\.workIds\.length \|\| j\.wasTotal \|\| 0/,
    'and how much it was about, as a number rather than a list length');
  assert.ok(!/\.filter\(\(j\) => j\.workIds\.length \|\| j\.open\)/.test(body),
    'a finished job is no longer dropped for having nothing left to do');

  const resume = js.slice(js.indexOf('function resumeJobs('));
  const rbody = resume.slice(0, resume.indexOf('\n}\n'));
  assert.match(rbody, /fromPage: Math\.max\(1, Number\(job\.page\) \|\| 0\)/,
    'and it carries on from the page after the last one it finished');
  assert.match(rbody, /finally\(\(\) => jobs\.seal\(id\)\)/,
    'however that walk ends, the job is closed rather than left reading for ever');
});

test('back out of a tab goes home, not out of the app', () => {
  const fn = js.slice(js.indexOf('window.__onBack = () => {'));
  const body = fn.slice(0, fn.indexOf('\n};'));
  assert.match(body, /if \(goBack\(\)\) return true/, 'a real stack entry still wins');
  assert.match(body, /if \(backLeavesTab\(\)\) \{ show\('home', 'back'\); return true; \}/,
    'and a tab with nothing behind it falls back to Home');
  assert.match(body, /return false;/, 'Home with nothing behind it still leaves');

  const test_ = js.slice(js.indexOf('const backLeavesTab ='));
  assert.match(test_.slice(0, test_.indexOf(';')),
    /TABBED\.has\(showing\(\)\) && showing\(\) !== 'home'/,
    'only the tabs, and never Home itself');

  const start = js.slice(js.indexOf('window.__onBackStart = () => {'));
  assert.match(start.slice(0, start.indexOf('\n};')), /!backLeavesTab\(\)/,
    'the gesture previews the move home rather than previewing a close');
});

test('the work page is not dressed by the archive', () => {
  const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  const detail = html.match(/<section id="detail"[^>]*>/)[0];
  assert.ok(!/ao3page/.test(detail),
    'the vendored stylesheet outranks the app\'s own labels on this page');

  const reader = html.match(/<section id="reader"[^>]*>/)[0];
  assert.match(reader, /ao3page/,
    'the reader keeps it: that is where the archive\'s words and an author skin go');

  /* The guard is only worth having while the rule it guards against exists. */
  const vendored = readFileSync(new URL('../app/ao3-work.css', import.meta.url), 'utf8');
  assert.match(vendored, /\.ao3page h3 \{[^}]*font-size/,
    'if this ever stops setting a heading size, this test is measuring nothing');
});

test('a work\'s tags are not fenced', () => {
  const rule = css.slice(css.indexOf('.work-tags .chip {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /border-color: transparent/,
    'a filter chip is a control and earns its outline; a tag is what the work is about');
  assert.ok(!/background: var\(--pane\)/.test(body),
    'thirty pane-filled boxes is a wall in front of the summary');
});

test('a list of works is a list, not a stack of boxes', () => {
  const rule = css.slice(css.indexOf('.work-card {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.ok(!/background: var\(--pane\)/.test(body), 'a row in a list has no fill');
  assert.ok(!/border: 1px solid/.test(body), 'and no frame of its own');
  assert.match(css, /\.work-card \+ \.work-card \{ border-top/,
    'what separates two rows is the line between them');
});

test('section headings all speak at the same volume', () => {
  for (const sel of ['.group {', '.shelf-head h2 {', '.fandom-block h2 {']) {
    const rule = css.slice(css.indexOf(sel));
    const body = rule.slice(0, rule.indexOf('}'));
    assert.match(body, /text-transform: uppercase/, sel + ' is a sign, not a headline');
    assert.match(body, /color: var\(--muted\)/, sel + ' does not compete with the titles under it');
  }
});

test('tag groups label above, not beside', () => {
  const fn = js.slice(js.indexOf('function tagGroup('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /section\.append\(head, chips\)/, 'the label comes first, then the chips');
  assert.match(css, /\.chip-wrap\s*\{[^}]*flex-wrap: wrap/,
    'and the chips have the whole width to wrap into');
});

/**
 * A work that came from an EPUB had its pictures stored. Refetched from the
 * archive, its chapters point at remote hosts instead — and nothing fetched
 * those, so the pictures vanished and left a column of empty boxes.
 */
test('a chapter collects the pictures it is missing', () => {
  const fn = js.slice(js.indexOf('async function collectImages('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /img\[data-remote-src\]/, 'it looks for what did not load');
  assert.match(body, /await fetchNextImage\(workId\)/,
    'the shell is asked for the next one; no address crosses the bridge');
  assert.match(body, /img\.src = `\/img\/\$\{out\.sha256\}`/,
    'the picture arrives in place, without rebuilding the page under the reader');
  assert.match(body, /current\.workId !== workId/, 'and stops if they have gone elsewhere');
});

test('the session never travels to an image host', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const open_ = java.slice(java.indexOf('private HttpURLConnection open('),
    java.indexOf('private WebResourceResponse respond('));
  /* Images may come from anywhere, which is a deliberate loosening. The rule
     that does not bend is that the archive cookie goes to the archive only. */
  assert.match(open_, /if \(archive\) \{/, 'cookies are gated on the host being the archive');
  assert.ok(!/setRequestProperty\("Cookie"/.test(open_.split('if (archive) {')[0]),
    'and nothing sets one before that gate');
});

test('only pictures are stored, and not enormous ones', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('public String fetchNextImage('));
  const body = fn.slice(0, fn.indexOf('\n        }\n'));
  assert.match(body, /mime\.startsWith\("image\/"\)/,
    'an error page stored where an image should be renders as a broken one for ever');
  assert.match(body, /12 \* 1024 \* 1024/, 'and one picture cannot fill the library');
  assert.match(body, /storeDead\(/, 'what cannot be had is remembered, not asked for for ever');
});

test('the page cannot say where an image request goes', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('public String fetchNextImage('));
  const signature = fn.slice(0, fn.indexOf('{'));
  const body = fn.slice(0, fn.indexOf('\n        }\n'));

  /* Images may come from anywhere, which is a deliberate loosening: an author
     puts them where they like. What stops that being "the page may ask for any
     address at all" is that no address crosses the bridge — the shell reads the
     next one out of chapter text it already holds. Checking a caller-supplied
     address and hoping the check holds is the weaker arrangement, and it is
     the one CodeQL objected to on the write path for the same reason. */
  assert.ok(!/String\s+\w*[Uu]rl/.test(signature), `the page passes no address: ${signature}`);
  assert.match(body, /nextImageFor\(workId\)/, 'the shell chooses which picture');

  const finder = java.slice(java.indexOf('private String nextImageFor('));
  assert.match(finder.slice(0, finder.indexOf('\n    }\n')), /FROM chapters WHERE work_id = \?/,
    'from the work itself, with the id bound rather than pasted');
});
/*
 * The tests here read the app as text, to assert things about how it is
 * written. That is useful and it is not the same as knowing it runs: a
 * duplicate declaration sailed past four hundred and fifty of them, because
 * not one of them had asked whether the file parses.
 */
test('the app parses', () => {
  for (const file of ['../app/app.js', '../app/api.js', '../app/core/sync/queue.js',
                      '../app/core/sync/run.js', '../app/core/query.js']) {
    const path = fileURLToPath(new URL(file, import.meta.url));
    const out = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(out.status, 0, `${file} does not parse:\n${out.stderr}`);
  }
});

/*
 * A download is hours of paced requests, and all of it used to stop the moment
 * the app went away — which the settings screen admitted to rather than fixed.
 */
test('a download keeps going while the app is not being looked at', () => {
  const service = readFileSync(
    new URL('../android/src/org/fanfolio/DownloadService.java', import.meta.url), 'utf8');
  assert.match(service, /startForeground\(NOTE_ID, built,[\s\S]*FOREGROUND_SERVICE_TYPE_DATA_SYNC/,
    'a typed foreground service, which is what Android 14 asks for');
  assert.match(service, /PARTIAL_WAKE_LOCK/,
    'the processor stays awake, which is what actually keeps the page timers firing');
  assert.ok(!/FULL_WAKE_LOCK|SCREEN_BRIGHT/.test(service),
    'and not the screen: an hour of downloading is not a reason to keep a display on');
  assert.match(service, /addAction\([\s\S]*"Pause"/, 'with a way to stop it from the notification');

  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  for (const needed of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC',
                        'POST_NOTIFICATIONS', 'WAKE_LOCK']) {
    assert.ok(manifest.includes(needed), `${needed} must be declared`);
  }
  assert.match(manifest, /android:name="\.DownloadService"[\s\S]*foregroundServiceType="dataSync"/);
});

test('the notification says what is happening, and goes when it stops', () => {
  const fn = js.slice(js.indexOf('function sayWhatIsHappening('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!busy\.length\)/, 'nothing to do means nothing shown');
  assert.match(body, /stopWorking\(\)/,
    'a notification that outlives its work is worse than none');
  assert.match(body, /if \(said === lastSaid\) return/,
    'and it is not rewritten on every event for the same words');

  assert.match(js, /window\.__pauseAll = \(\) => \{/, 'Pause on the notification reaches the queue');
  const java = readFileSync(
    new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /window\.__pauseAll && window\.__pauseAll\(\)/,
    'and the shell is what calls it');
});

/*
 * Walking away from an author stopped the loop, and the loop returned like any
 * other success — so the count and the newest work were written down as
 * current, and the pages nobody had read were never asked for again, because
 * next time the fingerprint would match.
 */
test('an interrupted author walk is not recorded as a checked one', () => {
  const walk = js.slice(js.indexOf('async function walkAuthor('));
  const body = walk.slice(0, walk.indexOf('\n}\n'));
  assert.match(body, /if \(jobId !== null && !\(await jobs\.waitUntilRunnable\(jobId\)\)\) \{[\s\S]{0,60}complete = false;/,
    'stopped or paused is not finished — and it is the job that says so, not '
    + 'whichever author happens to be on screen');
  assert.ok(!/currentAuthor !== name/.test(body),
    'browsing to somebody else must not abandon a download you asked for');
  assert.match(body, /return \{ complete, top, pages, reached \}/,
    'and the walk says which it was');

  const catchUp = js.slice(js.indexOf('async function catchUpOn('));
  const cbody = catchUp.slice(0, catchUp.indexOf('\n}\n'));
  assert.match(cbody, /walked\?\.complete\s*\n?\s*\?\s*\{ n: total/,
    'only a finished walk may say the listing was checked');
  assert.match(cbody, /nextPage: \(walked\?\.reached \?\? 0\) \+ 1/,
    'an unfinished one records where to carry on from');
  assert.match(cbody, /fromPage: Math\.max\(1, Number\(before\?\.nextPage\) \|\| 1\)/,
    'and opening the author again does carry on');
});

/*
 * Sequential is not paced. A series fetched each work the moment the last one
 * finished, walking straight through the rate the rest of the app keeps to.
 */
test('a series is queued, not downloaded on the spot', () => {
  const api = readFileSync(new URL('../app/api.js', import.meta.url), 'utf8');
  const fn = api.slice(api.indexOf('async function addSeries('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /return \{ kind: 'series', seriesId, workIds, count/,
    'it hands back a plan');
  assert.ok(!/fetchAndSave/.test(body),
    'and does not fetch the works itself, at any rate it likes');

  const queue = js.slice(js.indexOf('function queueSeries('));
  assert.match(queue.slice(0, queue.indexOf('\n}\n')), /jobs\.add\(\{ author: `Series/,
    'the queue takes it, which is what paces it');
});

/*
 * The stack held a screen name, and a screen name is not a place: there is one
 * Detail element and one Results element in the page, so "detail" meant
 * whichever work had most recently been painted into it.
 */
test('a history entry describes a place, not a screen', () => {
  const fn = js.slice(js.indexOf('function here() {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /params\.workId = String\(currentWork\.work_id\)/, 'which work');
  assert.match(body, /params\.chapter = Number\(current\.chapter\)/, 'which chapter');
  assert.match(body, /params\.query = \$\('#q'\)\.value/, 'which search');
  assert.match(body, /params\.filters = JSON\.parse\(JSON\.stringify\(view\)\)/,
    'and which filters — copied, because a place that changes underneath you is not one');
});

test('going back rebuilds the place rather than unhiding a screen', () => {
  const fn = js.slice(js.indexOf('function renderPlace('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /openWork\(p\.workId\)/, 'the work that entry names');
  assert.match(body, /openChapter\(p\.workId, Number\(p\.chapter\) \|\| 1\)/, 'that chapter');
  assert.match(body, /runSearch\(p\.query\)/, 'that search');
  assert.match(body, /Object\.assign\(view, p\.filters\)/, 'those filters');

  assert.match(js, /let restoring = false;/,
    'and rebuilding a place does not count as travelling to it');
  const go = js.slice(js.indexOf('function go(name, params'));
  assert.match(go.slice(0, go.indexOf('\n}\n')), /if \(restoring\) return;/);
});

/*
 * A queue of hours of work, a bookmark sync and a backlog of undownloaded
 * works are not preferences. They are what the app is doing, and the question
 * they answer — "what is Fan Folio doing" — is not one anybody thinks to look
 * for under a cog.
 */
test('what the app is doing has a place of its own', () => {
  const activity = html.slice(html.indexOf('<section id="activity"'),
    html.indexOf('</section>', html.indexOf('<section id="activity"')));
  for (const moved of ['id="job-list"', 'id="stub-count"', 'id="fetch-stubs"', 'id="sync-now"']) {
    assert.ok(activity.includes(moved), `${moved} belongs in Activity`);
  }

  const settings = html.slice(html.indexOf('<section id="settings"'),
    html.indexOf('</section>', html.indexOf('<section id="settings"')));
  for (const gone of ['id="job-list"', 'id="fetch-stubs"', 'id="sync-now"']) {
    assert.ok(!settings.includes(gone), `${gone} is not a setting`);
  }
  assert.ok(settings.includes('id="library-facts"'), 'what the library holds can stay');
});

test('search is an action, not a destination', () => {
  assert.match(js, /const TABBED = new Set\(\['home', 'library', 'activity'\]\)/,
    'the box in the top bar already searches whatever screen you are on');
  const tabsAt = html.indexOf('<nav id="tabs"');
  const tabs = html.slice(tabsAt, html.indexOf('</nav>', tabsAt));
  assert.ok(!tabs.includes('data-tab="search"'), 'so it does not also need a tab');
  assert.ok(tabs.includes('data-tab="activity"'));
});

test('a download notification lands on the downloads', () => {
  const service = readFileSync(
    new URL('../android/src/org/fanfolio/DownloadService.java', import.meta.url), 'utf8');
  assert.match(service, /open\.putExtra\("open", "activity"\)/,
    'not wherever the app happened to be left');

  const java = readFileSync(
    new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /private void goWhereAsked\(Intent intent\)/, 'acted on when resuming');
  assert.match(java, /public String takePendingOpen\(\)/,
    'and held when the notification is tapped before the page exists');
  assert.match(js, /window\.__open = \(where\) => \{/);
});

/*
 * Checking for new bookmarks reads the newest pages and stops where they stop
 * being new. That can only add — removing one on the archive is the absence of
 * something, and an absence cannot be noticed by looking at what is there. So
 * the local idea of "bookmarked" only ever grew, until the filter meant "has
 * ever been bookmarked" rather than "is".
 */
test('the whole bookmark list can be read, so removals are noticed', () => {
  const fn = js.slice(js.indexOf('async function reconcileAllBookmarks('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /reconcileBookmarks\(all\)/, 'the whole list decides it, not a page of it');
  assert.match(body, /if \(stopRequested\) \{/, 'and a half-read list decides nothing');
  assert.match(body, /Nothing changed/,
    'because everything unread would look like everything unbookmarked');

  const java = readFileSync(
    new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const shell = java.slice(java.indexOf('public String reconcileBookmarks('));
  const sbody = shell.slice(0, shell.indexOf('\n        }\n'));
  assert.match(sbody, /beginTransaction/, 'a half-applied reconciliation is worse than none');
  assert.match(sbody, /UPDATE works SET in_bookmarks = 0/, 'membership can go down');
  assert.ok(!/DELETE FROM works|DROP/.test(sbody),
    'and a work you unbookmarked is not a work you asked to lose');
});

/*
 * Opening an author used to start reading their whole index and downloading
 * everything they had written and everything they had bookmarked. For a
 * prolific person that is hours of archive, begun by tapping a name.
 */
test('opening an author shows the author', () => {
  const fn = js.slice(js.indexOf('function openAuthor(name) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /filterBy\('author', name\)/, 'the library narrows to them');
  assert.ok(!/catchUpOn\(name\)/.test(body),
    'and nothing is asked of the archive by looking at somebody');

  const bar = js.slice(js.indexOf('function paintAuthorBar('));
  const bbody = bar.slice(0, bar.indexOf('\n}\n'));
  assert.match(bbody, /catchUpOn\(name\)/, 'the work is still one tap');
  assert.match(bbody, /works and bookmarks/,
    'and still both halves, because choosing between them is a decision nobody wants');
  assert.match(bbody, /if \(!signedIn\(\)\)/, 'and it needs an account like everything else');
});

/*
 * The order was tiles, then counts, then browse, then the shelves — so the
 * most common reason to open a reading app sat below three things that are
 * useful once and rarely twice.
 */
test('what somebody came back for is first', () => {
  const home = html.slice(html.indexOf('<section id="home"'),
    html.indexOf('</section>', html.indexOf('<section id="home"')));
  /* Continue reading, then what the library amounts to, then the ways in.
     The counts were moved off the top of this screen because carrying on
     with a work is why anybody opens a reading app — which was right — and
     landed at the very bottom, under every shelf and the whole of Browse,
     which made them present and functionally gone. They are what makes Home
     read as somebody's own archive; both facts fit, in this order. */
  const order = ['id="shelves"', 'id="stats"', 'id="starthere"', 'id="fandoms"']
    .map((id) => home.indexOf(id));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a shelf says how much of it is not on it', () => {
  const fn = js.slice(js.indexOf('async function buildHome()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const total = Number\(shelf\.total \?\? shelf\.works\.length\)/);
  assert.match(body, /`See all \$\{total\}`/,
    'twelve works shown out of twenty, with nothing saying so, reads as eight lost');

  /* And the button has to land on the same question the shelf asked. */
  const map = js.slice(js.indexOf('const SHELF_VIEW = {'));
  const table = map.slice(0, map.indexOf('};'));
  assert.match(table, /reading: \{ state: 'reading' \}/);
  assert.match(table, /long: \{ state: 'unread', complete: '1'/,
    'Settle in is long, complete and unstarted — it used to open on the whole library');
});

test('both backends count a shelf as well as filling it', () => {
  for (const path of ['../app/api.js', '../tools/serve.mjs']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('const shelf = (where, order'));
    assert.match(fn.slice(0, 1200), /total:/, `${path} returns the size of the shelf`);
  }
});

test('a library row does not offer twice what the row itself does', () => {
  const fn = js.slice(js.indexOf('function workRow('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/data-act="details"/.test(body), 'tapping the row already opens it');
  assert.match(body, /node\.onclick = \(\) => openWork\(w\.work_id\)/);
  assert.match(body, /data-act="open"/, 'and the way straight in stays');
});

test('upkeep is not a peer of leaving kudos', () => {
  const fn = js.slice(js.indexOf('function archiveActions('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /row\.append\(kudos, bookmark, comment\)/,
    'things done because of the work');
  assert.match(body, /upkeep\.append\(onArchive, refetch\)/,
    'and things done because of the app');
  assert.match(css, /\.archive-upkeep \{/, 'drawn a step back');
});

test('the reader does not offer to add a work', () => {
  const fn = js.slice(js.indexOf('function paintChrome(name)'));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /\$\('#add'\)\.hidden = name === 'reader'/,
    'never part of reading one');
});

/*
 * Settings was the single control that never went away — on screen inside a
 * chapter, and on screen before there was a library to configure — while
 * Library and Activity disappeared the moment anybody opened a work. That is
 * the hierarchy of a settings app, not a reading one.
 */
test('the app is at least as reachable as its settings', () => {
  const chrome = js.slice(js.indexOf('function paintChrome(name)'));
  const body = chrome.slice(0, chrome.indexOf('\n}\n'));
  assert.match(body, /\$\('#open-settings'\)\.hidden = !KEEPS_TABS\.has\(name\)/,
    'the cog is offered exactly where the tabs are, and nowhere they are not');

  const keeps = js.slice(js.indexOf('const KEEPS_TABS'));
  const set = keeps.slice(0, keeps.indexOf(');'));
  assert.match(set, /'detail'/, 'opening a work is navigation within a library, not out of it');
  assert.ok(!/'reader'/.test(set), 'reading is the one screen that earns an empty chrome');

  const shown = js.slice(js.indexOf("$('#tabs').hidden"));
  assert.match(shown.slice(0, 60), /!KEEPS_TABS\.has\(name\)/);
});

test('the Activity tab says when something is going on behind it', () => {
  const fn = js.slice(js.indexOf('function paintActivityBadge()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /'running', 'queued', 'listing'/, 'work happening');
  assert.match(body, /'paused', 'pausing'/, 'work stopped, waiting for a decision');
  assert.match(body, /unfinished\?\.length \|\| j\.lastError/, 'work that ended badly');
  assert.match(body, /setAttribute\('aria-label'/,
    'colour alone would be the only thing saying which of the three it is');
  assert.match(js, /paintActivityBadge\(\);\n {4}if \(!\$\('#activity'\)\.hidden\)/,
    'painted as the queue changes, not only when the screen is looked at');
});

test('the reader has a way into the app that is not the Back button', () => {
  assert.match(html, /id="reader-more"/, 'a chapter had no route out but Back, repeated');
  const menu = html.slice(html.indexOf('<dialog id="reader-menu">'));
  const body = menu.slice(0, menu.indexOf('</dialog>'));
  for (const where of ['home', 'library', 'activity', 'settings']) {
    assert.match(body, new RegExp(`data-go="${where}"`), `${where} is reachable from a chapter`);
  }
  assert.match(js, /\$\('#reader-more'\)\.onclick = \(\) => openSheet/);
});

test('the way back to the work is not the library icon', () => {
  const button = html.slice(html.indexOf('<button id="to-work"'));
  assert.match(button.slice(0, button.indexOf('</button>')), /#i-work/,
    'it opens one work\u2019s own page; three books on a shelf is a different place');
  assert.match(html, /<symbol id="i-work"/);
});

test('a box that would not know what it was searching is not shown', () => {
  const chrome = js.slice(js.indexOf('function paintChrome(name)'));
  assert.match(chrome.slice(0, chrome.indexOf('\n}\n')), /\$\('#q'\)\.hidden = !SEARCHABLE\.has\(name\)/);
  const set = js.slice(js.indexOf('const SEARCHABLE'));
  const names = set.slice(0, set.indexOf(');'));
  assert.ok(!/'activity'|'settings'|'setup'/.test(names),
    'search fell through to whatever scope was last in force on these');
  assert.match(js, /\$\('#bar-gap'\)\.hidden = !\$\('#q'\)\.hidden/,
    'and the bar keeps its shape without it');
});

test('first run offers nothing that needs a library', () => {
  const chrome = js.slice(js.indexOf('function paintChrome(name)'));
  assert.match(chrome.slice(0, chrome.indexOf('\n}\n')), /\$\('#bar'\)\.hidden = name === 'setup'/,
    'search, reading settings and the cog all want a library that does not exist yet');
});

test('the fonts that need no internet are named as such', () => {
  assert.match(html, /Georgia, System and Monospace are always available/,
    'in an app whose point is having things without asking for them');
  const list = html.slice(html.indexOf('<datalist id="fonts">'));
  const first = list.slice(0, list.indexOf('</datalist>'));
  assert.ok(first.indexOf('Georgia') < first.indexOf('Literata'),
    'and offered before the ones that do');
});

/*
 * A wake lock keeps the processor awake. It says nothing about the browser
 * engine, which throttles a page's own timers once nobody is looking at it —
 * so the queue did not die when the app went away, it went to sleep on the one
 * wait every archive request passes through and was never woken. That looks
 * exactly like dying, and is worse, because the notification sits there saying
 * work is happening.
 */
test('a tick releases a wait that is owed, and only one that is owed', async () => {
  const from = js.indexOf('const waitingOnTheArchive = new Set();');
  const to = js.indexOf('function paced(run) {');
  const source = js.slice(from, to) + '\nreturn untilDue;';

  /* A clock that only moves when this test moves it, and timers that never
     fire on their own — which is the situation the page is in once nobody is
     looking at it. */
  let clock = 1_000_000;
  const scope = { window: {} };
  const untilDue = new Function('setTimeout', 'clearTimeout', 'Date', 'window', source)(
    () => 1, () => {}, { now: () => clock }, scope.window);

  let done = false;
  const waiting = untilDue(28_000).then(() => { done = true; });

  clock += 10_000;
  scope.window.__tick();
  await Promise.resolve();
  assert.equal(done, false,
    'ten seconds into a twenty-eight second gap is not a reason to ask the archive');

  clock += 20_000;                      // now past due
  scope.window.__tick();
  await waiting;
  assert.equal(done, true, 'and once it is owed, being told the time is enough');
});

test('the shell keeps the time only while there is work', () => {
  const service = readFileSync(
    new URL('../android/src/org/fanfolio/DownloadService.java', import.meta.url), 'utf8');
  assert.match(service, /clock\.postDelayed\(keepingTime, TICK_MS\)/, 'started with the work');
  assert.match(service, /MainActivity\.tick\(\)/, 'and it tells the page time has passed');
  const stops = [...service.matchAll(/clock\.removeCallbacks\(keepingTime\)/g)];
  assert.ok(stops.length >= 3, `stopped when paused, and when the service goes: ${stops.length}`);

  const java = readFileSync(
    new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  assert.match(java, /window\.__tick && window\.__tick\(\)/);
});

/*
 * The shared pacer exists so that no part of the app can decide for itself how
 * often the archive may be asked. Every batch of work goes to the queue, and
 * the queue's one runner is the only thing that fetches.
 */
test('nothing outside the queue fetches a batch of works', () => {
  /* One place calls addWork in a loop, and it is the queue's runner, which is
     wrapped in the pacer. */
  assert.match(js, /runTask: \(workId\) => paced\(\(\) => addWork\(/,
    'the queue fetches through the pacer');

  for (const [what, fn] of [['a series', 'function queueSeries('],
                            ['a bookmark sync', 'async function syncBookmarks('],
                            ['the backlog', 'function paintStubs(']]) {
    const body = js.slice(js.indexOf(fn));
    const source = body.slice(0, body.indexOf('\n}\n'));
    assert.match(source, /jobs\.add\(/, `${what} hands its works to the queue`);
    /* Specifically: it never fetches a work. Looping over what it found to
       write something down locally is not asking the archive for anything. */
    assert.ok(!/fetchWorks\(|addWork\(/.test(source),
      `${what} does not fetch works itself, at a rate only it knows about`);
  }
});
