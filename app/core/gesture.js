/**
 * The rules a page-turn follows, kept apart from the surface it moves.
 *
 * These are the decisions that make a swipe feel right or wrong — when a
 * gesture stops being a scroll and becomes a page turn, how far a pull towards
 * a chapter that isn't there should move, how much travel counts as commitment.
 * They are arithmetic, so they are tested as arithmetic rather than only
 * through a device.
 */

/** Travel before a gesture commits to an axis. Below this it is a still finger. */
export const DECIDE = 8;

/** How much of a pull past the last chapter actually shows. */
export const RESIST = 0.28;

/** The screen edges belong to Android's own back gesture. */
export const EDGE = 24;

/**
 * Which way a gesture is going, once it has gone far enough to say.
 *
 * A scroll and a page turn begin identically. Whichever axis wins first takes
 * the gesture; vertical hands it straight back to the browser, because a
 * reader scrolling down a chapter must never have the page slide sideways
 * under their thumb.
 */
export function axisOf(dx, dy, threshold = DECIDE) {
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > threshold) return 'vertical';
  if (Math.abs(dx) >= threshold) return 'horizontal';
  return 'undecided';
}

/**
 * How far the page actually moves for a given pull.
 *
 * Pulling towards a chapter that does not exist still moves the page, but only
 * a little: enough to say the gesture was understood and refused. A surface
 * that does not move at all cannot say that.
 */
export function travel(dx, { blocked = false, resist = RESIST } = {}) {
  return blocked ? dx * resist : dx;
}

/** A quarter of the screen, but never so far that a small phone cannot finish. */
export function commitDistance(width, { fraction = 0.25, cap = 110 } = {}) {
  return Math.min(width * fraction, cap);
}

/**
 * Whether releasing here turns the page.
 *
 * A gesture towards a chapter that isn't there never commits, however far it
 * travelled — the resistance already said so while the finger was down.
 */
export function commits(dx, width, { allowed = true } = {}) {
  return allowed && Math.abs(dx) >= commitDistance(width);
}

/** True where the gesture must be left to the system. */
export function inSystemEdge(x, width, edge = EDGE) {
  return x <= edge || x >= width - edge;
}

/**
 * Whether a surface pans horizontally under its own power.
 *
 * A tag row and a shelf of cards both scroll sideways, and a finger landing on
 * one is asking for that scroll, not for a page turn. The work page is largely
 * made of such rows, which is why swiping it so often appeared to do nothing:
 * whichever surface the finger landed on had already claimed the movement.
 *
 * The few pixels of slack matter — a row one pixel wider than its box through
 * rounding is not a scroller, and treating it as one would silently disable
 * the gesture across most of the page.
 */
export function ownsHorizontal({ scrollWidth = 0, clientWidth = 0, overflowX = 'visible' } = {}, slack = 4) {
  if (scrollWidth <= clientWidth + slack) return false;
  return overflowX === 'auto' || overflowX === 'scroll';
}

/**
 * Whether letting go here should dismiss a sheet.
 *
 * Asymmetric on purpose: a sheet is dragged down to dismiss, and an upward
 * drag is someone reaching for content further up it, never a dismissal.
 * Judged against the sheet's own height so a tall sheet is not dismissed by
 * the small movement that would be most of a short one.
 */
export function dismisses(dy, height, { fraction = 0.28, min = 72, velocity = 0 } = {}) {
  if (dy <= 0) return false;
  // a decisive flick counts even when it did not travel far
  if (velocity > 0.75) return true;
  return dy >= Math.max(min, height * fraction);
}
