import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageCollector } from '../app/core/images.js';

function setup(overrides = {}) {
  const shown = [], progress = [], requests = [];
  const outcomes = [{ url: 'a', sha256: 'saved' }, { url: 'b', error: 'unavailable' }, { done: true }];
  const collector = createImageCollector({
    fetchNext: async (...args) => { requests.push(args); return outcomes.shift(); },
    isCurrent: () => true, proxy: () => true,
    onImage: image => shown.push(image), onProgress: result => progress.push({ ...result }),
    wait: async () => {}, ...overrides,
  });
  return { collector, shown, progress, requests };
}
test('image recovery saves successes, reports failures, and shares one runner', async () => {
  const { collector, shown, progress, requests } = setup();
  const first = collector.start('1', 2), second = collector.start('1', 2);
  assert.equal(first, second);
  assert.deepEqual(await first, { saved: 1, failed: 1, cancelled: false });
  assert.deepEqual(shown, [{ url: 'a', sha256: 'saved' }]);
  assert.equal(progress.at(-1).failed, 1);
  assert.ok(requests.every(args => args[0] === '1' && args[1].chapter === 2 && args[1].proxy));
});
test('leaving a chapter allows its pending save but never inserts it into another chapter', async () => {
  let release, current = true;
  const { collector, shown, requests } = setup({
    fetchNext: () => new Promise(resolve => { release = resolve; }), isCurrent: () => current,
  });
  const pending = collector.start('1', 1);
  current = false; release({ url: 'a', sha256: 'saved' });
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(shown, []);
});
test('changing chapters serialises native image requests and continues at the new chapter', async () => {
  let release;
  const requests = [];
  const { collector, shown } = setup({ fetchNext: (id, { chapter }) => {
    requests.push(chapter);
    if (chapter === 1) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ done: true });
  } });
  const old = collector.start('1', 1), next = collector.start('1', 2);
  assert.deepEqual(requests, [1]);
  release({ url: 'a', sha256: 'old' });
  assert.equal((await old).cancelled, true);
  assert.equal((await next).cancelled, false);
  assert.deepEqual(shown, []);
  assert.deepEqual(requests, [1, 2]);
});
test('manual retry waits for an outstanding fetch to settle before clearing failures', async () => {
  let release;
  const { collector, shown } = setup({ fetchNext: () => new Promise(resolve => { release = resolve; }) });
  const running = collector.start('1', 1);
  let settled = false;
  const cancellation = collector.cancel().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release({ url: 'a', sha256: 'saved' });
  await cancellation;
  assert.equal((await running).cancelled, true);
  assert.deepEqual(shown, []);
});
test('a disabled proxy applies to each subsequent request', async () => {
  const { collector, requests } = setup({ proxy: () => false });
  await collector.start('1', 1);
  assert.ok(requests.every(args => args[1].proxy === false));
});
test('storage failures cannot create an endless download loop', async () => {
  const { collector } = setup({ fetchNext: async () => ({ url: 'a', error: 'storage full' }) });
  await assert.rejects(collector.start('1', 1), /storage full/);
});
