import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMatchinfo, bm25, rank } from '../app/core/search.js';

/** Build a matchinfo('pcnalx') blob the way SQLite lays one out. */
function matchinfo({ phrases = 1, columns = 1, rows = 100, avg = [50], len = [50], x = [[1, 1, 1]] }) {
  const words = [phrases, columns, rows, ...avg, ...len, ...x.flat()];
  const bytes = new Uint8Array(words.length * 4);
  words.forEach((w, i) => {
    bytes[i * 4] = w & 0xff; bytes[i * 4 + 1] = (w >> 8) & 0xff;
    bytes[i * 4 + 2] = (w >> 16) & 0xff; bytes[i * 4 + 3] = (w >> 24) & 0xff;
  });
  return bytes;
}

test('little-endian words are read back correctly', () => {
  assert.deepEqual(readMatchinfo(matchinfo({})).slice(0, 3), [1, 1, 100]);
});

test('a rare term scores higher than a common one', () => {
  const rare = bm25(matchinfo({ rows: 1000, x: [[1, 1, 2]] }));
  const common = bm25(matchinfo({ rows: 1000, x: [[1, 900, 900]] }));
  assert.ok(rare > common, `rare ${rare} should beat common ${common}`);
});

test('more hits in a row score higher, with diminishing returns', () => {
  const one = bm25(matchinfo({ rows: 1000, x: [[1, 50, 50]] }));
  const five = bm25(matchinfo({ rows: 1000, x: [[5, 50, 50]] }));
  const fifty = bm25(matchinfo({ rows: 1000, x: [[50, 50, 50]] }));
  assert.ok(five > one);
  assert.ok(fifty > five);
  assert.ok(fifty - five < (five - one) * 10, 'term frequency must saturate, not run away');
});

test('a hit in a short chapter beats the same hit in a long one', () => {
  const short = bm25(matchinfo({ rows: 1000, avg: [3000], len: [500], x: [[2, 40, 40]] }));
  const long = bm25(matchinfo({ rows: 1000, avg: [3000], len: [9000], x: [[2, 40, 40]] }));
  assert.ok(short > long, 'length normalisation should favour the denser match');
});

test('a term in every row scores zero rather than negative', () => {
  assert.equal(bm25(matchinfo({ rows: 100, x: [[3, 100, 100]] })), 0);
});

test('unparseable matchinfo scores zero instead of throwing', () => {
  assert.equal(bm25(new Uint8Array([1, 2, 3])), 0);
  assert.equal(bm25(null), 0);
  assert.equal(bm25(undefined), 0);
});

test('ranking orders by score, trims, and drops the blob', () => {
  const rows = [
    { id: 'common', matchinfo: matchinfo({ rows: 1000, x: [[1, 900, 900]] }) },
    { id: 'rare', matchinfo: matchinfo({ rows: 1000, x: [[3, 2, 2]] }) },
    { id: 'middling', matchinfo: matchinfo({ rows: 1000, x: [[1, 100, 100]] }) },
  ];
  const out = rank(rows, 2);
  assert.equal(out.length, 2, 'trimmed to the limit');
  assert.equal(out[0].id, 'rare');
  assert.ok(!('matchinfo' in out[0]), 'the blob is working state, not output');
  assert.ok('score' in out[0]);
});

test('matchinfo that crossed the bridge as base64 reads the same', () => {
  const bytes = matchinfo({ rows: 1000, x: [[3, 2, 2]] });
  const asBase64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual(readMatchinfo(asBase64), readMatchinfo(bytes));
  assert.equal(bm25(asBase64), bm25(bytes));
});
