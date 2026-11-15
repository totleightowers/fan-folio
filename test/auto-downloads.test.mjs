import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../app/core/sync/queue.js';
import { createAutoDownloads, isAutoDownload } from '../app/core/sync/auto-downloads.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function harness({ ids = [], saved = {}, restored = [], fail = [], hold = false, batchSize = 2000 } = {}) {
  let state = structuredClone(saved), release, controller, allowed = true;
  const calls = [], failures = new Set(fail), held = new Set();
  const queue = createQueue({
    runTask: async (id, job) => {
      calls.push(id);
      if (isAutoDownload(job)) assert.equal(job.source.kind, 'saved-auto');
      if (failures.has(id)) throw new Error('Unavailable');
      held.add(id);
    },
    wait: () => hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve(), gap: () => 28000,
    onEvent(event) {
      controller?.event(event);
      if (event.type === 'finished') queueMicrotask(() => controller.refresh());
    },
  });
  const make = () => createAutoDownloads({ queue, missing: () => ids.filter(id => !held.has(String(id))),
    read: () => state, write: value => { state = structuredClone(value); }, canRun: () => allowed, batchSize });
  controller = make(); controller.start();
  for (const job of restored) queue.restore(job);
  return { queue, calls, ids, held, get controller() { return controller; }, get state() { return state; },
    restart() { controller = make(); controller.start(); controller.refresh(); },
    allow(value) { allowed = value; },
    async tick() { const resolve = release; release = null; resolve?.(); await settle(); } };
}

test('automatic downloads are opt-in and gated by account/database readiness', async () => {
  const h = harness({ ids: ['1'] });
  h.controller.refresh(); await settle(); assert.deepEqual(h.calls, []);
  h.allow(false); h.controller.setEnabled(true); await settle(); assert.deepEqual(h.calls, []);
  h.allow(true); h.controller.refresh(); await settle(); assert.deepEqual(h.calls, ['1']);
});

test('the toggle drains more than 2000 known works in bounded jobs, then picks up discoveries', async () => {
  const h = harness({ ids: Array.from({ length: 2003 }, (_, i) => String(i + 1)) });
  h.controller.setEnabled(true); await settle();
  assert.equal(h.calls.length, 2003);
  assert.deepEqual(h.queue.list().map(job => job.total), [2000, 3]);
  assert.equal(new Set(h.calls).size, 2003);
  h.ids.push('2004'); h.controller.refresh(); await settle();
  assert.equal(h.calls.at(-1), '2004');
});

test('failed works stay inspectable and are not requeued after restart or clearing old results', async () => {
  const h = harness({ ids: ['1', '2', '3'], fail: ['1'], batchSize: 2 });
  h.controller.setEnabled(true); await settle();
  assert.deepEqual(h.calls, ['1', '2', '3']);
  assert.equal(h.queue.details(h.queue.list()[0].id).items[0].state, 'failed');
  h.restart(); await settle(); assert.equal(h.calls.length, 3);
  h.controller.setEnabled(false);
  for (const job of h.queue.list()) h.queue.remove(job.id);
  h.controller.setEnabled(true); await settle(); assert.equal(h.calls.length, 3);
});

test('pending works in another job are not duplicated; pausing all also holds future discoveries', async () => {
  const h = harness({ ids: ['1', '2', '3'], hold: true });
  const other = h.queue.add({ author: 'An author', part: 'works', workIds: ['1', '2'] });
  await settle(); h.controller.setEnabled(true);
  assert.deepEqual(h.queue.details(h.queue.list().find(isAutoDownload).id).items.map(i => i.workId), ['3']);
  h.controller.pause();
  for (const job of h.queue.list()) h.queue.pause(job.id);
  await h.tick(); h.ids.push('4'); h.restart(); await settle();
  assert.deepEqual(h.calls, ['1']); assert.equal(h.state.paused, true);
  h.queue.resume(other);
  for (const job of h.queue.list().filter(isAutoDownload)) h.queue.resume(job.id);
  h.controller.resume(); await settle(); await h.tick(); await h.tick();
  assert.deepEqual(h.calls, ['1', '2', '3', '4']);
});

test('turning off pauses its own job, keeps the queue, and turning on resumes it', async () => {
  const h = harness({ ids: ['1', '2'], hold: true });
  h.controller.setEnabled(true); await settle();
  h.controller.setEnabled(false); await h.tick();
  assert.deepEqual(h.calls, ['1']); assert.equal(h.queue.list()[0].state, 'paused');
  h.restart(); await settle(); assert.deepEqual(h.calls, ['1']);
  h.controller.setEnabled(true); await settle(); await h.tick();
  assert.deepEqual(h.calls, ['1', '2']);
});

test('Stop disables automatic replenishment instead of recreating a stopped job', async () => {
  const h = harness({ ids: ['1', '2'], hold: true });
  h.controller.setEnabled(true); await settle();
  h.queue.stop(h.queue.list()[0].id); await h.tick();
  h.ids.push('3'); h.restart(); await settle();
  assert.equal(h.state.enabled, false); assert.deepEqual(h.calls, ['1']);
});

test('restored results recover an interrupted attempt checkpoint without retrying failures', async () => {
  const h = harness({ ids: ['1', '2'], saved: { enabled: true }, restored: [
    { author: 'Your library', part: 'automatic downloads', source: { kind: 'saved-auto' },
      state: 'done', workIds: [], items: [{ workId: '1', state: 'failed' }], historyComplete: true },
  ] });
  h.controller.refresh(); await settle(); assert.deepEqual(h.calls, ['2']);
});

test('clearing a finished result does not turn off automatic downloading', async () => {
  const h = harness({ ids: ['1'] });
  h.controller.setEnabled(true); await settle();
  h.queue.remove(h.queue.list()[0].id);
  h.ids.push('2'); h.controller.refresh(); await settle();
  assert.equal(h.state.enabled, true); assert.deepEqual(h.calls, ['1','2']);
});
