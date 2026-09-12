/// When a chapter has actually been read to its end.
///
/// Ported from app/core/reading.js, where it was extracted for exactly this
/// reason: it lived inside a reader as three conditions on `window`, which is
/// the one place a test could not reach it, and it was wrong there in a way
/// only a phone could show. It said the end had been reached whenever the foot
/// of the page was on screen, and that is true the instant a chapter opens:
///
///   - a chapter with nothing to scroll is already at its own foot;
///   - a chapter whose layout has not settled reports no scrolling room, so it
///     looks exactly like the one above;
///   - opening a chapter scrolls it to where you left off, which fires the
///     scroll handler with nobody having moved at all.
///
/// A one-chapter work — most of a library — was therefore finished by being
/// opened, and left the Continue reading shelf before it had been read.
library;

/// A chapter's worth of scrolling has to exist before scrolling to the end of
/// it can mean anything. Below this the answer is always no, and Mark finished
/// on the work page is how a short one gets said.
const double needsRoom = 200;

/// Near enough to the foot: the last line of a chapter is rarely flush with
/// the bottom of the screen, and nobody scrolls the final pixel.
const double nearFoot = 120;

/// Far enough from where the chapter opened to be somebody moving rather than
/// the app restoring a position.
const double moved = 40;

double _number(num? value) =>
    value == null || !value.isFinite ? 0 : value.toDouble();

bool reachedTheEnd({
  num? scrollY,
  num? innerHeight,
  num? scrollHeight,
  num? openedAt,
}) {
  final room = _number(scrollHeight) - _number(innerHeight);
  if (room < needsRoom) return false;
  if (_number(scrollY) < room - nearFoot) return false;
  // Opening a chapter is not reading it, however far down it opens.
  if (_number(scrollY) <= _number(openedAt) + moved) return false;
  return true;
}
