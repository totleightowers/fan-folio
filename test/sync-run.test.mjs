import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNewBookmarks, fetchWorks, nextGap, MIN_GAP_MS } from '../app/core/sync/run.js';

/* The shape parsePagination actually returns. A fake that invents a field the
   parser does not produce tests nothing but itself. */
const page = (ids, total = 3) => ({
  works: ids.map((workId) => ({ workId })),
  pagination: { current: 1, total },
});

test('walking stops once a page holds nothing new', async () => {
  const asked = [];
  const held = new Set(['old1', 'old2']);
  const { workIds } = await findNewBookmarks({
    fetchPage: async (p) => { asked.push(p); return page(p === 1 ? ['new1', 'old1'] : ['old1', 'old2']); },
    isHeld: (id) => held.has(id),
  });
  /* Bookmarks are newest first, so a page with nothing new means the rest was
     gathered on an earlier run. A full walk is 86 pages; this is two. */
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(workIds, ['new1']);
});

test('everything new across several pages is collected', async () => {
  const { workIds } = await findNewBookmarks({
    fetchPage: async (p) => page(p === 1 ? ['a', 'b'] : p === 2 ? ['c'] : ['d']),
    isHeld: () => false,
  });
  assert.deepEqual(workIds, ['a', 'b', 'c', 'd']);
});

test('walking stops at the last page the archive reports', async () => {
  let calls = 0;
  await findNewBookmarks({
    fetchPage: async () => { calls++; return page(['x' + calls], 2); },
    isHeld: () => false,
  });
  assert.equal(calls, 2, 'it does not ask for a page beyond the end');
});

test('a sync can be stopped while it is walking', async () => {
  let calls = 0;
  const { workIds } = await findNewBookmarks({
    fetchPage: async () => { calls++; return page(['y' + calls], 50); },
    isHeld: () => false,
    shouldStop: () => calls >= 2,
  });
  assert.equal(calls, 2);
  assert.equal(workIds.length, 2);
});

test('a work that cannot be fetched does not end the sync', async () => {
  const { added, failed } = await fetchWorks({
    workIds: ['1', '2', '3'],
    fetchWork: async (id) => {
      if (id === '2') throw new Error('deleted');
      return { workId: id };
    },
    wait: async () => {},
  });
  // a bookmark outlives the work it points at
  assert.deepEqual(added.map((a) => a.workId), ['1', '3']);
  assert.deepEqual(failed, [{ workId: '2', reason: 'deleted' }]);
});

