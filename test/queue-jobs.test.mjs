import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../app/core/sync/queue.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A queue whose waits are controllable, so a test is not an hour long. */
function harness({ runTask } = {}) {
  const order = [];
  const events = [];
  let release = null;
  const q = createQueue({
    runTask: runTask ?? (async (id) => { order.push(id); }),
    wait: () => new Promise((r) => { release = r; }),
    gap: () => 28_000,
    onEvent: (e) => events.push(e),
  });
  return { q, order, events, tick: async () => { release?.(); release = null; await settle(); } };
}

const job = (author, part, ids) => ({ author, part, workIds: ids });

test('a job runs every work it was given', async () => {
  const { q, order, tick } = harness();
  q.add(job('ellen', 'works', ['1', '2', '3']));
  await settle();
  await tick(); await tick();
  assert.deepEqual(order, ['1', '2', '3']);
});

test('a job knows whose it is and which half it is', async () => {
  const { q } = harness();
  q.add(job('ellen', 'bookmarks', ['1']));
  const [j] = q.list();
  assert.equal(j.author, 'ellen');
  assert.equal(j.part, 'bookmarks');
  assert.equal(j.total, 1);
});

test('two ordinary jobs run one after another, never together', async () => {
  const { q, order, tick } = harness();
  q.add(job('a', 'works', ['a1', 'a2']));
  q.add(job('b', 'works', ['b1']));
  await settle();
  await tick();
  await tick();
  /* Two at once asks the archive for twice as much without either job
     knowing, which is the whole reason the pacing exists. What matters is that
     they do not interleave, not exactly which tick each lands on. */
  assert.deepEqual(order, ['a1', 'a2', 'b1']);
  assert.ok(order.indexOf('a2') < order.indexOf('b1'),
    'the first job finishes before the second begins');
});

test('a work that cannot be fetched does not stop the job', async () => {
  const { q, events, tick } = harness({
    runTask: async (id) => { if (id === '2') throw new Error('deleted'); },
  });
  q.add(job('a', 'works', ['1', '2', '3']));
  await settle(); await tick(); await tick();
  const done = events.filter((e) => e.type === 'finished').at(-1).job;
  assert.deepEqual([done.added, done.failed, done.done], [2, 1, 3]);
});

test('starting one now runs it alongside, rather than abandoning the other', async () => {
  const { q, order } = harness();
  q.add(job('long', 'works', ['a1', 'a2', 'a3']));
  await settle();                              // a1 done, waiting before a2
  const urgent = q.add(job('urgent', 'works', ['b1']));
  q.startNow(urgent);
  await settle();

  /* Abandoning a job halfway through an author to serve an impatient tap
     wastes what it had already done. Both run; the archive is asked for twice
     as much, which is the reader's call. */
  assert.deepEqual(order, ['a1', 'b1']);
  assert.equal(q.list().find((j) => j.author === 'long').state, 'running',
    'the long job was not stood down');
});

test('pausing stops after the work in flight and can be resumed', async () => {
  const { q, order, tick } = harness();
  const id = q.add(job('a', 'works', ['1', '2', '3']));
  await settle();
  q.pause(id);
  await tick();
  assert.deepEqual(order, ['1'], 'it stops rather than finishing quietly');
  assert.equal(q.list()[0].state, 'paused');

  q.resume(id);
  await settle();
  await tick();          // it waits before the next work, as it would have
  assert.deepEqual(order, ['1', '2']);
});

test('stopping ends a job but leaves it on the list', async () => {
  const { q, tick } = harness();
  const id = q.add(job('a', 'works', ['1', '2', '3']));
  await settle();
  q.stop(id);
  await tick();
  assert.equal(q.list().length, 1, 'the reader can still see what happened to it');
  assert.equal(q.list()[0].state, 'cancelled');
});

test('deleting takes a job off the list entirely', async () => {
  const { q } = harness();
  const id = q.add(job('a', 'works', ['1', '2']));
  q.add(job('b', 'works', ['3']));
  q.remove(id);
  assert.deepEqual(q.list().map((j) => j.author), ['b']);
});

test('a queued job can be moved up and down the list', async () => {
  const { q } = harness();
  q.add(job('first', 'works', ['1']));
  const second = q.add(job('second', 'works', ['2']));
  q.add(job('third', 'works', ['3']));

  q.moveUp(second);
  assert.deepEqual(q.list().map((j) => j.author), ['second', 'first', 'third']);
  q.moveDown(second);
  assert.deepEqual(q.list().map((j) => j.author), ['first', 'second', 'third']);
});

