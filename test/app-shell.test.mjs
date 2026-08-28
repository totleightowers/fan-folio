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
  assert.match(js, /\$\('#to-work'\)\.onclick[\s\S]{0,120}openWork\(/,
    'and it opens the work, rather than relying on history that may not hold it');
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
  assert.match(body, /openWork\(current\.workId\)/, 'and the first one leaves for the work');
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

test('every archive request in a sync goes through the pacer', () => {
  const fn = js.slice(js.indexOf('async function syncBookmarks('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /await wait\(nextGap\(\)\)/, 'pages are spaced apart');
  assert.match(body, /wait,/, 'and so are the works');
  assert.match(body, /shouldStop: \(\) => stopRequested/, 'both halves can be stopped');
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
  const buttons = [...js.matchAll(/textContent = '(Fetch[^']*)'/g)].map((m) => m[1]);
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
  assert.match(body, /!workIsHeld\(id\)/, 'and what is already here is not fetched twice');
});

test('progress is reported as it happens', () => {
  const wiring = js.slice(js.indexOf('const jobs = createQueue('));
  const body = wiring.slice(0, wiring.indexOf('\n});'));
  assert.match(body, /e\.job\.added.*e\.job\.total/s, 'each work says which of how many');
  assert.match(body, /save\(JOBS_KEY/, 'and what is left survives the app closing');
});

test('what is owed is picked up again after a restart', () => {
  const fn = js.slice(js.indexOf('function resumeJobs('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /!workIsHeld\(String\(id\)\)/,
    'anything fetched in the meantime is dropped rather than fetched twice');
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
  assert.match(body, /seen\[part\] === total/, 'and compared with what was seen last time');
  assert.match(js, /AUTHORS_KEY/, 'which is remembered across restarts');
});

test('a failure worth retrying is retried rather than called unavailable', () => {
  const wiring = js.slice(js.indexOf('const jobs = createQueue('));
  const body = wiring.slice(0, wiring.indexOf('\n});'));
  assert.match(body, /shouldRetry: isTransient/, 'the queue knows what is worth another go');
  assert.match(body, /retryWait/, 'and waits longer each time');
});
