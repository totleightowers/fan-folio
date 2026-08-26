import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, BudgetSpent } from '../app/core/queue.js';

/** A clock that only moves when something sleeps — so tests are instant. */
function fakeClock() {
  let t = 0;
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => { slept.push(Math.round(ms)); t += ms; },
    slept,
    advance: (ms) => { t += ms; },
  };
}
const ok = { status: 200, headers: new Headers() };
const busy = (h = {}) => ({ status: 429, headers: new Headers(h) });

test('requests are spaced by at least the interval', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 5000, jitter: 0, ...c, random: () => 0.5 });
  const at = [];
  for (let i = 0; i < 3; i++) await l.run(async () => { at.push(c.now()); return ok; });
  assert.deepEqual(at, [0, 5000, 10000]);
});

test('a 429 with Retry-After waits exactly that long', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, jitter: 0, ...c });
  let n = 0;
  const res = await l.run(async () => (++n === 1 ? busy({ 'retry-after': '90' }) : ok));
  assert.equal(res.status, 200);
  assert.ok(c.slept.includes(90000), `expected a 90s wait, got ${c.slept}`);
});

test('a 429 without Retry-After backs off exponentially', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, jitter: 0, maxRetries: 3, ...c });
  let n = 0;
  await l.run(async () => (++n < 4 ? busy() : ok));
  const waits = c.slept.filter((w) => w >= 60000);
  assert.deepEqual(waits, [60000, 120000, 240000]);
});

test('backoff is capped so a bad night cannot sleep for hours', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, jitter: 0, maxRetries: 8, maxBackoff: 300000, ...c });
  let n = 0;
  await l.run(async () => (++n < 9 ? busy() : ok));
  assert.ok(Math.max(...c.slept) <= 300000);
});

test('a 404 is an answer, not something to retry', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, ...c });
  let calls = 0;
  const res = await l.run(async () => { calls++; return { status: 404, headers: new Headers() }; });
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test('giving up returns the last response rather than throwing', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, jitter: 0, maxRetries: 2, ...c });
  const res = await l.run(async () => busy());
  assert.equal(res.status, 429, 'the caller decides what a persistent 429 means');
});

test('the budget stops a run before it becomes a scrape', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, budget: 2, ...c });
  await l.run(async () => ok);
  await l.run(async () => ok);
  await assert.rejects(() => l.run(async () => ok), BudgetSpent);
});

test('one failure does not poison the tasks queued behind it', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, maxRetries: 0, ...c });
  const bad = l.run(async () => { throw new Error('network down'); });
  const good = l.run(async () => ok);
  await assert.rejects(() => bad, /network down/);
  assert.equal((await good).status, 200);
});

test('throttling is counted, so a run can report how close it came', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, jitter: 0, maxRetries: 1, ...c });
  let n = 0;
  await l.run(async () => (++n === 1 ? busy() : ok));
  assert.equal(l.stats.throttled, 1);
  assert.equal(l.stats.requests, 2);
});

/** Deterministic PRNG — a test that fails one run in fifty teaches nothing. */
function seeded(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

test('gaps are irregular, not a narrow band around the interval', () => {
  const gaps = [];
  let t = 0;
  const l = createLimiter({
    minInterval: 20000,
    random: seeded(12345),
    now: () => t,
    sleep: async (ms) => { gaps.push(ms); t += ms; },
  });
  return (async () => {
    for (let i = 0; i < 300; i++) await l.run(async () => ok);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // politeness is preserved: the average gap is still around the interval
    assert.ok(mean > 15000 && mean < 45000, `mean gap ${Math.round(mean)}ms should sit near 20000`);
    // but the spread is wide — a fixed ±20% jitter could never produce this
    const spread = Math.max(...gaps) / Math.min(...gaps);
    assert.ok(spread > 4, `max/min gap ratio ${spread.toFixed(1)} should be wide`);
    // and nothing fires too fast to be plausible
    assert.ok(Math.min(...gaps) >= 20000 * 0.45, 'a floor still applies');
  })();
});

test("Cloudflare's transient 52x codes are retried, not treated as answers", async () => {
  for (const status of [520, 521, 522, 523, 524, 525, 526, 527, 408]) {
    const c = fakeClock();
    const l = createLimiter({ minInterval: 0, jitter: 0, maxRetries: 2, ...c });
    let n = 0;
    const res = await l.run(async () => (++n === 1
      ? { status, headers: new Headers() }
      : { status: 200, headers: new Headers() }));
    assert.equal(res.status, 200, `${status} should have been retried`);
    assert.equal(n, 2);
  }
});

test('a 404 is still an answer', async () => {
  const c = fakeClock();
  const l = createLimiter({ minInterval: 0, ...c });
  let calls = 0;
  const res = await l.run(async () => { calls++; return { status: 404, headers: new Headers() }; });
  assert.equal(calls, 1, 'not everything in the 4xx range is transient');
  assert.equal(res.status, 404);
});
