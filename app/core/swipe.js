/**
 * Turning a page, as a thing that can be run.
 *
 * This lived inside app.js, wired directly to the document, which meant the
 * only way to find out whether a swipe committed was to build an APK and try
 * it on a phone. Two attempts at fixing page turns were made that way, and
 * both were wrong — not because the reasoning was careless but because there
 * was no way to check it.
 *
 * Everything the gesture touches is passed in, so a test can hand it a fake
 * surface and a fake finger and get a straight answer.
 */

import { axisOf, travel, commits, inSystemEdge } from './gesture.js';

export function createSwipe(el, {
  onLeft,
  onRight,
  canLeft = () => true,
  canRight = () => true,
  viewportWidth = () => 360,
  scrollsSideways = () => false,
  reduceMotion = () => false,
  onCommit = () => {},
  onReject = () => {},
  duration = { out: 180, in: 230, settle: 180 },
  frame = (fn) => setTimeout(fn, 0),
} = {}) {
  let x0 = 0; let y0 = 0;
  let origin = null;       // what the finger actually landed on
  let tracking = false;    // finger down, axis not yet decided
  let dragging = false;    // committed to the horizontal axis
  let pointerId = null;

  const setX = (px) => el.style.setProperty('--page-x', `${px}px`);
  const settle = (ms) => {
    el.style.setProperty('--page-ms', `${ms}ms`);
    el.classList.add('settling');
  };
  const done = () => {
    el.classList.remove('settling', 'swiping');
    el.style.removeProperty('--page-x');
    el.style.removeProperty('--page-ms');
    tracking = dragging = false;
    pointerId = null;
  };

  function down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // the screen edges belong to the system, not to us
    if (inSystemEdge(e.clientX, viewportWidth())) return;
    if (el.classList.contains('settling')) return;
    origin = e.target ?? el;
    x0 = e.clientX; y0 = e.clientY;
    tracking = true; dragging = false;
    pointerId = e.pointerId;
  }

  function move(e) {
    if (!tracking || e.pointerId !== pointerId) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;

    if (!dragging) {
      const axis = axisOf(dx, dy);
      if (axis === 'vertical') { tracking = false; return; }   // the browser's
      if (axis === 'undecided') return;

      /* A tag row or a shelf under the finger owns the movement — but only
         while it still has somewhere to go that way. This cannot be decided on
         pointerdown, because the direction is not known until the finger has
         moved. */
      if (scrollsSideways(origin, Math.sign(dx))) { tracking = false; return; }

      dragging = true;
      el.classList.add('swiping');
      el.setPointerCapture?.(e.pointerId);
    }

    const blocked = (dx < 0 && !canLeft()) || (dx > 0 && !canRight());
    setX(travel(dx, { blocked }));
  }

  async function up(e) {
    if (!tracking || (pointerId != null && e.pointerId !== pointerId)) return;
    if (!dragging) { done(); return; }

    const dx = e.clientX - x0;
    const forward = dx < 0;
    const allowed = forward ? canLeft() : canRight();
    const width = viewportWidth();
    const committed = commits(dx, width, { allowed });

    if (!committed) {
      // a pull towards a chapter that isn't there: the resistance already said
      // so, and this is the same refusal in another sense
      if (!allowed && commits(dx, width)) onReject();
      settle(duration.settle);         // visibly back where it started
      setX(0);
      setTimeout(done, duration.settle + 10);
      return;
    }

    onCommit();
    const turn = () => (forward ? onLeft() : onRight());

    if (reduceMotion()) {
      done();
      await turn();
      return;
    }

    // carry the page off, swap the content, bring the next one in from the
    // side the finger was heading towards
    settle(duration.out);
    setX(forward ? -width : width);
    await new Promise((r) => setTimeout(r, duration.out));

    el.classList.remove('settling');
    setX(forward ? width : -width);
    await turn();

    frame(() => {
      settle(duration.in);
      setX(0);
      setTimeout(done, duration.in + 10);
    });
  }

  function cancel() {
    if (!dragging) { done(); return; }
    settle(duration.settle);
    setX(0);
    setTimeout(done, duration.settle + 10);
  }

  el.addEventListener('pointerdown', down, { passive: true });
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerup', up, { passive: true });
  el.addEventListener('pointercancel', cancel, { passive: true });

  // handed back so a test can drive them directly, without a DOM
  return { down, move, up, cancel };
}
