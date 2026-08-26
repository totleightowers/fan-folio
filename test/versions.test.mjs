import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVersioning, normaliseForComparison, hashContent, CHANGE } from '../app/core/versions.js';

const ch = (number, html) => ({ number, html });

test('an unchanged refetch records no version', async () => {
  const held = { chapters: [ch(1, '<p>Hello.</p>')] };
  const plan = await planVersioning(held, { chapters: [ch(1, '<p>Hello.</p>')] });
  assert.equal(plan.changed, false);
  assert.equal(plan.changes.length, 0);
});

test('whitespace and comments alone are not a new version', async () => {
  const held = { chapters: [ch(1, '<p>Hello.</p><p>There.</p>')] };
  const noisy = { chapters: [ch(1, '<p>Hello.</p>\n  <!-- kudos 12 -->\n<p>There.</p>')] };
  const plan = await planVersioning(held, noisy);
  assert.equal(plan.changed, false, 'AO3 restamps pages constantly; that is not an edit');
});

test('an actual edit is recorded, with the old copy attached', async () => {
  const held = { chapters: [ch(1, '<p>He left.</p>')] };
  const plan = await planVersioning(held, { chapters: [ch(1, '<p>He stayed.</p>')] });
  assert.equal(plan.changed, true);
  assert.equal(plan.changes[0].change, CHANGE.CONTENT);
  assert.equal(plan.changes[0].previous.html, '<p>He left.</p>', 'the superseded text must be kept');
  assert.notEqual(plan.changes[0].previousHash, plan.changes[0].hash);
});

test('a new chapter is new, not a change to an old one', async () => {
  const held = { chapters: [ch(1, '<p>One.</p>')] };
  const plan = await planVersioning(held, { chapters: [ch(1, '<p>One.</p>'), ch(2, '<p>Two.</p>')] });
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].change, CHANGE.NEW);
  assert.equal(plan.changes[0].number, 2);
});

test('a deleted chapter keeps its last known text', async () => {
  const held = { chapters: [ch(1, '<p>One.</p>'), ch(2, '<p>Cut scene.</p>')] };
  const plan = await planVersioning(held, { chapters: [ch(1, '<p>One.</p>')] });
  const gone = plan.changes.find((c) => c.number === 2);
  assert.ok(gone, 'a chapter vanishing is a change');
  assert.equal(gone.removed, true);
  assert.equal(gone.previous.html, '<p>Cut scene.</p>');
});

test('a work skin change is a layout change', async () => {
  const plan = await planVersioning(
    { chapters: [], skinCss: '.text { background: #eee }' },
    { chapters: [], skinCss: '.text { background: #ddd }' }
  );
  assert.equal(plan.skinChange.change, CHANGE.LAYOUT);
  assert.equal(plan.changed, true);
});

test('gaining a skin where there was none counts', async () => {
  const plan = await planVersioning({ chapters: [], skinCss: null }, { chapters: [], skinCss: '.a{}' });
  assert.ok(plan.skinChange);
});

test('no skin before and none after is not a change', async () => {
  const plan = await planVersioning({ chapters: [], skinCss: null }, { chapters: [], skinCss: '' });
  assert.equal(plan.skinChange, null);
  assert.equal(plan.changed, false);
});

test('normalisation collapses markup noise but keeps words', () => {
  const n = normaliseForComparison('<p>He   said\n  "no".</p>  <!-- x -->');
  assert.ok(n.includes('He said "no".'));
  assert.ok(!n.includes('<!--'));
});

test('hashing is stable and content-sensitive', async () => {
  assert.equal(await hashContent('abc'), await hashContent('abc'));
  assert.notEqual(await hashContent('abc'), await hashContent('abd'));
});

test('a fresh CSRF token is not an edit', async () => {
  const a = { chapters: [ch(1, '<input name="authenticity_token" value="AAA" /><p>Same words.</p>')] };
  const b = { chapters: [ch(1, '<input name="authenticity_token" value="BBB" /><p>Same words.</p>')] };
  const plan = await planVersioning(a, b);
  assert.equal(plan.changed, false, 'AO3 mints a new token per request; that is not a revision');
});
