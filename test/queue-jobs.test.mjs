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