test('it waits between works, but not before the first', async () => {
  const waits = [];
  await fetchWorks({
    workIds: ['1', '2', '3'],
    fetchWork: async (id) => ({ workId: id }),
    wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(waits.length, 2, 'two gaps for three works');
  for (const ms of waits) assert.ok(ms > 0);
});

test('fetching stops when asked', async () => {
  let done = 0;
  await fetchWorks({
    workIds: ['1', '2', '3', '4'],
    fetchWork: async (id) => { done++; return { workId: id }; },
    wait: async () => {},
    shouldStop: () => done >= 2,
  });
  assert.equal(done, 2);
});

test('the gap between requests is varied, not a metronome', () => {
  const gaps = Array.from({ length: 400 }, () => nextGap());
  const unique = new Set(gaps).size;
  assert.ok(unique > 100, 'a fixed interval is the easiest thing to notice');

  for (const g of gaps) {
    assert.ok(g >= MIN_GAP_MS * 0.45, `${g} is too close to the last request`);
    assert.ok(g <= MIN_GAP_MS * 2.5, `${g} waits absurdly long`);
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(mean > MIN_GAP_MS * 0.6 && mean < MIN_GAP_MS * 1.6, `mean gap ${Math.round(mean)}ms`);
});

/* ------------------------------------------------- an author's whole listing */
const { walkListing, listingCost, shouldWalkWholeListing, PER_LISTING_PAGE } =
  await import('../app/core/sync/run.js');

test('the size of a listing is known from its page count alone', () => {
  const cost = listingCost(3);
  assert.equal(cost.pages, 3);
  assert.equal(cost.works, 3 * PER_LISTING_PAGE);
  assert.ok(cost.minutes >= 1, 'and roughly how long it will take');
});

test('a small author opens without being asked; a prolific one asks first', () => {
  assert.equal(shouldWalkWholeListing(1), true, '20 works is a single request');
  assert.equal(shouldWalkWholeListing(9), true, '180 works is under the threshold');
  assert.equal(shouldWalkWholeListing(10), false, '200 is not fewer than 200');
  assert.equal(shouldWalkWholeListing(40), false, '800 works is minutes of waiting');
});

test('walking a listing keeps works already held', () => {
  // an author page is asked for to see all of it, not only the unfamiliar parts
  return walkListing({
    fetchPage: async (p) => page(p === 1 ? ['a', 'b'] : ['c'], 2),
    wait: async () => {},
  }).then(({ works, totalPages }) => {
    assert.deepEqual(works.map((w) => w.workId), ['a', 'b', 'c']);
    assert.equal(totalPages, 2);
  });
});

test('walking a listing can be stopped', async () => {
  let calls = 0;
  const { works } = await walkListing({
    fetchPage: async () => { calls++; return page(['w' + calls], 20); },
    wait: async () => {},
    shouldStop: () => calls >= 3,
  });
  assert.equal(works.length, 3);
});

/* ------------------------------------------------- worth trying again? */
const { isTransient, retryDelay } = await import('../app/core/sync/run.js');

test('a server having a bad moment is worth trying again', () => {
  for (const reason of [
    'The archive answered 500', 'The archive answered 503',
    'could not reach the archive', 'network error', 'timed out',
  ]) assert.equal(isTransient(reason), true, reason);
});

test('a work that is gone is not worth trying again', () => {
  /* Asking a second time for a deleted work is rude and pointless, and
     counting a 500 alongside it writes off something that was probably fine a
     minute later. */
  for (const reason of [
    'That work does not exist, or has been deleted',
    'The archive answered 404', 'The archive answered 403',
    'No chapters found. The work may be restricted, deleted, or need a login.',
  ]) assert.equal(isTransient(reason), false, reason);
});

test('waiting longer after each failure', () => {
  assert.ok(retryDelay(1) > retryDelay(0));
  assert.ok(retryDelay(2) > retryDelay(1));
  assert.equal(retryDelay(9), retryDelay(3), 'and it stops growing rather than waiting for ever');
});

/*
 * Never getting there is always worth trying again.
 *
 * A phone loses a host for a moment — a tunnel, a handover between masts, a
 * network that has not finished coming up — and every one of those arrived as
 * "UnknownHostException: Unable to resolve host", which matched nothing here
 * and so was treated as a verdict on the work. A few seconds without signal
 * permanently gave up on whatever was in flight, and the reader was told the
 * work had been skipped, which was neither true nor anything they could act on.
 */
test('failing to reach the archive is worth trying again', () => {
  for (const reason of [
    'The app could not reach the archive: UnknownHostException: Unable to resolve host'
      + ' "archiveofourown.org": No address associated with hostname',
    'UnknownHostException: Unable to resolve host',
    'java.net.SocketTimeoutException: timeout',
    'SSLException: Read error: ssl=0x0: I/O error during system call',
    'ConnectException: Connection refused',
    'unexpected end of stream',
    'the archive answered 502',
  ]) {
    assert.equal(isTransient(reason), true, `should be retried: ${reason.slice(0, 60)}`);
  }
});

test('the archive saying no is still not worth trying again', () => {
  for (const reason of [
    'the archive answered 404',
    'That work does not exist, or has been deleted',
    'That work is restricted — sign in to the archive first',
    'no chapters found',
  ]) {
    assert.equal(isTransient(reason), false, `should not be retried: ${reason}`);
  }
});
