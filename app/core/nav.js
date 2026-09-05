/**
 * Where the reader has been.
 *
 * The rule this exists to enforce is that an entry describes the place it came
 * *from*. The previous stack held the screen being entered together with the
 * scroll offset of the screen being left — two halves of different places in
 * one record — and since opening a tab empties the stack, opening a work from
 * the library pushed the only entry there was. Going back popped it, found
 * nothing underneath, and fell back to Home: the library became Home, at
 * somebody else's scroll position.
 *
 * Kept free of the DOM so it can be tested as what it is — a stack with rules —
 * rather than only through a browser.
 */
/**
 * Whether two entries describe the same place.
 *
 * The route on its own is not a place. There is one Detail element and one
 * Results element in the page, so "detail" described whichever work had most
 * recently been painted into it — go Work A, author, Work B, then back twice,
 * and the second Back unhid a Detail holding Work B. What makes a place is the
 * route together with what it was asked for.
 */
export function samePlace(a, b) {
  if (!a || !b) return false;
  if (a.route !== b.route) return false;
  const mine = a.params ?? {};
  const theirs = b.params ?? {};
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  for (const key of keys) {
    if (key === 'filters') {
      if (JSON.stringify(mine.filters ?? null) !== JSON.stringify(theirs.filters ?? null)) {
        return false;
      }
      continue;
    }
    if (String(mine[key] ?? '') !== String(theirs[key] ?? '')) return false;
  }
  return true;
}

/* A trail, not a log. Somebody who spends an evening moving between tabs
   should still be able to walk back out of the app, rather than through four
   hundred rooms — and the oldest entry is the one they are least likely to
   want, so that is the end it is trimmed from. */
const DEEPEST = 60;

export class History {
  constructor() { this.entries = []; }

  get depth() { return this.entries.length; }

  /**
   * Leave `from` for `to`.
   *
   * Going to the place already showing is not a movement and must not push an
   * entry, or turning a page in the reader would build a stack of identical
   * frames for Back to walk back through one at a time.
   */
  go(from, to) {
    if (!from || samePlace(from, to)) return false;
    this.entries.push(from);
    if (this.entries.length > DEEPEST) this.entries.shift();
    return true;
  }

  /** The place to restore, or null when there is nowhere left to go back to. */
  back() {
    return this.entries.pop() ?? null;
  }

  /** What is immediately behind, without taking it. */
  peek() {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /**
   * Go up to a place that may or may not be behind you.
   *
   * Back and Up are different questions. Back is where you came from; Up is
   * where this thing belongs — a chapter belongs to its work whether or not
   * the work is what you came from. When the parent is right behind, going up
   * is going back; when it is not, the current place is exchanged for it
   * rather than piled on top, which is what turned Reader and Work into a
   * pair that each led to the other for ever.
   */
  up(from, parent) {
    if (samePlace(this.peek(), parent)) return { popped: this.back(), pushed: false };
    return { popped: null, pushed: false };
  }

  /**
   * Start again with nowhere behind you.
   *
   * Tabs used to do this, on the reasoning that a tab is a new top-level
   * branch. What that meant in the hand was Home, a work, More, Home — and
   * Back closes the app, having thrown away the work being looked at two taps
   * earlier. Pressing a tab is a journey like any other now, and Back
   * retraces it. Nothing in the app resets the trail; this is kept for a
   * genuine fresh start, and tested as the rule it is.
   */
  reset() { this.entries = []; }
}

/**
 * Where a chapter should open.
 *
 * Only ever two answers: where this chapter was left off, or its beginning.
 * Anything else is a bug, and the bug that prompted this returned a third —
 * the offset from the chapter before it, still on screen when the new one was
 * announced.
 *
 * A remembered offset belongs to a chapter, so it counts only when the chapter
 * matches. A reading excursion from a search result leaves no bookmark, so it
 * opens at the beginning like anything else unvisited.
 */
export function openingOffset(positions, workId, chapter, { transient = false } = {}) {
  if (transient) return 0;
  const saved = positions?.[workId];
  if (!saved || saved.chapter !== chapter) return 0;
  const y = Number(saved.y);
  return Number.isFinite(y) && y > 0 ? Math.round(y) : 0;
}
