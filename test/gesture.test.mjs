import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisOf, travel, commits, commitDistance, inSystemEdge, ownsHorizontal, dismisses, RESIST } from '../app/core/gesture.js';

test('a gesture is undecided until it has travelled', () => {
  assert.equal(axisOf(0, 0), 'undecided');
  assert.equal(axisOf(3, 2), 'undecided');
});

test('scrolling down a chapter never turns the page', () => {
  assert.equal(axisOf(4, 40), 'vertical');
  assert.equal(axisOf(-6, 30), 'vertical');
});

test('a mostly-sideways drag is a page turn even when the hand wobbles', () => {
  assert.equal(axisOf(40, 12), 'horizontal');
  assert.equal(axisOf(-40, 12), 'horizontal');
});

test('the page follows the finger exactly when there is somewhere to go', () => {
  assert.equal(travel(-73), -73);
  assert.equal(travel(120), 120);
});

test('pulling past the last chapter moves, but visibly resists', () => {
  const pulled = travel(-100, { blocked: true });
  assert.equal(pulled, -100 * RESIST);
  assert.ok(Math.abs(pulled) > 0, 'a surface that cannot move cannot refuse');
  assert.ok(Math.abs(pulled) < 100, 'and it must not look like it is turning');
});

test('commitment is a quarter of the screen, capped for small phones', () => {
  assert.equal(commitDistance(360), 90);      // a quarter
  assert.equal(commitDistance(800), 110);     // the cap, not 200
});

test('a short flick settles back rather than turning', () => {
  assert.equal(commits(-40, 360), false);
  assert.equal(commits(-95, 360), true);
});

test('a long pull towards a chapter that is not there still refuses', () => {
  assert.equal(commits(-300, 360, { allowed: false }), false);
});

test('the system back gesture keeps the edges', () => {
  assert.equal(inSystemEdge(4, 360), true);
  assert.equal(inSystemEdge(356, 360), true);
  assert.equal(inSystemEdge(180, 360), false);
});

test('a sideways-scrolling row owns the gesture that lands on it', () => {
  // a tag row wider than its box, which is what the work page is mostly made of
  assert.equal(ownsHorizontal({ scrollWidth: 900, clientWidth: 360, overflowX: 'auto' }), true);
});

test('a row that merely overflows without scrolling does not', () => {
  assert.equal(ownsHorizontal({ scrollWidth: 900, clientWidth: 360, overflowX: 'visible' }), false);
});

test('a rounding pixel does not disable the page turn', () => {
  // treating this as a scroller would kill the gesture across most of the page
  assert.equal(ownsHorizontal({ scrollWidth: 361, clientWidth: 360, overflowX: 'auto' }), false);
});

test('a sheet dismisses on a downward drag, never an upward one', () => {
  assert.equal(dismisses(-200, 500), false, 'dragging up is reaching for content');
  assert.equal(dismisses(200, 500), true);
});

test('a tall sheet is not dismissed by a short drag', () => {
  assert.equal(dismisses(80, 700), false);   // 11% of it
  assert.equal(dismisses(80, 200), true);    // most of it
});

test('a decisive flick dismisses without travelling far', () => {
  assert.equal(dismisses(40, 700), false);
  assert.equal(dismisses(40, 700, { velocity: 1.4 }), true);
});
