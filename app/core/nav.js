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
export class History {
  constructor() { this.entries = []; }

  get depth() { return this.entries.length; }

  /**
   * Leave `from` for `to`.
   *
   * Navigating to the screen already showing is not a movement and must not
   * push an entry, or turning a page in the reader would build a stack of
   * identical frames that Back then has to walk back through one at a time.
   */
  go(from, to) {
    if (!from || from.screen === to) return false;
    this.entries.push(from);
    return true;
  }

  /** The place to restore, or null when there is nowhere left to go back to. */
  back() {
    return this.entries.pop() ?? null;
  }

  /**
   * A tab is a new top-level branch: Back from one leaves the app rather than
   * retracing the branch the reader has just left.
   */
  reset() { this.entries = []; }
}
