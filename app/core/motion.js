/**
 * One motion scale, shared by the stylesheet and the code that drives it.
 *
 * Durations had accumulated one at a time: nine of them, close enough to look
 * deliberate and different enough not to be. Worse, the JavaScript that ends
 * an animation kept its own copy of the number — a settle transition of 190ms
 * cleaned up by a 170ms timeout strips the class while the element is still
 * moving, which reads as a snap at the end of a smooth movement.
 *
 * The stylesheet declares these as custom properties with the same values, and
 * a test fails if the two ever disagree.
 */
export const DURATION = {
  tap: 90,      // a pressed state: as close to instant as is still visible
  quick: 130,   // a crossfade between peers, a colour change
  base: 180,    // the standard movement — forward, back, settle, dismiss
  enter: 230,   // a surface travelling in from an edge, which goes further
};

/** Decelerate for anything arriving or settling; accelerate for leaving. */
export const EASING = {
  out: 'cubic-bezier(.2, 0, 0, 1)',
  in: 'cubic-bezier(.4, 0, 1, 1)',
};