test('progress is reported as each work lands', async () => {
  const { q, events, tick } = harness();
  q.add(job('a', 'works', ['1', '2']));
  await settle(); await tick();
  const progress = events.filter((e) => e.type === 'progress');
  assert.deepEqual(progress.map((e) => e.job.done), [1, 2]);
  assert.deepEqual(progress.map((e) => e.job.total), [2, 2]);
});

test('what is saved is what is left, not what was done', async () => {
  const { q } = harness();
  q.add(job('a', 'works', ['1', '2', '3', '4']));
  await settle();
  const saved = q.save();
  assert.deepEqual(saved[0].workIds, ['2', '3', '4'],
    'a restart resumes rather than fetching the first one twice');
  assert.equal(saved[0].author, 'a');
});

test('a finished job is not carried across a restart', async () => {
  const { q, tick } = harness();
  q.add(job('a', 'works', ['1']));
  await settle(); await tick();
  assert.deepEqual(q.save(), []);
});

test('a job can grow while it is running', async () => {
  const { q, order, tick } = harness();
  const id = q.add(job('a', 'works', ['1', '2']));
  await settle();
  q.append(id, ['3', '4']);
  await tick(); await tick(); await tick();
  /* A listing is read a page at a time with a pause between. Waiting for the
     whole walk before queueing anything is a minute of an app that looks like
     it did nothing. */
  assert.deepEqual(order, ['1', '2', '3', '4']);
  assert.equal(q.list()[0].total, 4);
});

test('appending the same work twice does not fetch it twice', async () => {
  const { q } = harness();
  const id = q.add(job('a', 'works', ['1', '2']));
  q.append(id, ['2', '3']);
  assert.equal(q.list()[0].total, 3);
});

test('a job that had finished its list picks up what is added after', async () => {
  const { q, order, tick } = harness();
  const id = q.add(job('a', 'works', ['1']));
  await settle(); await tick();
  assert.equal(q.list()[0].state, 'done');

  q.append(id, ['2']);
  await settle(); await tick();
  assert.deepEqual(order, ['1'], 'a finished job stays finished rather than silently reopening');
});

test('a work that failed for a passing reason is tried again', async () => {
  const tries = [];
  let fail = 2;
  const q = createQueue({
    runTask: async (id) => {
      tries.push(id);
      if (fail-- > 0) throw new Error('The archive answered 503');
    },
    wait: async () => {},
    gap: () => 1,
    shouldRetry: (m) => /5\d\d/.test(String(m)),
  });
  q.add(job('a', 'works', ['1']));
  await settle();
  /* Giving up on a 503 writes off a work that was probably fine a minute
     later, and calls it unavailable. */
  assert.deepEqual(tries, ['1', '1', '1']);
  assert.equal(q.list()[0].added, 1);
  assert.equal(q.list()[0].failed, 0);
});

test('a work that is gone is not tried again', async () => {
  const tries = [];
  const q = createQueue({
    runTask: async (id) => { tries.push(id); throw new Error('has been deleted'); },
    wait: async () => {},
    gap: () => 1,
    shouldRetry: (m) => /5\d\d/.test(String(m)),
  });
  q.add(job('a', 'works', ['1']));
  await settle();
  assert.deepEqual(tries, ['1'], 'asking a second time is rude and pointless');
  assert.equal(q.list()[0].failed, 1);
});

test('it gives up eventually rather than trying for ever', async () => {
  const tries = [];
  const q = createQueue({
    runTask: async (id) => { tries.push(id); throw new Error('answered 500'); },
    wait: async () => {},
    gap: () => 1,
    shouldRetry: () => true,
    maxRetries: 2,
  });
  q.add(job('a', 'works', ['1']));
  await settle();
  assert.equal(tries.length, 3, 'the first go and two more');
  assert.equal(q.list()[0].failed, 1);
});

/*
 * A job exists before its work does.
 *
 * Reading an author's index costs two paced requests before the first work is
 * named. The queue used to be created by the page that landed, so for a minute
 * or two after tapping an author there was nothing on the screen to say the tap
 * had done anything, and it read as broken.
 */
test('a job asked for is on the list before its list is known', () => {
  const seen = [];
  const q = createQueue({
    runTask: async () => {}, wait: async () => {}, gap: () => 0,
    onEvent: (e) => seen.push(e.type),
  });
  const id = q.add({ author: 'Anna (pineconepickers)', part: 'works', open: true });
  const [job] = q.list();
  assert.equal(job.state, 'listing', 'it stands there saying it is reading');
  assert.equal(job.total, 0, 'with nothing to count towards yet');
  assert.ok(job.open, 'and says the list is still coming');
  assert.ok(seen.includes('queued'), 'the screen is told at once');
  assert.equal(id, job.id);
});

