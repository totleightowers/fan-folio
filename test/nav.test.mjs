import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../app/core/nav.js';

const at = (route, params = {}, scrollY = 0, query = '') => ({ route, params, scrollY, query });

test('back returns to the place departed from, at its own offset', () => {
  const h = new History();
  h.reset();                                  // as tapping the Library tab does
  h.go(at('library', {}, 1840), at('detail', { workId: '1' }));
  const back = h.back();
  assert.equal(back.route, 'library');
  assert.equal(back.scrollY, 1840);
});

test('a work opened from the library does not go back to home', () => {
  const h = new History();
  h.reset();
  h.go(at('library', {}, 1840), at('detail', { workId: '1' }));
  h.go(at('detail', { workId: '1' }), at('reader', { workId: '1', chapter: 1 }));
  assert.equal(h.back().route, 'detail');     // reader -> the work it belongs to
  assert.equal(h.back().route, 'library');    // work -> the shelf it came from
  assert.equal(h.back(), null);               // and then out of the app
});

test('a search keeps its query and position across a reading excursion', () => {
  const h = new History();
  h.go(at('library', {}, 900), at('results', { query: 'lighthouse' }));
  h.go(at('results', { query: 'lighthouse' }, 420, 'lighthouse'),
       at('reader', { workId: '9', chapter: 1 }));
  const back = h.back();
  assert.equal(back.route, 'results');
  assert.equal(back.query, 'lighthouse');
  assert.equal(back.scrollY, 420);
});

test('going where you already are is not a navigation', () => {
  const h = new History();
  h.go(at('detail', { workId: '1' }), at('reader', { workId: '1', chapter: 7 }));
  // the same chapter again is the same place, however it was asked for
  h.go(at('reader', { workId: '1', chapter: 7 }, 300),
       at('reader', { workId: '1', chapter: 7 }));
  assert.equal(h.depth, 1, 'and does not need a Back to undo');
  assert.equal(h.back().route, 'detail');
});

/*
 * There is one Detail element and one Results element in the page, so a route
 * name described whichever thing had most recently been painted into it. Go
 * Work A, its author, Work B, then back twice, and the second Back unhid a
 * Detail holding Work B.
 */
test('two works are two places, not one screen', () => {
  const h = new History();
  h.go(at('library', {}, 100), at('detail', { workId: 'A' }));
  h.go(at('detail', { workId: 'A' }, 200), at('library', { author: 'someone' }));
  h.go(at('library', { author: 'someone' }, 300), at('detail', { workId: 'B' }));

  assert.equal(h.back().params.author, 'someone', 'the author listing');
  const workA = h.back();
  assert.equal(workA.route, 'detail');
  assert.equal(workA.params.workId, 'A', 'and Work A, not whatever Detail holds now');
});

test('two searches are two places', () => {
  const h = new History();
  h.go(at('home', {}, 0), at('results', { query: 'dragon' }));
  h.go(at('results', { query: 'dragon' }, 250, 'dragon'), at('detail', { workId: '1' }));
  h.go(at('detail', { workId: '1' }), at('results', { query: 'sword', workId: '1' }));
  h.back();
  const older = h.back();
  assert.equal(older.params.query, 'dragon');
  assert.equal(older.query, 'dragon', 'the box and the results agree about which search');
});

test('two library filters are two places', () => {
  const h = new History();
  const first = { filters: { state: 'all', rating: ['Explicit'] } };
  const second = { filters: { state: 'later', rating: [] } };
  h.go(at('library', first, 920), at('detail', { workId: '1' }));
  h.go(at('detail', { workId: '1' }), at('library', second));
  h.back();
  const back = h.back();
  assert.deepEqual(back.params.filters, first.filters,
    'back to the library that was left, not the newest one');
});

/*
 * Back is where you came from; Up is where a thing belongs. A chapter belongs
 * to its work whether or not the work is what you came from — and treating the
 * two as one made Reader and Work a pair that each led to the other for ever.
 */
test('up to the work goes back when the work is behind you', () => {
  const h = new History();
  h.go(at('library', {}, 0), at('detail', { workId: '7' }));
  h.go(at('detail', { workId: '7' }, 40), at('reader', { workId: '7', chapter: 1 }));

  const { popped } = h.up(at('reader', { workId: '7', chapter: 1 }), { route: 'detail', params: { workId: '7' } });
  assert.ok(popped, 'the work was right there, so going up is going back');
  assert.equal(popped.params.workId, '7');
  assert.equal(h.depth, 1, 'and the reader is not left on the stack to return to');
});

test('up to the work does not pop somebody else', () => {
  const h = new History();
  h.go(at('home', {}, 0), at('reader', { workId: '7', chapter: 1 }));
  const { popped } = h.up(at('reader', { workId: '7', chapter: 1 }), { route: 'detail', params: { workId: '7' } });
  assert.equal(popped, null, 'the reader was opened straight from Home; Work was never behind it');
  assert.equal(h.depth, 1, 'so Home is still what Back leads to');
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
