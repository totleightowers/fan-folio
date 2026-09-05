/**
 * When a chapter has actually been read to its end.
 *
 * This lived inside the reader as three conditions on `window`, which is the
 * one place a test could not reach it — and it was wrong in a way that was
 * only visible on a phone. It said the end had been reached whenever the foot
 * of the page was on screen, and that is true the instant a chapter opens:
 *
 *   - a chapter with nothing to scroll is already at its own foot;
 *   - a chapter whose layout has not settled reports no scrolling room, so it
 *     looks exactly like the one above;
 *   - opening a chapter scrolls it to where you left off, which fires the
 *     scroll handler with nobody having moved at all.
 *
 * A one-chapter work — most of a library — was therefore finished by being
 * opened, and left the Continue reading shelf before it had been read.
 *
 * Kept here as arithmetic on four numbers so it can be asked the questions
 * that broke it, without a browser.
 */

/* A chapter's worth of scrolling has to exist before scrolling to the end of
   it can mean anything. Below this the answer is always no, and Mark finished
   on the work page is how a short one gets said. */
export const NEEDS_ROOM = 200;

/* Near enough to the foot: the last line of a chapter is rarely flush with the
   bottom of the screen, and nobody scrolls the final pixel. */
export const NEAR_FOOT = 120;

/* Far enough from where the chapter opened to be somebody moving rather than
   the app restoring a position. */
export const MOVED = 40;

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function reachedTheEnd({ scrollY, innerHeight, scrollHeight, openedAt = 0 } = {}) {
  const room = number(scrollHeight) - number(innerHeight);
  if (room < NEEDS_ROOM) return false;
  if (number(scrollY) < room - NEAR_FOOT) return false;
  /* Opening a chapter is not reading it, however far down it opens. */
  if (number(scrollY) <= number(openedAt) + MOVED) return false;
  return true;
}


/* How far a finger has to travel before it counts as a direction rather than
   a wobble on a train. */
export const A_DIRECTION = 24;

/**
 * Whether the reader's controls should be out of the way.
 *
 * Seven pill buttons pinned across the foot of a chapter are seven things
 * competing with the sentence above them, for the whole of a work. They are
 * navigation, and navigation is wanted at the moments somebody is not reading
 * — so they go while the page is moving forwards and come back the instant it
 * moves back, which is the same gesture as looking for them.
 *
 * They are never hidden at the top of a chapter, where nobody has started
 * reading yet, nor at the foot, where the next chapter is the whole point of
 * being there.
 */
export function chromeHidden({ scrollY, lastY, innerHeight, scrollHeight, hidden = false } = {}) {
  const y = number(scrollY);
  const room = number(scrollHeight) - number(innerHeight);
  if (room <= 0) return false;
  if (y < number(innerHeight) / 2) return false;
  if (y > room - 80) return false;

  const moved = y - number(lastY);
  if (moved > A_DIRECTION) return true;
  if (moved < -A_DIRECTION) return false;
  /* Too small to mean anything: leave it as it was, rather than flickering
     the bar in and out on the movement of somebody's hand. */
  return Boolean(hidden);
}
