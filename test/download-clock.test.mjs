import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQueue } from '../app/core/sync/queue.js';
const js = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };

function clocks() {
  const source = js.slice(js.indexOf('const waitingOnTheArchive = new Set();'), js.indexOf('function paced(run) {'));
  const queueWait = js.match(/runTask: \(workId\) => paced[\s\S]*?wait: ([^\n]+),\n/)[1];
  const listingWait = js.match(/const wait = ([^\n]+);/)[1];
  let now = 1000000;
  const window = {};
  const timers = new Map(); let serial = 0;
  const waits = new Function('setTimeout', 'clearTimeout', 'Date', 'window', source + `\nreturn { queueWait: ${queueWait}, listingWait: ${listingWait} };`)(
    fn => { timers.set(++serial, fn); return serial; }, id => timers.delete(id), { now: () => now }, window);
  return { ...waits, tick: ms => { now += ms; return window.__tick(); } };
}

test('native ticks advance queue gaps with page timers suspended, never before due', async () => {
  const clock = clocks(); const requests = [];
  const q = createQueue({ runTask: async id => requests.push(id), wait: clock.queueWait, gap: () => 28000 });
  q.add({ author: 'a', part: 'works', workIds: ['1', '2'] });
  await flush(); clock.tick(27000); await flush();
  assert.deepEqual(requests, ['1']);
  assert.equal(clock.tick(1000), true, 'the page acknowledges its native heartbeat');
  await flush();
  assert.deepEqual(requests, ['1', '2']);
  assert.equal(q.list()[0].state, 'done');
});

test('native ticks also release retry backoff and author listing waits', async () => {
  const clock = clocks(); let calls = 0;
  const q = createQueue({
    runTask: async () => { if (++calls === 1) throw new Error('525'); },
    wait: clock.queueWait, gap: () => 0, retryWait: () => 60000, shouldRetry: () => true,
  });
  q.add({ author: 'a', part: 'works', workIds: ['1'] });
  let listed = false;
  clock.listingWait(60000).then(() => { listed = true; });
  await flush(); clock.tick(59000); await flush();
  assert.equal(calls, 1); assert.equal(listed, false);
  clock.tick(1000); await flush();
  assert.equal(calls, 2); assert.equal(listed, true);
  assert.equal(q.list()[0].state, 'done');
});
