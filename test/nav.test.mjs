import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../app/core/nav.js';

const at = (screen, scrollY = 0, query = '') => ({ screen, scrollY, query });

test('back returns to the screen departed from, at its own offset', () => {
  const h = new History();
  h.reset();                                  // as tapping the Library tab does
  h.go(at('library', 1840), 'detail');
  const back = h.back();
  assert.equal(back.screen, 'library');
  assert.equal(back.scrollY, 1840);
});

test('a work opened from the library does not go back to home', () => {
  const h = new History();
  h.reset();
  h.go(at('library', 1840), 'detail');
  h.go(at('detail', 0), 'reader');
  assert.equal(h.back().screen, 'detail');    // reader -> the work it belongs to
  assert.equal(h.back().screen, 'library');   // work -> the shelf it came from
  assert.equal(h.back(), null);               // and then out of the app
});

test('a search keeps its query and position across a reading excursion', () => {
  const h = new History();
  h.go(at('library', 900), 'results');
  h.go(at('results', 420, 'lighthouse'), 'reader');
  const back = h.back();
  assert.equal(back.screen, 'results');
  assert.equal(back.query, 'lighthouse');
  assert.equal(back.scrollY, 420);
});

test('turning a page is not a navigation', () => {
  const h = new History();
  h.go(at('detail'), 'reader');
  // openChapter runs again for the next chapter, still in the reader
  h.go(at('reader', 300), 'reader');
  h.go(at('reader', 700), 'reader');
  assert.equal(h.depth, 1, 'reading twelve chapters must not need twelve Backs');
  assert.equal(h.back().screen, 'detail');
});

test('switching tabs starts a fresh branch', () => {
  const h = new History();
  h.go(at('library', 1840), 'detail');
  h.reset();
  assert.equal(h.depth, 0);
  assert.equal(h.back(), null);
});

test('back from the first screen reports that it handled nothing', () => {
  assert.equal(new History().back(), null);
});

/* ----------------------------------------------- where a chapter opens */
const { openingOffset } = await import('../app/core/nav.js');

test('a chapter opens where it was left off', () => {
  const at = { '7': { chapter: 3, y: 4200 } };
  assert.equal(openingOffset(at, '7', 3), 4200);
});

test('a different chapter opens at its beginning, not the last one\'s offset', () => {
  // this is the bug: swiping to chapter 4 landed at chapter 3's offset
  const at = { '7': { chapter: 3, y: 4200 } };
  assert.equal(openingOffset(at, '7', 4), 0);
  assert.equal(openingOffset(at, '7', 2), 0);
});

test('a work never opened starts at the beginning', () => {
  assert.equal(openingOffset({}, '7', 1), 0);
  assert.equal(openingOffset(undefined, '7', 1), 0);
});

test('a reading excursion from a search result leaves no bookmark to return to', () => {
  const at = { '7': { chapter: 3, y: 4200 } };
  assert.equal(openingOffset(at, '7', 3, { transient: true }), 0);
});

test('a nonsensical remembered offset opens at the beginning', () => {
  for (const y of [null, undefined, NaN, -50, 'somewhere']) {
    assert.equal(openingOffset({ '7': { chapter: 3, y } }, '7', 3), 0, `y=${y}`);
  }
});
