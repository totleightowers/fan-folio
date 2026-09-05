import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachedTheEnd } from '../app/core/reading.js';

/*
 * Every case here is one a phone reported and no test could.
 *
 * The rule was three conditions on `window` inside the reader, and it said
 * the end of a chapter had been reached whenever the foot of the page was on
 * screen. That is true the moment a chapter opens, so works were finished by
 * being opened and left the Continue reading shelf unread.
 */

/** A phone: 360x780, so a screen is 780 tall. */
const phone = (over) => ({ innerHeight: 780, ...over });

test('a chapter with nothing to scroll is not a chapter read to its end', () => {
  /* One screenful of text. scrollHeight barely exceeds the viewport, so the
     foot of the page is on screen from the first frame. */
  assert.equal(reachedTheEnd(phone({ scrollHeight: 800, scrollY: 0, openedAt: 0 })), false);
  assert.equal(reachedTheEnd(phone({ scrollHeight: 780, scrollY: 0, openedAt: 0 })), false);
});

test('a layout that has not settled yet says nothing about reading', () => {
  /* Before the text is laid out, scrollHeight is the empty page. This is the
     state at the requestAnimationFrame after a chapter is written into the
     document, which is exactly where this used to be asked. */
  assert.equal(reachedTheEnd(phone({ scrollHeight: 780, scrollY: 0, openedAt: 0 })), false);
});

test('being put back where you left off is not reading to the end', () => {
  /* A long chapter, reopened at the place it was left — which is near the
     foot, because that is where somebody stops. Opening scrolls there, the
     scroll handler fires, and nobody has moved. */
  const scrollHeight = 12000;
  const room = scrollHeight - 780;
  assert.equal(reachedTheEnd(phone({ scrollHeight, scrollY: room, openedAt: room })), false);
  assert.equal(reachedTheEnd(phone({ scrollHeight, scrollY: room, openedAt: room - 30 })), false,
    'a few pixels of settling is still not somebody reading');
});

test('reading to the foot of a long chapter is reading to its end', () => {
  const scrollHeight = 12000;
  const room = scrollHeight - 780;
  assert.equal(reachedTheEnd(phone({ scrollHeight, scrollY: room, openedAt: 0 })), true);
  assert.equal(reachedTheEnd(phone({ scrollHeight, scrollY: room - 60, openedAt: 0 })), true,
    'nobody scrolls the last pixel');
});

test('finishing the last stretch of a chapter reopened near its end counts', () => {
  /* The ordinary case for a work being carried on with: it opens where you
     stopped, and you read the rest. Being too strict here would mean the last
     chapter of every work in progress never finished by itself. */
  const scrollHeight = 12000;
  const room = scrollHeight - 780;
  assert.equal(reachedTheEnd(phone({ scrollHeight, scrollY: room, openedAt: room - 900 })), true);
});

test('the middle of a chapter is not the end of it', () => {
  const scrollHeight = 12000;
  assert.equal(reachedTheEnd(phone({ scrollHeight, scrollY: 4000, openedAt: 0 })), false);
});

test('numbers that are not numbers decide nothing', () => {
  assert.equal(reachedTheEnd(), false);
  assert.equal(reachedTheEnd({}), false);
  assert.equal(reachedTheEnd(phone({ scrollHeight: NaN, scrollY: NaN })), false);
  assert.equal(reachedTheEnd(phone({ scrollHeight: undefined, scrollY: 500 })), false);
});