test('an open job does not report itself finished when it runs dry', async () => {
  const done = [];
  const q = createQueue({
    runTask: async (w) => { done.push(w); }, wait: async () => {}, gap: () => 0,
  });
  const id = q.add({ author: 'a', part: 'works', open: true });
  q.append(id, ['1', '2']);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(done, ['1', '2']);
  assert.equal(q.list()[0].state, 'listing',
    'out of work is not out of list; the next page wakes it');

  q.append(id, ['3']);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(done, ['1', '2', '3'], 'and a later page is still fetched');

  q.seal(id);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(q.list()[0].state, 'done', 'sealing is what ends it');
});

test('sealing a job that never found anything ends it rather than stranding it', () => {
  const q = createQueue({ runTask: async () => {}, wait: async () => {}, gap: () => 0 });
  const id = q.add({ author: 'a', part: 'bookmarks', open: true });
  q.seal(id);
  assert.equal(q.list()[0].state, 'done',
    'a walk that failed must not leave a job reading its list for ever');
});

/*
 * A job whose works all failed reported nothing downloaded and then vanished.
 * `done` counts a work that failed as dealt with, so what was saved for the
 * restart was "what is left", which was nothing — and the job was dropped for
 * being finished as well. Twice over.
 */
test('what ran out of retries is still owed', async () => {
  const q = createQueue({
    runTask: async () => { throw new Error('The app could not reach the archive'); },
    wait: async () => {}, gap: () => 0, maxRetries: 1,
    shouldRetry: (m) => /could not reach/i.test(m),
  });
  q.add({ author: 'beebalm', part: 'works', workIds: ['1', '2'] });
  await new Promise((r) => setTimeout(r, 20));

  const job = q.list()[0];
  assert.equal(job.added, 0);
  assert.equal(job.unfinished, 2, 'both are still owed, not written off');

  const saved = q.save();
  assert.equal(saved.length, 1, 'and the job survives to be picked up again');
  assert.deepEqual(saved[0].workIds, ['1', '2']);
});

test('a work that is genuinely gone is not asked for for ever', async () => {
  const q = createQueue({
    runTask: async () => { throw new Error('That work does not exist, or has been deleted'); },
    wait: async () => {}, gap: () => 0, maxRetries: 1,
    shouldRetry: (m) => /could not reach/i.test(m),
  });
  q.add({ author: 'a', part: 'works', workIds: ['1', '2'] });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(q.list()[0].unfinished, 0, 'a refusal is an answer, not an outage');
  assert.deepEqual(q.save(), [], 'so nothing is carried over');
});

/*
 * A job used to decide it had finished by counting: the task did not throw, so
 * the work arrived. Those are different statements — a fetch can end having
 * stored a description and no text — so jobs reported themselves complete
 * while the works they queued were still stubs.
 */
test('a job is not finished while the works are still missing', async () => {
  let round = 0;
  const asked = [];
  const q = createQueue({
    runTask: async (w) => { asked.push(w); },
    wait: async () => {}, gap: () => 0,
    // missing the first time round, there the second
    verify: async (ids) => (++round === 1 ? ids.slice(0, 1) : []),
  });
  q.add({ author: 'a', part: 'works', workIds: ['1', '2'] });
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(asked, ['1', '2', '1'], 'the one that never arrived is asked for again');
  assert.equal(q.list()[0].state, 'done');
  assert.equal(q.list()[0].unfinished, 0, 'and once it is there, the job is genuinely done');
});

test('a work the archive will not give up does not loop for ever', async () => {
  let calls = 0;
  const q = createQueue({
    runTask: async () => { calls += 1; },
    wait: async () => {}, gap: () => 0, maxRounds: 3,
    verify: async (ids) => ids,          // never arrives, whatever we do
  });
  q.add({ author: 'a', part: 'works', workIds: ['1'] });
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(calls, 3, 'bounded rounds, not an endless retry');
  assert.equal(q.list()[0].state, 'done');
  assert.equal(q.list()[0].unfinished, 1, 'and it says plainly that one never arrived');
});

test('a finished job can be asked for again', async () => {
  const asked = [];
  const q = createQueue({
    runTask: async (w) => { asked.push(w); },
    wait: async () => {}, gap: () => 0,
    verify: async () => [],
  });
  const id = q.add({ author: 'a', part: 'works', workIds: ['1', '2'] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(q.list()[0].state, 'done');

  assert.equal(q.rerun(id), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked, ['1', '2', '1', '2'], 'the whole list, since it all arrived last time');
});

test('a finished job stays on the list', async () => {
  const q = createQueue({
    runTask: async () => {}, wait: async () => {}, gap: () => 0, verify: async () => [],
  });
  q.add({ author: 'a', part: 'works', workIds: ['1'] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(q.list().length, 1,
    'with nowhere to see it, a job that got nothing looked the same as one that got everything');
});
