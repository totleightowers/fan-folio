import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForm, csrfToken, encodeForm } from '../app/core/ao3/forms.js';

/** A Rails form of the shape the archive serves for a new bookmark. */
const BOOKMARK_FORM = `
<html><head><meta name="csrf-token" content="tok+en/with&amp;special=="></head><body>
<form action="/works/123/bookmarks" method="post" id="bookmark-form">
  <input type="hidden" name="authenticity_token" value="tok+en/with&amp;special==">
  <select name="bookmark[pseud_id]">
    <option value="11">alt-pseud</option>
    <option value="22" selected>main-pseud</option>
  </select>
  <textarea name="bookmark[bookmarker_notes]">a note &amp; a half</textarea>
  <input type="text" name="bookmark[tag_string]" value="">
  <input type="checkbox" name="bookmark[private]" value="1">
  <input type="checkbox" name="bookmark[rec]" value="1" checked>
  <input type="submit" name="commit" value="Create">
</form></body></html>`;

test('a form gives up its action, method and token', () => {
  const form = parseForm(BOOKMARK_FORM, 'id="bookmark-form"');
  assert.equal(form.action, '/works/123/bookmarks');
  assert.equal(form.method, 'post');
  assert.equal(form.fields.authenticity_token, 'tok+en/with&special==');
});

test('an escaped ampersand is decoded, or the token is simply the wrong token', () => {
  assert.equal(csrfToken(BOOKMARK_FORM), 'tok+en/with&special==');
  assert.ok(!csrfToken(BOOKMARK_FORM).includes('&amp;'));
});

test('a select submits the option marked selected, not the first', () => {
  assert.equal(parseForm(BOOKMARK_FORM, 'id="bookmark-form"').fields['bookmark[pseud_id]'], '22');
});

test('a select with nothing marked submits the first, as a browser would', () => {
  const html = `<form id="f"><select name="s"><option value="a">A</option><option value="b">B</option></select></form>`;
  assert.equal(parseForm(html, 'id="f"').fields.s, 'a');
});

test('an unticked checkbox is not submitted at all', () => {
  const fields = parseForm(BOOKMARK_FORM, 'id="bookmark-form"').fields;
  // submitting it is how a private bookmark quietly becomes a public one
  assert.ok(!('bookmark[private]' in fields));
  assert.equal(fields['bookmark[rec]'], '1');
});

test('the submit button is not a field', () => {
  assert.ok(!('commit' in parseForm(BOOKMARK_FORM, 'id="bookmark-form"').fields));
});

test('a textarea keeps its contents, decoded', () => {
  assert.equal(parseForm(BOOKMARK_FORM, 'id="bookmark-form"').fields['bookmark[bookmarker_notes]'],
    'a note & a half');
});

test('a form that is not there is null rather than an empty form', () => {
  // an empty form would be posted; null stops before anything is sent
  assert.equal(parseForm(BOOKMARK_FORM, 'id="not-here"'), null);
  assert.equal(parseForm('', 'id="f"'), null);
});

test('one form does not swallow the next', () => {
  const html = `<form id="a"><input name="x" value="1"></form><form id="b"><input name="y" value="2"></form>`;
  assert.deepEqual(parseForm(html, 'id="a"').fields, { x: '1' });
  assert.deepEqual(parseForm(html, 'id="b"').fields, { y: '2' });
});

test('the token is found on a page whose form is built by script', () => {
  assert.equal(csrfToken('<meta name="csrf-token" content="abc123">'), 'abc123');
  assert.equal(csrfToken('<input name="authenticity_token" value="xyz789">'), 'xyz789');
  assert.equal(csrfToken('<html>nothing here</html>'), null);
});

test('encoding escapes what would otherwise change the meaning', () => {
  assert.equal(encodeForm({ 'a[b]': 'x&y', c: 'p q' }), 'a%5Bb%5D=x%26y&c=p%20q');
  assert.equal(encodeForm({ a: '1', b: undefined }), 'a=1');
});

/**
 * The consent interstitial, in the shape the archive serves it.
 *
 * A Mature work answers with this instead of the page asked for unless
 * view_adult is sent — and it carries a form of its own, pointing at the work.
 * A matcher loose enough to accept "a form whose action starts /works/" picks
 * this up, fills it in, and posts the consent form as though it were a
 * bookmark. That is exactly what happened.
 */
const INTERSTITIAL = `
<html><body>
  <p>This work could have adult content. If you continue, you have agreed that you are
     willing to see such content.</p>
  <form action="/works/12345" method="get" id="new_session">
    <input type="hidden" name="view_adult" value="true">
    <input type="submit" value="Yes, Continue">
  </form>
</body></html>`;

test('the consent interstitial is not mistaken for a bookmark form', () => {
  assert.equal(parseForm(INTERSTITIAL, 'action="/works/12345/bookmarks"'), null);
  assert.equal(parseForm(INTERSTITIAL, 'id="bookmark-form"'), null);
  assert.equal(parseForm(INTERSTITIAL, 'id="new_bookmark"'), null);
});

test('the consent interstitial is not mistaken for a comment form', () => {
  assert.equal(parseForm(INTERSTITIAL, 'action="/works/12345/comments"'), null);
  assert.equal(parseForm(INTERSTITIAL, 'id="new_comment"'), null);
});

test('a loose matcher would have caught it, which is why there is not one', () => {
  // kept as the record of the bug: this is what the old fallback did
  const wrong = parseForm(INTERSTITIAL, 'action="/works/');
  assert.ok(wrong, 'the interstitial does carry a form, and it does match loosely');
  assert.equal(wrong.action, '/works/12345', 'which is not where a bookmark is created');
});
