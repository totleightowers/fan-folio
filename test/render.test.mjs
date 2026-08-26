import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseHtml, scopeCss, renderChapter } from '../app/core/render.js';

test('scripts are removed entirely, not just their tags', () => {
  const out = sanitiseHtml('<p>before</p><script>steal(document.cookie)</script><p>after</p>');
  assert.ok(!out.includes('steal'), 'script body must not survive');
  assert.ok(out.includes('before') && out.includes('after'));
});

test('event handlers are stripped', () => {
  const out = sanitiseHtml('<p onclick="steal()" class="keep">hi</p>');
  assert.ok(!/onclick/i.test(out));
  assert.ok(out.includes('class="keep"'), 'ordinary attributes survive');
});

test('javascript: urls are removed', () => {
  const out = sanitiseHtml('<a href="javascript:alert(1)">x</a>');
  assert.ok(!/javascript:/i.test(out));
});

test('formatting authors rely on is preserved', () => {
  const fic = '<p style="text-align: right" class="textmsg">morning</p>'
    + '<div class="twtchat"><em>italics</em> and <strong>bold</strong></div>';
  const out = sanitiseHtml(fic);
  assert.ok(out.includes('text-align: right'), 'alignment is the whole point of a chat fic');
  assert.ok(out.includes('class="twtchat"'));
  assert.ok(out.includes('<em>italics</em>'));
});

test('css that escapes the reading pane is dropped from inline styles', () => {
  const out = sanitiseHtml('<div style="position: fixed; color: red">x</div>');
  assert.ok(!/position\s*:\s*fixed/i.test(out));
  assert.ok(/color: red/.test(out), 'the harmless half stays');
});

