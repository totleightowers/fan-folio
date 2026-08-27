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
  for (const [fn, nav] of [['openWork', "go('detail')"], ['openChapter', "go('reader')"]]) {
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
  const called = [...new Set([...api.matchAll(/\bnative\.(\w+)\s*\(/g)].map((m) => m[1]))];

  assert.ok(called.length > 5, 'the page should be calling the bridge at all');
  const missing = called.filter((name) => !exposed.has(name));
  assert.deepEqual(missing, [],
    `the page calls these but the shell does not expose them: ${missing.join(', ')}`);
});
