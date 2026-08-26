import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSync, mergeListings, epochToDate, heldAsOf, estimate } from '../app/core/sync/plan.js';

const held = (over = {}) => ({ updated: '2024-01-01', needsSkin: false, ...over });
const listed = (epoch, over = {}) => ({ updatedAt: epoch, ...over });
const EPOCH_2024_06 = Math.floor(Date.parse('2024-06-01T00:00:00Z') / 1000);
const EPOCH_2023_06 = Math.floor(Date.parse('2023-06-01T00:00:00Z') / 1000);

test('a work we do not hold is fetched', () => {
  const p = planSync({ 1: listed(EPOCH_2024_06) }, {});
  assert.deepEqual(p.actions.fetch, ['1']);
  assert.equal(p.counts.requests, 1);
});

test('a work we hold and that has not changed costs nothing', () => {
  const p = planSync({ 1: listed(EPOCH_2023_06) }, { 1: held() });
  assert.deepEqual(p.actions.skip, ['1']);
  assert.equal(p.counts.requests, 0, 'the whole point of the index');
});

test('a work AO3 says is newer is refetched', () => {
  const p = planSync({ 1: listed(EPOCH_2024_06) }, { 1: held({ updated: '2024-01-01' }) });
  assert.deepEqual(p.actions.refetch, ['1']);
  assert.match(p.reasons.get('1'), /AO3 2024-06-01 > held 2024-01-01/);
});

test('a one-shot with only a published date still compares', () => {
  const p = planSync(
    { 1: listed(EPOCH_2024_06) },
    { 1: { published: '2020-01-01', updated: null, completed: null } }
  );
  assert.deepEqual(p.actions.refetch, ['1'], 'published is the fallback, not a free pass');
});

test('a copy captured after AO3 last changed the work is current', () => {
  const p = planSync(
    { 1: listed(EPOCH_2023_06) },
    { 1: { downloadedAt: '2025-09-08', published: '2019-01-01' } }
  );
  assert.deepEqual(p.actions.skip, ['1'], 'downloaded long after the last revision');
});

test('missing dates on both sides do not trigger a pointless refetch', () => {
  const p = planSync({ 1: { updatedAt: null } }, { 1: { published: null } });
  assert.deepEqual(p.actions.skip, ['1'], 'no evidence of change is not evidence of change');
});

test('a held, current work with custom markup is queued for its skin only', () => {
  const p = planSync({ 1: listed(EPOCH_2023_06) }, { 1: held({ needsSkin: true }) });
  assert.deepEqual(p.actions.skin, ['1']);
});

test('a skin already stored is not fetched again', () => {
  const p = planSync({ 1: listed(EPOCH_2023_06) }, { 1: held({ needsSkin: true, skinCss: '.x{}' }) });
  assert.deepEqual(p.actions.skip, ['1']);
});

test('a changed work is refetched rather than merely skinned', () => {
  const p = planSync({ 1: listed(EPOCH_2024_06) }, { 1: held({ needsSkin: true }) });
  assert.deepEqual(p.actions.refetch, ['1'], 'a refetch brings the skin with it — one request, not two');
  assert.equal(p.actions.skin.length, 0);
});

test('works in both bookmarks and history are fetched once', () => {
  const merged = mergeListings({
    bookmarks: { 1: listed(EPOCH_2023_06), 2: listed(EPOCH_2023_06) },
    history: { 2: listed(EPOCH_2024_06), 3: listed(EPOCH_2023_06) },
  });
  assert.equal(merged.size, 3, 'three distinct works, not four rows');
  assert.equal(merged.get('2').inBookmarks, true);
  assert.equal(merged.get('2').inHistory, true);
  assert.equal(merged.get('2').updatedAt, EPOCH_2024_06, 'the newer epoch wins');
});

test('epoch converts to the date form the library stores', () => {
  assert.equal(epochToDate(1787732527), '2026-08-26');
  assert.equal(epochToDate(undefined), null);
});

test('the capture date wins over what the work says about itself', () => {
  assert.equal(heldAsOf({ downloadedAt: 'z', updated: 'a', published: 'c' }), 'z');
});

test('held date falls back through updated, completed, published', () => {
  assert.equal(heldAsOf({ updated: 'a', completed: 'b', published: 'c' }), 'a');
  assert.equal(heldAsOf({ completed: 'b', published: 'c' }), 'b');
  assert.equal(heldAsOf({ published: 'c' }), 'c');
  assert.equal(heldAsOf({}), null);
});

test('an estimate is legible before a long run starts', () => {
  assert.equal(estimate(100, 29000).human, '48 min');
  assert.equal(estimate(3600, 29000).hours, 29);
});
