import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workMetaHtml, workPrefaceHtml } from '../app/core/ao3/markup.js';

const WORK = { title: 'There You Are', rating: 'Mature', language: 'en', words: 8070 };
const TAGS = { fandom: ['BTS'], freeform: ['Fluff', 'First Kiss'], warning: ['No Archive Warnings Apply'] };

test('every tag is a way into the library', () => {
  const html = workMetaHtml(WORK, TAGS);
  for (const name of ['BTS', 'Fluff', 'First Kiss']) {
    assert.ok(html.includes(`data-filter="tag" data-value="${name}"`), `${name} is not tappable`);
  }
});

test('a rating filters as a rating, not as a tag', () => {
  // it is a column on the work; there is no tag called Mature to match
  const html = workMetaHtml(WORK, TAGS);
  assert.ok(html.includes('data-filter="rating" data-value="Mature"'));
  assert.ok(!html.includes('data-filter="tag" data-value="Mature"'));
});

test('a language shows its name and filters on its code', () => {
  const html = workMetaHtml(WORK, TAGS);
  assert.ok(html.includes('data-filter="language" data-value="en"'), 'filters on the code');
  assert.ok(html.includes('>English<'), 'and reads as the language');
});

test('the byline is a way to the rest of an author\'s work', () => {
  const html = workPrefaceHtml(WORK, ['staewme']);
  assert.ok(html.includes('data-filter="author" data-value="staewme"'));
});

test('an anonymous work offers nothing to tap', () => {
  const html = workPrefaceHtml(WORK, []);
  assert.ok(html.includes('Anonymous'));
  assert.ok(!html.includes('data-filter="author"'), 'there is no author to look up');
});

test('a value carrying quotes cannot break out of its attribute', () => {
  const html = workMetaHtml(WORK, { freeform: ['say "hi" <b>'] });
  assert.ok(!html.includes('data-value="say "hi"'), 'the quote must not close the attribute');
  assert.ok(html.includes('&quot;'), 'it is escaped');
  assert.ok(!html.includes('<b>'), 'and so is the markup');
});

test('a work with no tags of a kind shows no empty row', () => {
  const html = workMetaHtml(WORK, {});
  assert.ok(!html.includes('Fandom:'), 'a row with nothing in it is not shown');
});