test('remote images do not silently phone home', () => {
  const out = sanitiseHtml('<img src="https://pbs.twimg.com/a.jpg" alt="a">');
  // data-remote-src="…" contains the substring src="…", so this has to check
  // for a real attribute — whitespace before src — not a naive includes()
  assert.ok(!/\ssrc\s*=\s*"https?:/.test(out), `still has a live src: ${out}`);
  assert.ok(/\ssrc=""/.test(out), 'the src is neutralised, not deleted');
  assert.ok(out.includes('data-remote-src="https://pbs.twimg.com/a.jpg"'), 'but the url is kept');
});

test('a work skin is confined to the work', () => {
  const css = scopeCss('p { color: red } .textmsg { text-align: right }');
  assert.ok(css.includes('#workskin p'));
  assert.ok(css.includes('#workskin .textmsg'));
});

test('a skin cannot repaint the whole app through body or :root', () => {
  const css = scopeCss('body { background: black } :root { --x: 1px }');
  assert.ok(!/(^|[^#\w])body\s*\{/.test(css), `body rule escaped: ${css}`);
  assert.ok(css.startsWith('#workskin'));
});

test('an already-scoped skin is not double-scoped', () => {
  const css = scopeCss('#workskin .chat { color: blue }');
  assert.equal((css.match(/#workskin/g) || []).length, 1);
});

test('media queries keep working, with their contents scoped', () => {
  const css = scopeCss('@media (max-width: 600px) { .chat { font-size: 12px } }');
  assert.ok(css.includes('@media (max-width: 600px)'));
  assert.ok(css.includes('#workskin .chat'));
});

test('@import and expressions never survive', () => {
  const css = scopeCss('@import url(http://evil/x.css); p { width: expression(alert(1)) }');
  assert.ok(!/@import/i.test(css));
  assert.ok(!/expression\s*\(/i.test(css));
});

test('a stored image is swapped in, a missing one keeps its placeholder', () => {
  const chapter = {
    title: 'One',
    html: '<img src="https://pbs.twimg.com/a.jpg"><img src="https://dead.host/b.jpg">',
  };
  const out = renderChapter(chapter, { images: new Map([['https://pbs.twimg.com/a.jpg', '/img/abc123']]) });
  assert.ok(out.html.includes('src="/img/abc123"'), 'captured image renders locally');
  assert.ok(out.html.includes('ar-missing-image'), 'dead image degrades visibly, not silently');
});

test("Calibre's renaming is undone so AO3's stylesheet matches", async () => {
  const { normaliseAo3Classes } = await import('../app/core/render.js');
  const out = normaliseAo3Classes('<div class="userstuff1 calibre7" id="chapters">'
    + '<p class="calibre3 twtchat">hi</p></div>');
  assert.ok(out.includes('class="userstuff"'), 'userstuff1 must become userstuff');
  assert.ok(!/calibre/i.test(out), "Calibre's own layout classes must not survive");
  assert.ok(out.includes('twtchat'), "the author's own classes are the work itself");
});

test('an element left with no classes loses the attribute entirely', async () => {
  const { normaliseAo3Classes } = await import('../app/core/render.js');
  assert.equal(normaliseAo3Classes('<p class="calibre1">x</p>'), '<p>x</p>');
});

test('a captured image is swapped in even when the markup entity-encodes its query string', () => {
  const chapter = { title: 'x', html: '<img src="https://pbs.twimg.com/m/A?format=jpg&amp;name=large">' };
  const out = renderChapter(chapter, {
    // stored decoded, as imageUrls() extracts it
    images: new Map([['https://pbs.twimg.com/m/A?format=jpg&name=large', '/img/abc']]),
  });
  assert.ok(out.html.includes('src="/img/abc"'), `entity forms must both match: ${out.html}`);
  assert.ok(!out.html.includes('ar-missing-image'), 'and it is no longer marked missing');
});

test('an image packaged inside the EPUB is not left to 404', () => {
  // relative srcs point inside the EPUB the chapter came from and resolve to
  // nothing once stored in a database — 722 of them rendered as broken icons
  const out = sanitiseHtml('<img src="img1.jpg" alt="a picture">');
  assert.ok(!/\ssrc="img1\.jpg"/.test(out), 'the dead relative src must not survive');
  assert.ok(out.includes('data-remote-src="img1.jpg"'), 'but the path is kept for lookup');
  assert.ok(out.includes('ar-missing-image'));
});

test('a stored packaged image renders from local storage', () => {
  const out = renderChapter(
    { title: 'x', html: '<p>before</p><img src="img1.jpg"><p>after</p>' },
    { images: new Map([['img1.jpg', '/img/deadbeef']]) }
  );
  assert.ok(out.html.includes('src="/img/deadbeef"'));
  assert.ok(!out.html.includes('ar-missing-image'), 'no longer missing');
  assert.ok(out.html.includes('before') && out.html.includes('after'));
});

test('an already-local src is left alone', () => {
  const out = sanitiseHtml('<img src="/img/abc123">');
  assert.ok(out.includes('src="/img/abc123"'), 'rendering must be idempotent');
});

test('a chapter with a skin renders scoped css and the work markup together', () => {
  const out = renderChapter(
    { title: 'Chapter 27', html: '<div class="twtchat"><p class="text">hi</p></div>' },
    { skinCss: '#workskin .text { background: #e5e5ea }' }
  );
  assert.ok(out.css.includes('#workskin .text'), 'the skin travels with the chapter');
  assert.equal((out.css.match(/#workskin/g) || []).length, 1, 'and is not double-scoped');
  assert.ok(out.html.includes('class="twtchat"'), 'the markup the skin targets survives');
});

test('a single sanitising pass is not enough, and nesting proves it', () => {
  // removing the inner tag joins the outer halves into a real one, so one
  // pass creates the very tag it was meant to delete
  const attacks = [
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<<script>script>alert(1)<</script>/script>',
    '<scr<iframe>ipt>alert(1)</scr</iframe>ipt>',
  ];
  for (const attack of attacks) {
    const out = sanitiseHtml(attack);
    assert.ok(!/<script|<iframe/i.test(out), `nested tag survived: ${attack} → ${out}`);
  }
});

test('nested event handlers do not reassemble either', () => {
  const out = sanitiseHtml('<img src=x onerror=onerror=alert(1)>');
  assert.ok(!/onerror\s*=/i.test(out), `handler survived: ${out}`);
});

test('sanitising terminates on pathological input', () => {
  // deeply nested markup must not spin; bounded iteration guarantees it
  const nasty = '<scr'.repeat(200) + '<script>' + 'ipt>'.repeat(200);
  const started = Date.now();
  const out = sanitiseHtml(nasty);
  assert.ok(Date.now() - started < 2000, 'must not hang');
  assert.equal(typeof out, 'string');
});
