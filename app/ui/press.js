/* ------------------------------------------------------ pointer feedback */

/**
 * Acknowledge the finger before anything else happens.
 *
 * A WebView withholds `:active` while it works out whether a touch is the
 * beginning of a scroll, so on the surfaces that matter most — cards on a
 * shelf, rows in the library — the pressed state arrived late or not at all.
 * A tap could look identical to no tap until the next screen rendered, which
 * on a query-backed navigation is long enough to press again.
 *
 * One delegated listener rather than a handler per component: everything
 * tappable is already reachable by selector.
 */
const TAPPABLE = [
  '.work', '.hit', '.card', '.continue-card', '.start-tile', '.work-card', '.tagpill',
  '.chip', '.icon', '.browse-tab', '.filter-btn', '.active-pill', '.close-x', '.sec-head',
  '.show-more', '.opt', '.account-btn', '.chapters-open', '.shelf-head button',
  '.fandom-list button', '#tabs button', '#chapter-list button', '#detail .chapters button',
  '.rowactions button', '.addwork-signin button', '.filter-foot button', 'button.primary',
  '.linkish', 'button.ghost', '.seg button', '#chapnav button', '#chappos', '.archive-act',
  '#to-work', '#on-archive', '#kudos-here', '#bookmark-here', '#comment-here',
  '#reader-more', '.menu-list button',
  '.version-row', '#ab-current', '.job-act',
].join(',');

/* Far enough to be a scroll rather than an unsteady finger. Below this a
   movement is still a tap, which matters on a train. */
const DRAG_SLOP = 10;

let pressed = null;
let pressAt = null;

function releasePress() {
  pressed?.classList.remove('is-pressed');
  pressed?.closest('.rail')?.classList.remove('dragging');
  pressed = null;
  pressAt = null;
}

document.addEventListener('pointerdown', (e) => {
  if (e.button != null && e.button !== 0) return;
  const target = e.target.closest?.(TAPPABLE);
  if (!target || target.disabled) return;
  releasePress();
  pressed = target;
  pressAt = { x: e.clientX, y: e.clientY };
  target.classList.add('is-pressed');
}, { passive: true });

document.addEventListener('pointermove', (e) => {
  if (!pressed || !pressAt) return;
  /* Once the finger is clearly dragging, this is a scroll of the shelf and no
     longer a press of the card it began on. Letting the press persist through
     a drag is what makes a horizontal rail feel as though it might open
     something at any moment. */
  if (Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > DRAG_SLOP) {
    pressed.closest('.rail')?.classList.add('dragging');
    releasePress();
  }
}, { passive: true });

for (const event of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) {
  document.addEventListener(event, releasePress, { passive: true, capture: event === 'scroll' });
}
