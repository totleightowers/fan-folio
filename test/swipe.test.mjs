import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwipe } from '../app/core/swipe.js';

/** A surface that records what was done to it, standing in for the reader. */
function surface() {
  const classes = new Set();
  const props = new Map();
  return {
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
    },
    addEventListener() {},
    setPointerCapture() {},
    has: (c) => classes.has(c),
    prop: (k) => props.get(k),
  };
}

/** A finger, moving across a 360px-wide screen. */
async function drag(swipe, { from = 180, to, y = 400, steps = 6 } = {}) {
  swipe.down({ pointerId: 1, pointerType: 'touch', clientX: from, clientY: y, target: null });
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    swipe.move({ pointerId: 1, clientX: x, clientY: y });
  }
  await swipe.up({ pointerId: 1, clientX: to, clientY: y });
}

function reader(overrides = {}) {
  const turned = [];
  const el = surface();
  const swipe = createSwipe(el, {
    onLeft: () => { turned.push('next'); },
    onRight: () => { turned.push('prev'); },
    viewportWidth: () => 360,
    reduceMotion: () => true,          // skip the animation waits in tests
    duration: { out: 0, in: 0, settle: 0 },
    ...overrides,
  });
  return { swipe, turned, el };
}

test('a firm leftward drag turns to the next chapter', async () => {
  const { swipe, turned } = reader();
  await drag(swipe, { to: 40 });        // 140px, well past the 90px commit
  assert.deepEqual(turned, ['next']);
});

test('a firm rightward drag turns back a chapter', async () => {
  const { swipe, turned } = reader();
  await drag(swipe, { from: 180, to: 330 });
  assert.deepEqual(turned, ['prev']);
});

test('a short flick does not turn the page', async () => {
  const { swipe, turned } = reader();
  await drag(swipe, { to: 140 });       // 40px
  assert.deepEqual(turned, []);
});

test('a vertical scroll never turns the page', async () => {
  const { swipe, turned } = reader();
  swipe.down({ pointerId: 1, pointerType: 'touch', clientX: 180, clientY: 200, target: null });
  for (let y = 220; y <= 500; y += 40) swipe.move({ pointerId: 1, clientX: 184, clientY: y });
  await swipe.up({ pointerId: 1, clientX: 184, clientY: 500 });
  assert.deepEqual(turned, []);
});

test('the last chapter refuses rather than turning', async () => {
  const { swipe, turned } = reader({ canLeft: () => false });
  await drag(swipe, { to: 20 });
  assert.deepEqual(turned, []);
});

test('a gesture starting in the system edge is left to the system', async () => {
  const { swipe, turned } = reader();
  await drag(swipe, { from: 8, to: 300 });   // within 24px of the left edge
  assert.deepEqual(turned, []);
});

test('a chapter that scrolls sideways keeps the gesture only while it can move', async () => {
  const atLimit = reader({ scrollsSideways: () => false });
  await drag(atLimit.swipe, { to: 40 });
  assert.deepEqual(atLimit.turned, ['next'], 'a scroller with nowhere to go must not eat the turn');

  const canScroll = reader({ scrollsSideways: () => true });
  await drag(canScroll.swipe, { to: 40 });
  assert.deepEqual(canScroll.turned, [], 'and must keep it while it still can');
});

test('the surface is left clean after a turn', async () => {
  const { swipe, el } = reader();
  await drag(swipe, { to: 40 });
  assert.equal(el.has('swiping'), false, 'no class left behind');
  assert.equal(el.prop('--page-x'), undefined, 'and no offset left applied');
});

test('a cancelled gesture settles back rather than turning', async () => {
  const { swipe, turned, el } = reader();
  swipe.down({ pointerId: 1, pointerType: 'touch', clientX: 180, clientY: 400, target: null });
  swipe.move({ pointerId: 1, clientX: 60, clientY: 400 });
  swipe.cancel();
  assert.deepEqual(turned, []);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(el.has('swiping'), false);
});
