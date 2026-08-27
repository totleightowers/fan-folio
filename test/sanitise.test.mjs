import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseFragment, sanitiseCss } from '../app/core/sanitise.js';

test('an unknown element is dropped, its text kept', () => {
  const out = sanitiseFragment('<p>before</p><marquee>middle</marquee><p>after</p>');
  assert.ok(!/<marquee/i.test(out));
  assert.ok(out.includes('middle'), 'the words survive even when the element does not');
});

test('script and style take their contents with them', () => {
  // dropping the tag alone would spill the source into the page as text
  for (const tag of ['script', 'style']) {
    const out = sanitiseFragment(`<p>a</p><${tag}>SECRET</${tag}><p>b</p>`);
    assert.ok(!out.includes('SECRET'), `${tag} contents leaked: ${out}`);
    assert.ok(out.includes('a') && out.includes('b'));
  }
});

test('nesting cannot reassemble a tag, because none is ever removed', () => {
  for (const attack of [
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<<script>script>alert(1)<</script>/script>',
    '<img src=x onerror=onerror=alert(1)>',
    '<svg/onload=alert(1)>',
    '<iframe srcdoc="<script>alert(1)</script>">',
  ]) {
    const out = sanitiseFragment(attack);
    assert.ok(!/<script|<svg|<iframe|onerror|onload|srcdoc/i.test(out),
      `survived: ${attack} -> ${out}`);
  }
});

test('a scheme we do not trust is refused, however it is disguised', () => {
  const disguises = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\u0009script:alert(1)',
    'java\u0000script:alert(1)',
    ' javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
  ];
  for (const href of disguises) {
    const out = sanitiseFragment(`<a href="${href}">x</a>`);
    assert.ok(!/href=/i.test(out), `href survived for ${JSON.stringify(href)}: ${out}`);
  }
});

test('relative and ordinary links survive', () => {
  // requiring a scheme would drop every image packaged inside an EPUB
  assert.match(sanitiseFragment('<img src="img1.jpg">'), /src="img1\.jpg"/);
  assert.match(sanitiseFragment('<a href="https://example.com/x">x</a>'), /href="https/);
  assert.match(sanitiseFragment('<a href="#notes">x</a>'), /href="#notes"/);
});

test('an entity is not escaped a second time', () => {
  // &amp;amp; reads as literal "&amp;", and breaks a stored image URL match
  assert.equal(sanitiseFragment('<img src="a?x=1&amp;y=2">'), '<img src="a?x=1&amp;y=2">');
  assert.equal(sanitiseFragment('<p>Tom &amp; Jerry</p>'), '<p>Tom &amp; Jerry</p>');
  assert.equal(sanitiseFragment('<p>a & b</p>'), '<p>a &amp; b</p>', 'a bare one still is');
});

test('the formatting a work depends on is kept', () => {
  const fic = '<div class="twtchat"><p class="text" style="text-align: right">hi</p>'
    + '<em>em</em><strong>strong</strong><blockquote>q</blockquote></div>';
  const out = sanitiseFragment(fic);
  for (const bit of ['twtchat', 'class="text"', 'text-align: right', '<em>', '<strong>', '<blockquote>']) {
    assert.ok(out.includes(bit), `lost ${bit}`);
  }
});

test('css that escapes the work is stripped from a style attribute', () => {
  const out = sanitiseFragment('<div style="position: fixed; color: red">x</div>');
  assert.ok(!/position\s*:\s*fixed/i.test(out));
  assert.match(out, /color: red/, 'the harmless half stays');
});

test('an unbalanced tree is closed rather than left open', () => {
  // an unclosed div would otherwise swallow the rest of the page
  const out = sanitiseFragment('<div><p>text');
  assert.ok(out.endsWith('</p></div>'), `not closed: ${out}`);
});

test('a stray close tag is ignored', () => {
  assert.equal(sanitiseFragment('</div><p>x</p>'), '<p>x</p>');
});

test('a link that opens elsewhere does not hand over the opener', () => {
  const out = sanitiseFragment('<a href="https://example.com" target="_blank">x</a>');
  assert.match(out, /rel="noopener noreferrer"/);
});

test('comments and doctypes are dropped entirely', () => {
  assert.equal(sanitiseFragment('<!-- hidden --><p>x</p><!doctype html>'), '<p>x</p>');
});

test('work skin css keeps its rules and loses what can escape', () => {
  const css = sanitiseCss('/* c */ .text { background: #eee } .bad { position: fixed } @import url(x);');
  assert.ok(css.includes('.text'));
  assert.ok(!/position\s*:\s*fixed/.test(css));
  assert.ok(!/@import/.test(css));
  assert.ok(!css.includes('/* c */'));
});

test('sanitising is idempotent', () => {
  const once = sanitiseFragment('<p class="a">Tom &amp; Jerry <em>x</em></p>');
  assert.equal(sanitiseFragment(once), once, 'rendering twice must not change anything');
});
