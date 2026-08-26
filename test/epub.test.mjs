import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findWorkId, parsePreface, parseStats, htmlToText, countWords, decodeEntities,
} from '../app/core/epub.js';

const PREFACE = `
<p class="message">
  <b>#Title</b><br/>
  Posted originally on the <a href="http://archiveofourown.org/">Archive of Our Own</a>
  at <a href="http://archiveofourown.org/works/23690653">http://archiveofourown.org/works/23690653</a>.
</p>
<dl class="tags">
  <dt>Rating:</dt><dd><a href="/tags/Explicit">Explicit</a></dd>
  <dt>Archive Warning:</dt><dd><a href="/t">No Archive Warnings Apply</a></dd>
  <dt>Fandom:</dt><dd><a href="/t">Bangtan Boys | BTS</a></dd>
  <dt>Additional Tags:</dt>
  <dd><a href="/t">oh my god, they were roommates</a>, <a href="/t">Fluff</a></dd>
  <dt>Stats:</dt>
  <dd>Published: 2020-04-16 Completed: 2021-09-06 Words: 100,392 Chapters: 31/31</dd>
</dl>`;

test('work id comes from the "posted originally" sentence', () => {
  assert.equal(findWorkId(PREFACE), '23690653');
});

test('a work linked in author notes is not mistaken for the work itself', () => {
  const notes = '<p>Sequel to <a href="http://archiveofourown.org/works/99999999">that one</a>.</p>';
  assert.equal(findWorkId(notes), null);
  // and when both appear, the preface sentence still wins
  assert.equal(findWorkId(PREFACE + notes), '23690653');
});

test('tags containing commas survive', () => {
  const { freeform } = parsePreface(PREFACE);
  assert.deepEqual(freeform, ['oh my god, they were roommates', 'Fluff']);
});

test('tag groups stay separate', () => {
  const p = parsePreface(PREFACE);
  assert.equal(p.rating, 'Explicit');
  assert.deepEqual(p.warnings, ['No Archive Warnings Apply']);
  assert.deepEqual(p.fandoms, ['Bangtan Boys | BTS']);
});

test('stats parse into numbers and a completion flag', () => {
  const s = parseStats('Published: 2020-04-16 Completed: 2021-09-06 Words: 100,392 Chapters: 31/31');
  assert.equal(s.published, '2020-04-16');
  assert.equal(s.words, 100392);
  assert.equal(s.chapters, 31);
  assert.equal(s.chaptersPlanned, 31);
  assert.equal(s.complete, true);
});

test('a work in progress is not marked complete', () => {
  const s = parseStats('Published: 2024-01-01 Updated: 2024-06-01 Words: 5,000 Chapters: 3/?');
  assert.equal(s.complete, false);
  assert.equal(s.chaptersPlanned, null);
  assert.equal(s.updated, '2024-06-01');
});

test('paragraph breaks become whitespace, not run-together words', () => {
  assert.equal(htmlToText('<p>end.</p><p>Next</p>'), 'end.\nNext');
  assert.equal(htmlToText('<script>bad()</script><p>ok</p>'), 'ok');
});

test('entities decode, including numeric', () => {
  assert.equal(decodeEntities('a &amp; b &#39;c&#39; &#x2014;'), "a & b 'c' —");
});

test('word count ignores markup punctuation but keeps apostrophes', () => {
  assert.equal(countWords("don't stop — believing"), 3);
});

test('a chapter stores its body, not the whole xhtml document', async () => {
  const { bodyOf } = await import('../app/core/epub.js');
  const doc = `<?xml version='1.0'?><html><head><title>Fic - Author</title>
    <link rel="stylesheet" href="s.css"/></head><body class="calibre"><p>Real text.</p></body></html>`;
  const body = bodyOf(doc);
  assert.ok(body.includes('<p>Real text.</p>'));
  assert.ok(!/<head>|<title>|stylesheet/i.test(body), 'head must not reach the reader or the index');
});

test('the title page and afterword are not chapters', async () => {
  const { bodyOf } = await import('../app/core/epub.js');
  // the shapes AO3 actually emits, as seen in the library
  const titlePage = bodyOf('<html><body><div id="preface" class="calibre1"><h1>Fic</h1>'
    + '<div class="byline">by someone</div></div></body></html>');
  const chapter = bodyOf('<html><body><div class="userstuff1" id="chapters"><p>Real prose.</p></div></body></html>');
  assert.match(titlePage, /id="preface"/, 'the marker the filter keys on');
  assert.ok(!/id="(preface|afterword)"/i.test(chapter), 'a real chapter carries neither marker');
});
