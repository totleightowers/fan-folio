/**
 * The reader.
 *
 * Views, one history stack, no framework. State a reader would be annoyed to
 * lose — typography, theme, and where they were in every work — is written to
 * localStorage as it changes: losing your place in a 100,000 word fic is the
 * difference between an app you keep and one you abandon.
 */

import { History, openingOffset } from './core/nav.js';
import { findNewBookmarks, fetchWorks, nextGap, isTransient, retryDelay } from './core/sync/run.js';
import { createQueue } from './core/sync/queue.js';
import { parseListing, signedInUser, parseUserCounts, blurbDate } from './core/ao3/parse.js';
import { languageName } from './core/ao3/markup.js';
import { bookmarks as bookmarksUrl, authorWorks as authorWorksUrl,
  authorBookmarks as authorBookmarksUrl, authorProfile as authorProfileUrl,
  isOrphan, ORIGIN as AO3 } from './core/ao3/urls.js';
import { DURATION } from './core/motion.js';
import { createSwipe } from './core/swipe.js';
import { axisOf, travel, commits, inSystemEdge, ownsHorizontal, dismisses } from './core/gesture.js';
import { exportDatabase, databaseSize, haptic, leaveKudos, bookmarkWork, commentOnWork, openOnArchive, saveStubs, fetchNextImage } from './api.js';
import { api, isNative, nativeStatus, importDatabase, addWork, signIn, signOut, signedIn, saveProgress, markOpened, markBookmarked, reconcileBookmarks, saveMeta, readMeta,
  keepWorking, stopWorking, pendingLink, pendingOpen } from './api.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ------------------------------------------------------------------ state */

const PREFS_KEY = 'archive.prefs';
/* A cache of what the database already knows, so the reader can restore a
   scroll offset without a round trip. The database is the source of truth. */
const POS_KEY = 'archive.positions';
const VIEW_KEY = 'archive.view';

/*
 * Read something back out of the store, in the shape it was asked for.
 *
 * This used to spread whatever it found into an object literal, which is
 * right for the settings — a stored theme laid over the defaults, so a key
 * added in a later version still has a value. Applied to a list it is
 * quietly wrong: spreading an array into an object gives {0:…, 1:…}, which
 * is not an array and not iterable, so the queue threw on the `for…of` that
 * restored it and every job saved when the app closed was lost on the way
 * back in. The fallback says which of the two was meant.
 */
const load = (key, fallback) => {
  const empty = () => (Array.isArray(fallback) ? [...fallback] : { ...fallback });
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (stored == null) return empty();
    if (Array.isArray(fallback)) return Array.isArray(stored) ? stored : empty();
    return { ...fallback, ...stored };
  } catch { return empty(); }            // a corrupt or blocked store must not break reading
};
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

const STORED_PREFS = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { return null; }
})();

/* Mirrors Archive Reader's settings model key for key, so a theme imported
   from its backup lands here unchanged. */
const prefs = load(PREFS_KEY, {
  theme: 'system', bg: '#fbf9f5', fg: '#1b1a17',
  face: 'Georgia', weight: 400, size: 19, lh: 170,
  margin: 20, vmargin: 24, align: 'start',
  haptics: true,
});
/* The full filter set, kept together so it can be sent, saved and shown as one. */
const view = load(VIEW_KEY, {
  sort: 'title', state: 'all',
  include: [], exclude: [], rating: [], author: [],
  complete: '', language: '', wordsMin: '', wordsMax: '',
  chaptersMin: '', chaptersMax: '', updatedAfter: '', updatedBefore: '', crossover: '',
  otp: '',
});
let positions = load(POS_KEY, {});

/* -------------------------------------------------------------- typography */

const SYSTEM_FACES = {
  Georgia: "Georgia, 'Times New Roman', serif",
  System: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  Monospace: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};
const loadedFonts = new Set();

/**
 * Fonts come from Google Fonts, the way AO3 and Archive Reader both do, so any
 * family the reader names is reproducible. Only the font is fetched; every
 * word came from the archive on disk.
 */
function loadGoogleFont(family, weight = 400) {
  if (!family || SYSTEM_FACES[family]) return;
  const key = `${family}:${weight}`;
  if (loadedFonts.has(key)) return;
  loadedFonts.add(key);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family='
    + encodeURIComponent(family).replace(/%20/g, '+') + ':wght@300;400;500;600&display=swap';
  link.onerror = () => loadedFonts.delete(key);      // offline: the fallback stands
  document.head.append(link);
}

/** Perceived lightness of a hex colour, by the usual luminance weights. */
function isDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
}

const faceStack = (family) => SYSTEM_FACES[family] ?? `'${String(family).replace(/'/g, '')}', Georgia, serif`;

/**
 * Is the page dark right now, whatever route it took to get there?
 *
 * The archive's own stylesheet is vendored faithfully and hardcodes colours
 * for a light page — headings at #333, links at #111, panels at #fff. On a
 * dark background that is dark text on dark, which is what made a chapter look
 * blank. The overrides that correct it need one thing to hang off, and
 * "dark" arrives four different ways.
 */
function themeIsDark() {
  if (prefs.theme === 'dark' || prefs.theme === 'black') return true;
  if (prefs.theme === 'sepia') return false;
  if (prefs.theme === 'custom') return isDark(prefs.bg);
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

function applyPrefs() {
  const r = document.documentElement;
  if (prefs.theme === 'system' || prefs.theme === 'custom') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', prefs.theme);
  r.toggleAttribute('data-dark', themeIsDark());

  if (prefs.theme === 'custom') {
    r.style.setProperty('--bg', prefs.bg);
    r.style.setProperty('--fg', prefs.fg);
    r.style.setProperty('--pane', prefs.bg);
    // a custom theme sets no data-theme, so the browser would otherwise paint
    // sliders and selects to the system's taste — which is how a black theme
    // ended up with a white dropdown in it
    const dark = isDark(prefs.bg);
    r.style.setProperty('color-scheme', dark ? 'dark' : 'light');
    // links must stay legible against whatever background was chosen
    r.style.setProperty('--link', dark ? '#7fb2ef' : '#1f5fa9');
  } else {
    for (const v of ['--bg', '--fg', '--pane', 'color-scheme', '--link']) r.style.removeProperty(v);
  }

  loadGoogleFont(prefs.face, prefs.weight);
  r.style.setProperty('--read-face', faceStack(prefs.face));
  r.style.setProperty('--read-size', `${prefs.size}px`);
  r.style.setProperty('--read-lh', String(prefs.lh / 100));
  r.style.setProperty('--read-weight', String(prefs.weight));
  r.style.setProperty('--read-margin', `${prefs.margin}px`);
  r.style.setProperty('--read-vmargin', `${prefs.vmargin}px`);
  r.style.setProperty('--read-align', prefs.align);
  save(PREFS_KEY, prefs);
}

/* ------------------------------------------------------------------ views */

const VIEWS = ['setup', 'home', 'library', 'activity', 'results', 'detail', 'reader', 'settings'];
const stack = new History();

/** Views the tab bar owns; anything deeper hides it and shows Back instead. */
/* Search is an action from wherever you are, not a place to go — the box in
   the top bar already changes what it searches according to the screen. Its
   results are a child of that screen, reached and left like any other. What
   deserved a tab was the thing with no home at all: what the app is doing. */
const TABBED = new Set(['home', 'library', 'activity']);

/** The view currently on screen. */
const showing = () => VIEWS.find((v) => !$(`#${v}`).hidden) ?? 'home';

/**
 * How one screen gives way to another.
 *
 * Screens used to be swapped: everything hidden except the destination, which
 * simply appeared. That is functionally correct and spatially mute — it
 * removes the main cue an app uses to teach where you went and how to get
 * back. Motion here is deliberately small; the goal is continuity, not
 * animation. Reading is left still.
 */
const MOTION = { forward: 'in-forward', back: 'in-back', lateral: 'in-lateral' };

/* A page turn animates its own content, and the swipe that starts a work is
   already carrying the page off. A view transition on top would be two
   animations disagreeing about the same movement. */
let suppressMotion = false;

function show(name, motion = 'none') {
  if (name !== 'reader') keepAwake(false);
  clearBackPreview();
  const entering = $(`#${name}`);
  const changing = entering.hidden;
  for (const v of VIEWS) $(`#${v}`).hidden = v !== name;

  if (changing && !suppressMotion && MOTION[motion]) {
    entering.classList.remove(...Object.values(MOTION));
    // reflow, or re-entering the same view replays nothing at all
    void entering.offsetWidth;
    entering.classList.add(MOTION[motion]);
    entering.addEventListener('animationend',
      () => entering.classList.remove(MOTION[motion]), { once: true });
  }
  $('#back').hidden = stack.depth === 0;
  $('#tabs').hidden = !TABBED.has(name);

  /*
   * Arriving at Home rebuilds it.
   *
   * Views are kept in the DOM rather than torn down, which is what makes
   * going back instant — and what left Home showing whatever it showed when
   * you left it. Only the Home tab button rebuilt it, so reading a work and
   * coming back the way you came showed shelves from before you read it, and
   * the only way to see the change was to leave the app and return.
   *
   * The queries behind it are a handful of indexed reads, and this only fires
   * on actually arriving, not on every redraw.
   */
  if (name === 'home' && changing) refresh({ force: true });
  for (const b of $$('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === (name === 'results' ? 'search' : name));
  }
  paintSearchPlaceholder();
  window.scrollTo(0, 0);
}

/**
 * Where the reader was, recorded so they can be put back there exactly.
 *
 * The stack used to hold the screen being *entered*, along with the scroll
 * offset of the screen being left — two halves of different places in one
 * entry. Since opening a tab empties the stack, opening a work from the
 * library pushed the only entry there was, and going back popped it and found
 * nothing underneath: the library became Home, at somebody else's scroll
 * position. An entry now describes the place it came from, which is the only
 * thing Back ever needs to know.
 */
/**
 * Where the reader is now, described well enough to be built again.
 *
 * The stack used to hold a screen name, and a screen name is not a place:
 * there is one Detail element and one Results element in this page, so
 * "detail" meant whichever work had most recently been painted into it. Go to
 * Work A, then its author, then Work B, and Back twice unhid a Detail holding
 * Work B — the stack had remembered the furniture rather than the room.
 */
function here() {
  const route = showing();
  const params = {};
  if (route === 'detail' && currentWork) params.workId = String(currentWork.work_id);
  if (route === 'reader' && current.workId) {
    params.workId = String(current.workId);
    params.chapter = Number(current.chapter) || 1;
  }
  if (route === 'results') {
    params.query = $('#q').value;
    params.scope = searchInScope;
    if (current.workId && (searchInScope === 'work' || searchInScope === 'text')) {
      params.workId = String(current.workId);
    }
  }
  /* Not a reference: the filters go on changing after this is recorded, and a
     place that changes underneath you is not a place. */
  if (route === 'library') params.filters = JSON.parse(JSON.stringify(view));
  return { route, params, scrollY: window.scrollY, query: $('#q').value };
}

/* True while a place is being built again, so rebuilding it does not look
   like travelling to it. */
let restoring = false;

function go(name, params = {}) {
  if (restoring) return;
  if (!stack.go(here(), { route: name, params })) return;
  show(name, 'forward');
}

/**
 * Build a place again from what was written down about it.
 *
 * Views are kept in the DOM rather than torn down, which is what makes this
 * quick — but the DOM is a cache, not the record. What decides what you see is
 * the entry.
 */
function renderPlace(place, motion = 'back') {
  const p = place.params ?? {};
  restoring = true;
  try {
    if (place.route === 'detail' && p.workId) {
      show('detail', motion);
      openWork(p.workId);
    } else if (place.route === 'reader' && p.workId) {
      show('reader', motion);
      openChapter(p.workId, Number(p.chapter) || 1);
    } else if (place.route === 'results' && p.query) {
      $('#q').value = p.query;
      searchInScope = p.scope || 'text';
      show('results', motion);
      runSearch(p.query);
    } else if (place.route === 'library') {
      if (p.filters) {
        Object.assign(view, p.filters);
        save(VIEW_KEY, view);
        paintActiveFilters();
        $('#sort').value = view.sort;
        offset = 0;
        loadMore(true);
      }
      show('library', motion);
    } else {
      show(place.route, motion);
    }
  } finally {
    restoring = false;
  }

  $('#q').value = place.query ?? '';
  paintSearchPlaceholder();
  requestAnimationFrame(() => window.scrollTo(0, place.scrollY ?? 0));
}

function goBack() {
  const from = stack.back();
  if (!from) return false;
  renderPlace(from, 'back');
  return true;
}

/**
 * Up to the work this chapter belongs to.
 *
 * Back is where you came from; Up is where a thing belongs. Going up used to
 * be an ordinary forward navigation, so it pushed the reader — and Back from
 * the work returned to the reader, which returned to the work, for ever. When
 * the work is right behind, going up is going back. When it is not — the
 * reader was opened straight from a shelf — the reader is exchanged for it
 * rather than piled on top, so Back still leads out of the reading.
 */
function upToWork(workId) {
  if (!workId) return;
  const parent = { route: 'detail', params: { workId: String(workId) } };
  const { popped } = stack.up(here(), parent);
  if (popped) { renderPlace(popped, 'back'); return; }
  restoring = true;
  try {
    show('detail', 'back');
    openWork(workId);
  } finally {
    restoring = false;
  }
}

$('#back').onclick = () => goBack();

/**
 * Previewing where Back is going.
 *
 * From Android 14 the shell reports the back gesture as it happens rather than
 * only when it finishes, so the screen can move with the finger and show that
 * letting go will leave it. Without this the gesture is a binary event and the
 * reader learns nothing until they have already gone.
 *
 * The current screen eases back and away, which is the shape the system uses
 * for the same gesture elsewhere. There is nothing behind it to reveal — the
 * destination is not rendered until the navigation happens — so the preview
 * says "this is leaving" rather than pretending to show what arrives.
 */
window.__onBackStart = () => {
  // nothing to preview when Back will close the app: let the system show that
  if (stack.depth === 0 && !backLeavesTab()) return;
  const view = $(`#${showing()}`);
  view?.classList.add('backing');
};

window.__onBackProgress = (p) => {
  const view = $(`#${showing()}`);
  if (!view?.classList.contains('backing')) return;
  const amount = Math.max(0, Math.min(Number(p) || 0, 1));
  view.style.setProperty('--back', String(amount));
};

window.__onBackCancel = () => {
  const view = $(`#${showing()}`);
  if (!view) return;
  view.classList.add('back-settling');
  view.style.setProperty('--back', '0');
  setTimeout(() => {
    view.classList.remove('backing', 'back-settling');
    view.style.removeProperty('--back');
  }, DURATION.base);
};

/** Whatever happens next, the preview must not be left on screen. */
function clearBackPreview() {
  for (const v of VIEWS) {
    const el = $(`#${v}`);
    el.classList.remove('backing', 'back-settling');
    el.style.removeProperty('--back');
  }
}

/* The shell asks this before it closes the app; true means we handled it. */
/*
 * Back out of a tab goes home, not out of the app.
 *
 * The three tabs are peers, so opening one empties the stack — which left
 * Back with nothing to pop and closed the app instead. That is right on Home,
 * which is where you started; it is not right on Library or Search, where the
 * way you got there was one tap and the way back out was losing the app.
 */
const backLeavesTab = () => TABBED.has(showing()) && showing() !== 'home';

window.__onBack = () => {
  for (const d of $$('dialog[open]')) { closeSheet(d); return true; }
  if (goBack()) return true;
  if (backLeavesTab()) { show('home', 'back'); return true; }
  return false;              // on Home with nothing behind it: leave
};

function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------------------------------------------------------------- helpers */

const fmt = (n) => Number(n || 0).toLocaleString();
const authorsOf = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

/** "3 of 12 read" is more use than a bare percentage when chapters are long. */
function progressOf(w) {
  const total = Number(w.chapter_count) || 0;
  const read = Number(w.chapters_read) || 0;
  if (!total || !read) return null;
  return { read, total, pct: Math.min(100, Math.round((read / total) * 100)) };
}

/* ---------------------------------------------------------------- library */

const FILTER_LABELS = {
  all: 'All', reading: 'Reading', unread: 'Unread', finished: 'Finished',
  later: 'Marked for later', complete: 'Complete', wip: 'WIP', skinned: 'Styled',
};

let offset = 0;
let total = 0;
let loading = false;

/**
 * One work in the library list.
 *
 * Modelled on what a reader actually scans for: the title, who wrote it, which
 * fandom and pairing, then the numbers that decide whether tonight is the
 * night — rating, length, chapters, whether it is finished. The summary comes
 * last and is clamped, because it is the slowest thing to read and the least
 * decisive.
 */
/**
 * One of the sprite's icons, as an element.
 *
 * The markup is ours and static — never author text — so innerHTML is safe
 * here in a way it is not two lines below, where a title goes in by
 * textContent because someone wrote it.
 */
function icon(name, className = 'ic') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  return span.firstChild;
}

/**
 * What a work is, at a glance, on any card that shows it.
 *
 * A rec is a bookmark the reader starred on the archive — 726 of them here,
 * and the strongest signal in the library of what was actually thought good.
 * It was filterable but invisible: nothing on a card said so.
 *
 * "Marked for later" used to wear the same star, which made one symbol mean
 * two unrelated things — something they said good, and something they meant to
 * get to. They are now a star and a bookmark.
 */
function marks(w) {
  const mark = (name, className, label) => {
    const el = icon(name, `ic ic-inline ${className}`);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);   // the only thing that says so aloud
    return el;
  };
  const out = [];
  if (w.rec) out.push(mark('star', 'ic-rec', 'Recommended'));
  if (w.marked_later) out.push(mark('bookmark', 'ic-later', 'Marked for later'));
  return out;
}

/**
 * When a work last changed, and what the archive calls that.
 *
 * One date, three names. The archive stamps a finished work Completed and one
 * still going Updated, and keeps both in the same column — so the word is as
 * much of the answer as the number is. A work that has never been updated
 * falls back to when it was posted, rather than claiming an update that never
 * happened.
 *
 * A work is the same work wherever it is shown, so this is answered once and
 * the rows and the shelf cards both read it. Two renderers working it out
 * separately is how they come to disagree.
 */
function whenOf(w) {
  const date = w.updated ?? w.published;
  if (!date) return null;
  const label = !w.updated ? 'Published' : w.complete ? 'Completed' : 'Updated';
  return { label, date: String(date) };
}

/** The same pair, as elements: a small label and a machine-readable date. */
function whenParts({ label, date }) {
  const name = document.createElement('span');
  name.className = 'when-label';
  name.textContent = label;
  const time = document.createElement('time');
  time.className = 'when-date';
  time.dateTime = date;
  time.textContent = date;
  return [name, time];
}

function workRow(w) {
  const node = document.createElement('div');
  node.className = 'work-card';
  node.style.setProperty('--spine', spineColour(w.fandom || w.title));
  const p = progressOf(w);
  const tags = [w.fandom, w.relationship].filter(Boolean);

  const stats = [
    w.rating,
    `${fmt(w.words)} words`,
    `${w.chapter_count}${w.chapters_planned ? '/' + w.chapters_planned : ''} ch`,
    w.complete ? 'Complete' : 'WIP',
  ].filter(Boolean).join('  ·  ');

  node.innerHTML = `
    <div class="work-when"></div>
    <h3></h3>
    <div class="by"></div>
    <div class="tagrow"></div>
    <div class="statline"></div>
    ${w.summary ? '<p class="sum"></p>' : ''}
    ${p ? `<div class="bar"><div style="width:${p.pct}%"></div></div>
           <div class="progress-note">${p.read} of ${p.total} chapters read</div>` : ''}
    <div class="rowactions">
      <button data-act="open">${p ? 'Continue' : 'Read'}</button>
      <button data-act="details">Details</button>
      <button data-act="ao3">AO3</button>
    </div>`;

  // textContent, never innerHTML: titles, summaries and tags are author-written
  const heading = node.querySelector('h3');
  heading.textContent = w.title ?? '(untitled)';
  heading.prepend(...marks(w));
  /* Known, but not here. Saying so on the row matters more than it looks:
     otherwise a work opens into an empty reader and the reader assumes the app
     has lost it. */
  if (!w.has_text) {
    const ghost = document.createElement('span');
    ghost.className = 'not-held';
    ghost.textContent = 'not downloaded';
    node.querySelector('.statline')?.append(ghost);
  }
  node.querySelector('.by').textContent = 'by ' + (authorsOf(w.authors).join(', ') || 'Anonymous');

  const when = whenOf(w);
  if (when) node.querySelector('.work-when').append(...whenParts(when));
  node.querySelector('.statline').textContent = stats;
  if (w.summary) node.querySelector('.sum').textContent = w.summary;

  const tagrow = node.querySelector('.tagrow');
  for (const t of tags) {
    const pill = document.createElement('button');
    pill.className = 'tagpill';
    pill.textContent = t;
    pill.onclick = (e) => { e.stopPropagation(); openTag(t, null); };
    tagrow.append(pill);
  }

  const act = {
    open: () => openChapter(w.work_id, p ? (w.at_chapter ?? 1) : 1),
    details: () => openWork(w.work_id),
    // the one place the app leaves itself: the work as AO3 has it now
    ao3: () => window.open(`https://archiveofourown.org/works/${w.work_id}`, '_blank', 'noopener'),
  };
  for (const b of node.querySelectorAll('.rowactions button')) {
    b.onclick = (e) => { e.stopPropagation(); act[b.dataset.act](); };
  }
  node.onclick = () => openWork(w.work_id);
  return node;
}

async function loadMore(reset = false) {
  if (loading) return;
  loading = true;
  if (reset) { offset = 0; $('#works').textContent = ''; }
  $('#more').textContent = 'Loading…';
  try {
    const params = filterParams({ limit: '50', offset: String(offset) });
    const { works, total: n } = await api(`/api/works?${params}`);
    total = n;
    const box = $('#works');
    for (const w of works) box.append(workRow(w));
    offset += works.length;
    $('#more').textContent = offset < total
      ? `${fmt(offset)} of ${fmt(total)}`
      : (total ? `${fmt(total)} works` : 'Nothing here yet');
    /* The same number, where it can be read before scrolling rather than
       after: what a filter narrowed to is the first thing worth knowing
       about it, and it was only ever written underneath the results. */
    $('#count').textContent = total
      ? `${fmt(total)} ${total === 1 ? 'work' : 'works'}`
      : '';
    if (!total) {
      box.innerHTML = '<p class="empty">No works match this filter.</p>';
    }
  } catch (e) {
    $('#more').textContent = '';
    $('#count').textContent = '';
    $('#works').innerHTML = '<p class="empty"></p>';
    $('#works .empty').textContent = e.message;
  } finally {
    loading = false;
  }
}

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && offset < total && !loading) loadMore();
}).observe($('#more'));

$('#sort').value = view.sort;
$('#sort').onchange = () => {
  view.sort = $('#sort').value;
  save(VIEW_KEY, view);
  loadMore(true);
};

/* ---------------------------------------------------------------- filters */

/** Lists travel tab-separated: a tab cannot appear in an AO3 tag. */
function filterParams(extra = {}) {
  const p = new URLSearchParams({ sort: view.sort, state: view.state, ...extra });
  for (const key of ['include', 'exclude', 'rating', 'author']) {
    if (view[key]?.length) p.set(key, view[key].join('\t'));
  }
  for (const key of ['complete', 'language', 'wordsMin', 'wordsMax',
                     'chaptersMin', 'chaptersMax',
                     'updatedAfter', 'updatedBefore', 'crossover', 'otp']) {
    if (view[key]) p.set(key, view[key]);
  }
  return p;
}

const activeCount = () =>
  view.include.length + view.exclude.length + view.rating.length + (view.author?.length ?? 0)
  + (view.complete ? 1 : 0) + (view.language ? 1 : 0)
  + (view.wordsMin || view.wordsMax ? 1 : 0)
  + (view.chaptersMin || view.chaptersMax ? 1 : 0)
  + (view.updatedAfter || view.updatedBefore ? 1 : 0)
  + (view.crossover ? 1 : 0) + (view.otp ? 1 : 0)
  + (view.state !== 'all' ? 1 : 0);

/** Tri-state: off → include → exclude → off. */
function cycleTag(name) {
  if (view.include.includes(name)) {
    view.include = view.include.filter((t) => t !== name);
    view.exclude = [...view.exclude, name];
  } else if (view.exclude.includes(name)) {
    view.exclude = view.exclude.filter((t) => t !== name);
  } else {
    view.include = [...view.include, name];
  }
  save(VIEW_KEY, view);
}

/* Reading states, in the order a reader is likely to want them. A rec is a
   starred bookmark — the strongest signal in the library of what was good. */
const STATE_LABELS = {
  all: 'All',
  rec: '\u2605 Recs',
  held: 'Downloaded',
  known: 'Not downloaded',
  reading: 'Reading',
  unread: 'Unread',
  finished: 'Finished',
  later: 'Marked for later',
  bookmarked: 'Bookmarked',
  history: 'In history',
};

const FILTER_SECTIONS = [
  ['fandom', 'Fandoms'], ['relationship', 'Relationships'], ['character', 'Characters'],
  ['freeform', 'Tags'], ['warning', 'Warnings'], ['category', 'Categories'],
];

const WORD_PRESETS = [
  ['', '', 'Any length'], ['', '5000', 'Under 5k'], ['5000', '20000', '5–20k'],
  ['20000', '80000', '20–80k'], ['80000', '', 'Over 80k'],
];

const CHAPTER_PRESETS = [
  ['', '', 'Any'], ['1', '1', 'One-shot'], ['2', '10', '2–10'],
  ['11', '30', '11–30'], ['31', '', 'Over 30'],
];

/* Relative, because "updated since" is the question, and an absolute date
   would go stale the moment it was saved. Worked out when the panel is drawn. */
const SINCE_PRESETS = [
  ['', 'Any time'], ['7', 'Past week'], ['31', 'Past month'],
  ['186', 'Past 6 months'], ['366', 'Past year'],
];

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - Number(n));
  return d.toISOString().slice(0, 10);
};

/* Which sections are open. Remembered, so reopening the panel is not a reset. */
const openSections = new Set(['state']);
const sectionSearch = {};
const SHOW_AT_FIRST = 12;
/* What a facet query returns for browsing. A library names far more tags and
   authors than anyone wants to scroll, so the panel shows the most used and
   the search box reaches the rest. */
const FACET_CAP = 40;

/**
 * The filter panel.
 *
 * Sections collapse. A flat list of every fandom, pairing, character and tag
 * is thousands of chips long and answers no question quickly — so each section
 * shows what is selected in its header, opens on demand, and offers a search
 * box and a "show all" once it has more options than anyone wants to scan.
 *
 * Counts come from /api/facets computed against the filters already applied,
 * so every number is what you would actually get.
 */
/*
 * What a section's search box actually searches.
 *
 * The panel shows the busiest handful of each kind — 40 of 1,534 authors, in
 * my library — and typing used to sift only that handful. So every author and
 * every tag outside the top of the list could not be found at all, and the
 * box quietly returned nothing rather than saying it had not looked. It asks
 * the database now, which is the only thing that can answer.
 */
const facetMatches = new Map();          // kind -> items for the needle in hand
let facetSearchAt = 0;

async function searchFacet(kind, needle) {
  const mine = ++facetSearchAt;
  try {
    const params = filterParams({ kind, q: needle });
    const { items } = await api(`/api/facet-search?${params}`);
    if (mine !== facetSearchAt) return null;      // a later keystroke won
    facetMatches.set(kind, items ?? []);
    return items ?? [];
  } catch {
    return null;
  }
}

async function buildFilterPanel() {
  const body = $('#filter-body');
  if (!body.dataset.painted) body.innerHTML = '<p class="empty">Counting…</p>';

  let facets;
  try { facets = await api(`/api/facets?${filterParams()}`); }
  catch (e) {
    body.innerHTML = '<p class="empty"></p>';
    body.querySelector('.empty').textContent = e.message;
    return;
  }

  body.textContent = '';
  body.dataset.painted = '1';

  const chip = (label, n, state, onclick) => {
    const b = document.createElement('button');
    b.className = `opt ${state}`;
    b.innerHTML = '<span class="l"></span>' + (n == null ? '' : '<span class="n"></span>');
    b.querySelector('.l').textContent = label;
    if (n != null) b.querySelector('.n').textContent = n;
    b.onclick = async () => { onclick(); await refreshAfterFilterChange(); };
    return b;
  };

  /** One collapsible section. `selected` is what its header should advertise. */
  function section(key, title, selected, fill) {
    const el = document.createElement('section');
    el.className = 'filter-section' + (openSections.has(key) ? ' open' : '');
    el.innerHTML = `<button class="sec-head">
        <span class="sec-title"></span>
        <span class="sec-sel"></span>
        <svg class="ic ic-chev sec-chev" aria-hidden="true"><use href="#i-chevron"/></svg>
      </button><div class="sec-body"></div>`;
    el.querySelector('.sec-title').textContent = title;
    const sel = el.querySelector('.sec-sel');
    if (selected.length) {
      // a count beside the name, the way a filter sheet usually reads
      sel.textContent = selected.length === 1 ? selected[0] : `(${selected.length})`;
      sel.classList.add('has');
    }
    el.querySelector('.sec-head').onclick = () => {
      if (openSections.has(key)) openSections.delete(key); else openSections.add(key);
      el.classList.toggle('open');
    };
    fill(el.querySelector('.sec-body'));
    body.append(el);
  }

  /* --- the short sections: every option fits, so none of them collapse --- */

  section('state', 'Reading', view.state === 'all' ? [] : [STATE_LABELS[view.state] ?? view.state], (box) => {
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const [key, label] of Object.entries(STATE_LABELS)) {
      opts.append(chip(label, facets.counts?.[key], view.state === key ? 'on' : '', () => {
        view.state = key; save(VIEW_KEY, view);
      }));
    }
    box.append(opts);
  });

  section('status', 'Status', view.complete ? [view.complete === '1' ? 'Complete' : 'WIP'] : [], (box) => {
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const [value, label] of [['', 'Any'], ['1', 'Complete'], ['0', 'Work in progress']]) {
      opts.append(chip(label, null, view.complete === value ? 'on' : '', () => {
        view.complete = value; save(VIEW_KEY, view);
      }));
    }
    box.append(opts);
  });

  const lengthLabel = WORD_PRESETS.find(([a, b]) => a === view.wordsMin && b === view.wordsMax);
  section('length', 'Length', view.wordsMin || view.wordsMax ? [lengthLabel?.[2] ?? 'custom'] : [], (box) => {
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const [min, max, label] of WORD_PRESETS) {
      const on = view.wordsMin === min && view.wordsMax === max ? 'on' : '';
      opts.append(chip(label, null, on, () => {
        view.wordsMin = min; view.wordsMax = max; save(VIEW_KEY, view);
      }));
    }
    box.append(opts);
  });

  section('chapters', 'Chapters',
    view.chaptersMin || view.chaptersMax
      ? [CHAPTER_PRESETS.find(([a, b]) => a === view.chaptersMin && b === view.chaptersMax)?.[2]
         ?? 'custom'] : [], (box) => {
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const [min, max, label] of CHAPTER_PRESETS) {
      const on = view.chaptersMin === min && view.chaptersMax === max ? 'on' : '';
      opts.append(chip(label, null, on, () => {
        view.chaptersMin = min; view.chaptersMax = max; save(VIEW_KEY, view);
      }));
    }
    box.append(opts);
  });

  /* What the archive calls Date Updated. Relative rather than a pair of dates:
     the question is almost always "anything new", and a date typed in once is
     wrong by the following week. */
  section('updated', 'Updated',
    view.updatedAfter ? [SINCE_PRESETS.find(([d]) => d && daysAgo(d) === view.updatedAfter)?.[1]
                         ?? `since ${view.updatedAfter}`] : [], (box) => {
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const [days, label] of SINCE_PRESETS) {
      const value = days ? daysAgo(days) : '';
      opts.append(chip(label, null, view.updatedAfter === value ? 'on' : '', () => {
        view.updatedAfter = value; save(VIEW_KEY, view);
      }));
    }
    box.append(opts);
  });

  /* A work in more than one fandom. Not something you can assemble out of the
     fandom chips: asking for two fandoms gives works in both, and what you
     wanted was works in either that are also in some second thing. */
  section('crossover', 'Crossovers',
    view.crossover ? [view.crossover === '1' ? 'Crossovers only' : 'No crossovers'] : [], (box) => {
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const [value, label] of [['', 'Any'], ['1', 'Crossovers only'], ['0', 'No crossovers']]) {
      opts.append(chip(label, null, view.crossover === value ? 'on' : '', () => {
        view.crossover = value; save(VIEW_KEY, view);
      }));
    }
    box.append(opts);
  });

  if (facets.tags?.language?.length > 1) {
    section('language', 'Language', view.language ? [languageName(view.language) ?? view.language] : [],
      (box) => {
      const opts = document.createElement('div');
      opts.className = 'opts';
      opts.append(chip('Any', null, view.language ? '' : 'on', () => {
        view.language = ''; save(VIEW_KEY, view);
      }));
      for (const l of facets.tags.language) {
        opts.append(chip(languageName(l.name) ?? l.name, l.n,
          view.language === l.name ? 'on' : '', () => {
            view.language = view.language === l.name ? '' : l.name;
            save(VIEW_KEY, view);
          }));
      }
      box.append(opts);
    });
  }

  if (facets.tags?.rating?.length) {
    section('rating', 'Rating', view.rating, (box) => {
      const opts = document.createElement('div');
      opts.className = 'opts';
      for (const r of facets.tags.rating) {
        opts.append(chip(r.name, r.n, view.rating.includes(r.name) ? 'on' : '', () => {
          view.rating = view.rating.includes(r.name)
            ? view.rating.filter((x) => x !== r.name) : [...view.rating, r.name];
          save(VIEW_KEY, view);
        }));
      }
      box.append(opts);
    });
  }

  /*
   * Authors, which could be applied but never chosen: tapping a name on a work
   * set the filter and the pill for it appeared, and the panel had no section
   * for it at all — so it could be removed and never added.
   */
  if (facets.tags?.author?.length) {
    section('author', 'Authors', view.author ?? [], (box) => {
      const items = facets.tags.author;
      const needle = (sectionSearch.author ?? '').toLowerCase();
      if (items.length > SHOW_AT_FIRST) {
        const find = document.createElement('input');
        find.type = 'search';
        find.className = 'sec-find';
        find.placeholder = 'Search authors…';
        find.value = sectionSearch.author ?? '';
        find.oninput = () => {
          sectionSearch.author = find.value;
          clearTimeout(find.timer);
          // asked of the database, not of the handful on screen
          find.timer = setTimeout(async () => {
            await searchFacet('author', find.value);
            const at = find.selectionStart;
            paint();
            const again = box.querySelector('.sec-find');
            if (again) { again.focus(); again.setSelectionRange(at, at); }
          }, 180);
        };
        box.append(find);
      }
      const opts = document.createElement('div');
      opts.className = 'opts';
      box.append(opts);

      let expanded = box.dataset.expanded === '1';
      function paint() {
        const typed = sectionSearch.author ?? '';
        const list_ = typed ? (facetMatches.get('author') ?? []) : items;
        const shown = expanded ? list_ : list_.slice(0, SHOW_AT_FIRST);
        opts.textContent = '';
        for (const a of shown) {
          opts.append(chip(a.name, a.n, (view.author ?? []).includes(a.name) ? 'on' : '', () => {
            const on = (view.author ?? []).includes(a.name);
            view.author = on ? view.author.filter((x) => x !== a.name)
                             : [...(view.author ?? []), a.name];
            save(VIEW_KEY, view);
          }));
        }
        if (list_.length > shown.length) {
          const more = document.createElement('button');
          more.className = 'show-more';
          more.textContent = `Show ${list_.length}`;
          more.onclick = () => { expanded = true; box.dataset.expanded = '1'; paint(); };
          opts.append(more);
        }
        /* Say what is not on the list rather than implying there is nothing
           more: 40 of 1,534 with a button reading "Show all 40" was a claim
           the panel was in no position to make. */
        const total = facets.authorTotal ?? 0;
        if (!typed && total > items.length) {
          const rest = document.createElement('p');
          rest.className = 'filter-hint';
          rest.textContent = `The ${fmt(items.length)} with the most works, of `
            + `${fmt(total)}. Search to find any of the others.`;
          opts.append(rest);
        }
        if (typed && !list_.length) {
          const none = document.createElement('p');
          none.className = 'filter-hint';
          none.textContent = 'No author matches that.';
          opts.append(none);
        }
      }
      paint();
    });
  }

  /* --- the long ones: searchable, and capped until asked otherwise --- */

  for (const [kind, title] of FILTER_SECTIONS) {
    const items = facets.tags?.[kind] ?? [];
    if (!items.length) continue;
    const chosen = [...view.include, ...view.exclude].filter(
      (t) => items.some((i) => i.name === t));

    section(kind, title, chosen, (box) => {
      const needle = (sectionSearch[kind] ?? '').toLowerCase();
      const matching = needle
        ? items.filter((t) => t.name.toLowerCase().includes(needle))
        : items;

      if (items.length > SHOW_AT_FIRST) {
        const find = document.createElement('input');
        find.type = 'search';
        find.className = 'sec-find';
        find.placeholder = `Search ${title.toLowerCase()}…`;
        find.value = sectionSearch[kind] ?? '';
        // repaint just this section's chips; refetching facets on every
        // keystroke would be a request per letter for no new information
        find.oninput = () => {
          sectionSearch[kind] = find.value;
          clearTimeout(find.timer);
          /* Asked of the database. Sifting the forty on screen meant a tag
             outside the busiest forty simply could not be found. */
          find.timer = setTimeout(async () => {
            await searchFacet(kind, find.value);
            const at = find.selectionStart;
            paintChips();
            const again = box.querySelector('.sec-find');
            if (again) { again.focus(); again.setSelectionRange(at, at); }
          }, 180);
        };
        box.append(find);
      }

      /*
       * Only this pairing.
       *
       * Choosing a relationship gives every work that has it among others,
       * which for a popular pair is most of the fandom. What is usually meant
       * is the works that are about it — so this asks for the ones carrying no
       * other relationship. It appears once there is a pairing to be exact
       * about, because with nothing chosen it would mean works with no
       * relationships at all.
       */
      if (kind === 'relationship' && items.some((t) => view.include.includes(t.name))) {
        const only = document.createElement('div');
        only.className = 'opts sec-toggle';
        only.append(chip('Only this pairing', null, view.otp ? 'on' : '', () => {
          view.otp = view.otp ? '' : '1';
          save(VIEW_KEY, view);
        }));
        box.append(only);
      }

      const opts = document.createElement('div');
      opts.className = 'opts';
      box.append(opts);

      let expanded = box.dataset.expanded === '1';
      function paintChips() {
        const typed = sectionSearch[kind] ?? '';
        const list = typed ? (facetMatches.get(kind) ?? []) : items;
        const shown = expanded ? list : list.slice(0, SHOW_AT_FIRST);
        opts.textContent = '';
        for (const t of shown) {
          const state = view.include.includes(t.name) ? 'in'
            : view.exclude.includes(t.name) ? 'out' : '';
          opts.append(chip(t.name, t.n, state, () => cycleTag(t.name)));
        }
        if (list.length > shown.length) {
          const more = document.createElement('button');
          more.className = 'show-more';
          more.textContent = `Show ${list.length}`;
          more.onclick = () => { expanded = true; box.dataset.expanded = '1'; paintChips(); };
          opts.append(more);
        }
        if (!typed && items.length >= FACET_CAP) {
          const rest = document.createElement('p');
          rest.className = 'filter-hint';
          rest.textContent = 'The most used. Search to find any of the others.';
          opts.append(rest);
        }
        if (!list.length) {
          const none = document.createElement('p');
          none.className = 'filter-hint';
          none.textContent = 'Nothing matches that.';
          opts.append(none);
        }
      }
      paintChips();
      // keep matching visible when the search box is repainted above
      if (needle) box.querySelector('.sec-find')?.setAttribute('value', needle);
    });
  }

  const hint = document.createElement('p');
  hint.className = 'filter-hint';
  hint.textContent = 'Tap once to require a tag, again to exclude it, again to clear.';
  body.append(hint);
}

/** Re-count and repaint after any filter change, keeping the panel open. */
async function refreshAfterFilterChange() {
  const params = filterParams({ limit: '1', offset: '0' });
  try {
    const { total } = await api(`/api/works?${params}`);
    $('#apply-filters').textContent = total
      ? `Apply · ${fmt(total)}` : 'Nothing matches';
    $('#apply-filters').disabled = !total;
  } catch { /* the count is a nicety, not a requirement */ }
  await buildFilterPanelKeepingScroll();
}

let panelScroll = 0;
async function buildFilterPanelKeepingScroll() {
  panelScroll = $('#filter-body').scrollTop;
  await buildFilterPanel();
  $('#filter-body').scrollTop = panelScroll;
}

/** The filters currently in force, each removable in one tap. */
function paintActiveFilters() {
  const box = $('#active');
  box.textContent = '';
  paintAuthorBar();
  const badge = $('#filter-count');
  const n = activeCount();
  badge.hidden = !n;
  badge.textContent = n;

  const pill = (label, cls, remove) => {
    const b = document.createElement('button');
    b.className = `active-pill ${cls}`;
    b.innerHTML = '<span class="l"></span><span class="x">×</span>';
    b.querySelector('.l').textContent = label;
    b.onclick = () => { remove(); save(VIEW_KEY, view); paintActiveFilters(); loadMore(true); };
    box.append(b);
  };

  /* The label the panel uses, not the key it is stored under: the pill said
     "known" while the section that set it said "Not downloaded", so the two
     screens named the same filter differently. */
  if (view.state !== 'all') {
    pill(STATE_LABELS[view.state] ?? view.state, 'state', () => { view.state = 'all'; });
  }
  for (const t of view.include) pill(t, 'in', () => { view.include = view.include.filter((x) => x !== t); });
  for (const t of view.exclude) pill(`not ${t}`, 'out', () => { view.exclude = view.exclude.filter((x) => x !== t); });
  for (const r of view.rating) pill(r, 'in', () => { view.rating = view.rating.filter((x) => x !== r); });
  for (const a of view.author ?? []) {
    pill(`by ${a}`, 'in', () => { view.author = view.author.filter((x) => x !== a); });
  }
  if (view.otp) pill('only this pairing', 'in', () => { view.otp = ''; });
  if (view.crossover) {
    pill(view.crossover === '1' ? 'crossovers' : 'no crossovers', 'in', () => { view.crossover = ''; });
  }
  if (view.updatedAfter) pill(`updated since ${view.updatedAfter}`, 'in', () => { view.updatedAfter = ''; });
  if (view.language) pill(languageName(view.language) ?? view.language, 'in', () => { view.language = ''; });
  if (view.chaptersMin || view.chaptersMax) {
    const label = CHAPTER_PRESETS.find(([a, b]) => a === view.chaptersMin && b === view.chaptersMax)?.[2];
    pill(label ? `${label} chapters` : 'chapters', 'in', () => {
      view.chaptersMin = ''; view.chaptersMax = '';
    });
  }
  if (view.complete) pill(view.complete === '1' ? 'complete' : 'WIP', 'in', () => { view.complete = ''; });
  if (view.wordsMin || view.wordsMax) {
    const label = view.wordsMin && view.wordsMax ? `${fmt(view.wordsMin)}–${fmt(view.wordsMax)} words`
      : view.wordsMin ? `over ${fmt(view.wordsMin)}` : `under ${fmt(view.wordsMax)}`;
    pill(label, 'in', () => { view.wordsMin = ''; view.wordsMax = ''; });
  }
}

$('#open-filters').onclick = async () => {
  $('#filter-body').dataset.painted = '';
  openSheet($('#filters'));
  await refreshAfterFilterChange();
};
$('#apply-filters').onclick = () => {
  closeSheet($('#filters'));
  paintActiveFilters();
  loadMore(true);
};
$('#clear-filters').onclick = async () => {
  /* Every filter the panel can set. Miss one and Clear leaves it on, with the
     count in the header disagreeing with the list underneath it. */
  Object.assign(view, {
    state: 'all', include: [], exclude: [], rating: [], author: [],
    complete: '', language: '', wordsMin: '', wordsMax: '',
    chaptersMin: '', chaptersMax: '', updatedAfter: '', updatedBefore: '', crossover: '', otp: '',
  });
  save(VIEW_KEY, view);
  await refreshAfterFilterChange();
};

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
  '.linkish', '#chapnav button', '#read-now', '#closetypo', '#chappos', '.archive-act',
  '#to-work', '#on-archive', '#kudos-here', '.version-row', '#ab-current', '.job-act',
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

/* ------------------------------------------------------------------ rails */

/**
 * Say when a shelf has more on it.
 *
 * A row that hides its scrollbar and ends flush with the screen edge looks
 * like a row that ends. The fade is only ever applied on a side that actually
 * continues — a permanent one would dim the last card of a shelf that fits,
 * announcing content that is not there.
 */
function markOverflow(rail) {
  const more = rail.scrollWidth - rail.clientWidth;
  if (more <= 4) { rail.dataset.overflow = 'none'; return; }
  const atStart = rail.scrollLeft <= 4;
  const atEnd = rail.scrollLeft >= more - 4;
  rail.dataset.overflow = atStart ? 'end' : atEnd ? 'start' : 'both';
}

/** Watch every rail on screen, and any that appear later. */
function watchRails(root = document) {
  for (const rail of root.querySelectorAll?.('.rail') ?? []) {
    if (!rail.dataset.watched) {
      rail.dataset.watched = '1';
      rail.addEventListener('scroll', () => markOverflow(rail), { passive: true });
    }
    /* Re-measured every time, not only when first seen: a rail is watched the
       moment it exists, which is before its cards are in it. Measuring once
       would decide an empty rail has nothing more on it and never look again. */
    markOverflow(rail);
  }
}

/* Shelves are built after their data arrives, so watching once at startup
   would miss all of them. */
new MutationObserver(() => watchRails()).observe(document.body, { childList: true, subtree: true });
addEventListener('resize', () => onScreenResized(), { passive: true });

/* --------------------------------------------------------------- settings */

/**
 * One place for the things that are not reading.
 *
 * The account button used to live inside the reading-settings dialog, between
 * line spacing and text alignment, which is not where anybody would look for
 * it. Backing up had no home at all — the library is a single file assembled
 * over months and there was no way to get a copy of it off the phone.
 */
/* Asked of the shell rather than written down here: a constant in the page is
   a fourth place to remember, and it drifted five releases behind. */
/**
 * Which version this is, read from a file the build writes.
 *
 * It was asked of the package metadata first, and the package reported 0.1
 * however it was stamped — through a manifest attribute, through aapt2's
 * --version-name, through a generated manifest. This is a file with a version
 * in it, written from the tag on every build, and nothing can override it.
 */
let VERSION = 'development build';
fetch('/version.txt')
  .then((r) => (r.ok ? r.text() : null))
  .then((v) => { if (v?.trim()) VERSION = `v${v.trim()}`; })
  .catch(() => {});

/**
 * A tick where something commits — and nowhere else.
 *
 * Haptics reinforce a commitment that is already visible; they are not the
 * feedback. A buzz over a screen that did not move still feels wrong, so this
 * is used only where the interface has already moved: a page that turned, a
 * page that refused to, a sheet pushed away, a filter applied.
 */
function tick(kind = 'tick') {
  if (prefs.haptics === false) return;
  haptic(kind);
}

async function buildSettings() {
  const facts = $('#library-facts');
  facts.textContent = '';
  const add = (term, value) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = term;
    dd.textContent = value;
    facts.append(dt, dd);
  };

  try {
    const home = await api('/api/home');
    const s = home.stats ?? {};
    add('Works', fmt(s.works ?? 0));
    add('Words', fmt(s.words ?? 0));
    add('Finished', fmt(s.finished ?? 0));
    add('Words read', fmt(s.wordsRead ?? 0));
  } catch (e) {
    add('Library', `could not be read: ${e.message}`);
  }

  const bytes = databaseSize();
  /* A young library is not 0.00 GB. */
  if (bytes) {
    const gb = bytes / 1024 / 1024 / 1024;
    add('Backup size', gb >= 1
      ? `${gb.toFixed(2)} GB`
      : `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`);
  }

  const haptics = $('#haptics');
  haptics.checked = prefs.haptics !== false;
  haptics.onchange = () => {
    prefs.haptics = haptics.checked;
    save(PREFS_KEY, prefs);
    if (haptics.checked) tick('commit');    // show what was just turned on
  };

  $('#version').textContent = `Fan Folio ${VERSION}`;
  paintAccount();
}

/** What the app is doing, and what it has done. */
function buildActivity() {
  paintJobs();
  paintStubs();
}

/**
 * Works read off somebody's index and never fetched.
 *
 * These cost nothing to know about — a listing names a hundred works in one
 * request — and after an import they are most of what a library holds. They
 * were only reachable by opening each author in turn, which is a lot of taps
 * to say something simple.
 */
const STUBS_JOB = { author: 'Your library', part: 'described but not held' };

/* Newest first, because a run this long will not finish in one sitting and
   the recent ones are the likelier want. Capped, because a queue is a list in
   memory and a library can name more works than anyone will sit through —
   pressing the button again picks up whatever the cap left behind. */
const STUBS_AT_ONCE = 2000;

function stubIds(limit = STUBS_AT_ONCE) {
  if (!nativeStatus().hasDatabase) return [];
  try {
    const out = JSON.parse(window.ArchiveNative.query(
      `SELECT work_id FROM works WHERE COALESCE(has_text, 0) = 0
        ORDER BY COALESCE(updated, published) DESC LIMIT ${Number(limit) || STUBS_AT_ONCE}`,
      JSON.stringify([])));
    return (out.rows ?? []).map((r) => String(r.work_id));
  } catch {
    return [];
  }
}

/** How many there are altogether, which is not always how many can be queued. */
function stubTotal() {
  if (!nativeStatus().hasDatabase) return 0;
  try {
    const out = JSON.parse(window.ArchiveNative.query(
      'SELECT count(*) AS n FROM works WHERE COALESCE(has_text, 0) = 0', JSON.stringify([])));
    return Number(out.rows?.[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

function paintStubs() {
  const note = $('#stub-count');
  const button = $('#fetch-stubs');
  if (!note || !button) return;
  if (!isNative) {
    note.textContent = 'Only in the app.';
    button.hidden = true;
    return;
  }
  const total = stubTotal();
  button.hidden = total === 0;
  /* Half a minute between requests is the whole cost of this, so it is said in
     hours rather than left to be discovered. */
  const hours = Math.round((total * 28) / 3600);
  note.textContent = total
    ? `${fmt(total)} work${total === 1 ? '' : 's'} the library knows about but has not `
      + `downloaded — about ${hours} hour${hours === 1 ? '' : 's'} of asking, newest first.`
      + (total > STUBS_AT_ONCE ? ` ${fmt(STUBS_AT_ONCE)} at a time.` : '')
    : 'Everything the library knows about has been downloaded.';
  button.textContent = total > STUBS_AT_ONCE
    ? `Download the next ${fmt(STUBS_AT_ONCE)}` : 'Download them all';
  button.onclick = () => {
    if (!signedIn()) { toast('Sign in to the archive first'); return; }
    // read again rather than reusing the painted list: some may have arrived
    const queued = stubIds();
    if (!queued.length) { paintStubs(); return; }
    jobs.add({ ...STUBS_JOB, workIds: queued });
    toast(`Queued ${fmt(queued.length)} works`);
    paintJobs();
  };
}

$('#open-settings').onclick = () => { go('settings'); buildSettings(); };
$('#open-typo').onclick = () => openSheet($('#typography'));

/* The setup screen has its own import button; this is the same action reached
   from a library that already exists, so it warns rather than simply doing it. */
$('#import-replace').onclick = () => {
  if (!isNative) { toast('Import is only available in the app'); return; }
  importDatabase();
};

$('#backup').onclick = () => {
  const state = $('#backup-state');
  if (!exportDatabase()) { toast('Backing up needs the app'); return; }
  state.hidden = false;
  state.textContent = 'Choose where to put it…';
  $('#backup').classList.add('is-busy');
};

/* The shell tells the page how the copy went; it cannot report from inside the
   file picker, and a backup that silently did nothing is worse than none. */
/* The shell could find nothing able to open a web link, which on a phone with
   a browser means it was not allowed to look. */
window.__noBrowser = () => toast('No browser available to open the archive');

/* A merge that could not finish leaves the library as it was, so this is a
   report rather than a warning about damage. */
window.__importFailed = (why) => toast(`That library could not be merged: ${why}`);

window.__backupDone = () => {
  $('#backup').classList.remove('is-busy');
  const state = $('#backup-state');
  state.hidden = false;
  state.textContent = 'Backed up. Keep it somewhere that is not this phone.';
  toast('Library backed up');
};

window.__backupFailed = () => {
  $('#backup').classList.remove('is-busy');
  const state = $('#backup-state');
  state.hidden = false;
  state.textContent = 'That did not save. There may not be room for it.';
};

/**
 * What can be done to a work on the archive itself.
 *
 * These leave the phone: kudos are permanent, a comment notifies the author,
 * and a bookmark appears on a public profile unless it is marked private. So
 * each one says what it is about to do, and the two that take text ask before
 * sending rather than firing on a tap.
 */
/**
 * Leave kudos, and say what happened.
 *
 * Shared, because kudos belong wherever the reader is when they decide a work
 * deserves them — which is usually somewhere in the middle of it, not back on
 * a page they left an hour ago.
 */
async function giveKudos(workId, button) {
  if (!workId) return;
  button?.classList.add('is-busy');
  try {
    const out = await leaveKudos(workId);
    if (button) button.disabled = true;
    tick('commit');
    toast(out.already ? 'You had already left kudos' : 'Kudos left');
  } catch (e) {
    toast(e.message);
  } finally {
    button?.classList.remove('is-busy');
  }
}

function archiveActions(w) {
  const row = document.createElement('div');
  row.className = 'actions archive-actions';

  const kudos = document.createElement('button');
  const already = Boolean(w.kudos_given);
  kudos.className = 'archive-act';
  kudos.disabled = already;
  kudos.append(icon('star', 'ic ic-inline'), document.createTextNode(already ? 'Kudos left' : 'Kudos'));
  kudos.onclick = async () => {
    await giveKudos(w.work_id, kudos);
    if (kudos.disabled) {
      kudos.textContent = '';
      kudos.append(icon('star', 'ic ic-inline'), document.createTextNode('Kudos left'));
    }
  };

  const bookmark = document.createElement('button');
  bookmark.className = 'archive-act';
  /*
   * Bookmarked is a state, and it was behaving as an instruction.
   *
   * The label changed to say the work was already bookmarked, and pressing it
   * opened the same empty form and posted it down the same make-a-bookmark
   * route — so a word describing how things are was wired to an action that
   * assumed they were not. What the archive did with a second new bookmark for
   * the same work was anybody's guess.
   *
   * Making one is done here. Changing one is done on the archive, which is
   * where the notes and tags being edited actually live.
   */
  const bookmarked = Boolean(w.in_bookmarks);
  bookmark.append(icon('bookmark', 'ic ic-inline'),
    document.createTextNode(bookmarked ? 'Bookmarked · edit' : 'Bookmark'));
  bookmark.title = bookmarked
    ? 'Already bookmarked. Opens the archive, where the bookmark can be changed.'
    : 'Bookmark this on the archive';
  bookmark.onclick = () => {
    if (bookmarked) { openOnArchive(String(w.work_id)); return; }
    $('#bm-notes').value = '';
    $('#bm-tags').value = '';
    $('#bm-private').checked = false;
    $('#bm-rec').checked = false;
    $('#bm-status').hidden = true;
    bookmarkTarget = w;
    openSheet($('#bookmark-dialog'));
  };

  const comment = document.createElement('button');
  comment.className = 'archive-act';
  comment.append(icon('chapters', 'ic ic-inline'), document.createTextNode('Comment'));
  comment.onclick = () => {
    $('#cm-text').value = '';
    $('#cm-status').hidden = true;
    commentTarget = w;
    openSheet($('#comment-dialog'));
  };

  /**
   * Fetch this work again.
   *
   * Some works came in from EPUBs and carry the exporter's marks rather than
   * the archive's — a table of contents counted as a first chapter, an empty
   * last one. Repairing that in the database means guessing at what the
   * archive meant; asking the archive is not a guess.
   *
   * Safe by construction: a replaced chapter is archived before the new one
   * lands, so the copy on screen now is still readable afterwards.
   */
  const refetch = document.createElement('button');
  refetch.className = 'archive-act';
  refetch.append(icon('external', 'ic ic-inline'), document.createTextNode('Fetch again'));
  refetch.onclick = async () => {
    refetch.classList.add('is-busy');
    toast('Fetching from the archive…');
    try {
      const before = w.chapters?.length ?? 0;
      const out = await addWork(String(w.work_id));
      tick('commit');
      /* An author who consolidates forty-four chapters into one has not
         deleted anything, but the shape of the work changes under the reader
         and the place they had kept stops meaning what it did. Said plainly,
         with where the old copy went. */
      toast(before && out.chapters !== before
        ? `Now ${out.chapters} chapter${out.chapters === 1 ? '' : 's'}, was ${before}. `
          + 'The earlier copy is under Earlier versions.'
        : `Updated “${out.title}” — ${out.chapters} chapters`);
      openWork(w.work_id);
    } catch (e) {
      toast(e.message);
    } finally {
      refetch.classList.remove('is-busy');
    }
  };

  const onArchive = document.createElement('button');
  onArchive.className = 'archive-act';
  onArchive.append(icon('external', 'ic ic-inline'), document.createTextNode('On the archive'));
  onArchive.onclick = () => openOnArchive(`/works/${w.work_id}`);

  /* Only when there is something to look at. A control offering nothing is a
     control that teaches you to ignore it. */
  if (w.versions > 0) {
    const earlier = document.createElement('button');
    earlier.className = 'archive-act';
    earlier.append(icon('chapters', 'ic ic-inline'),
      document.createTextNode(`Earlier versions (${w.versions})`));
    earlier.onclick = () => showVersions(w.work_id);
    row.append(kudos, bookmark, comment, onArchive, refetch, earlier);
    return row;
  }

  row.append(kudos, bookmark, comment, onArchive, refetch);
  return row;
}

let bookmarkTarget = null;
let commentTarget = null;

/** Report into the sheet that asked, rather than over the screen behind it. */
function sheetStatus(id, message, ok) {
  const el = $(id);
  el.hidden = false;
  el.className = `addwork-status ${ok ? 'ok' : 'bad'}`;
  el.textContent = message;
}

$('#bm-go').onclick = async () => {
  if (!bookmarkTarget) return;
  const button = $('#bm-go');
  button.disabled = true;
  sheetStatus('#bm-status', 'Sending…', true);
  try {
    await bookmarkWork(bookmarkTarget.work_id, {
      notes: $('#bm-notes').value.trim(),
      tags: $('#bm-tags').value.trim(),
      isPrivate: $('#bm-private').checked,
      rec: $('#bm-rec').checked,
    });
    sheetStatus('#bm-status', 'Bookmarked on the archive', true);
    tick('commit');
    setTimeout(() => { closeSheet($('#bookmark-dialog')); openWork(bookmarkTarget.work_id); }, 800);
  } catch (e) {
    sheetStatus('#bm-status', e.message, false);
  } finally {
    button.disabled = false;
  }
};

$('#cm-go').onclick = async () => {
  if (!commentTarget) return;
  const button = $('#cm-go');
  button.disabled = true;
  sheetStatus('#cm-status', 'Posting…', true);
  try {
    await commentOnWork(commentTarget.work_id, $('#cm-text').value);
    sheetStatus('#cm-status', 'Posted', true);
    tick('commit');
    setTimeout(() => closeSheet($('#comment-dialog')), 800);
  } catch (e) {
    sheetStatus('#cm-status', e.message, false);
  } finally {
    button.disabled = false;
  }
};

/* ---------------------------------------------------------------- versions */

/**
 * Earlier copies of a chapter, and a way to read one.
 *
 * Authors revise, rewrite and occasionally delete. Every chapter replaced
 * since versioning went in has been kept, and none of it was reachable — which
 * makes keeping it a gesture rather than a feature. These are not on the
 * archive any more: this is the only place they exist.
 */
let viewingArchive = false;

async function showVersions(workId) {
  const list = $('#versions-list');
  list.replaceChildren(skeleton('line', 'line', 'line'));
  openSheet($('#versions-dialog'));

  let versions;
  try {
    ({ versions } = await api(`/api/works/${workId}/versions`));
  } catch (e) {
    list.replaceChildren(failure(e.message, () => showVersions(workId)));
    return;
  }

  list.textContent = '';
  if (!versions.length) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = 'Nothing has changed since this work was first kept.';
    list.append(none);
    return;
  }

  /* Grouped by when they were archived: an author who rewrites a work changes
     forty chapters in one afternoon, and forty separate rows say less about
     what happened than one date with forty chapters under it. */
  const byDate = new Map();
  for (const v of versions) {
    const day = String(v.archived_at ?? '').slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(v);
  }

  for (const [day, group] of byDate) {
    const head = document.createElement('h3');
    head.className = 'group';
    head.textContent = `${dateLabel(day)} · ${group.length} chapter${group.length === 1 ? '' : 's'}`;
    list.append(head);

    for (const v of group) {
      const row = document.createElement('button');
      row.className = 'version-row';
      row.innerHTML = '<span class="num"></span><span class="name"></span><span class="len"></span>';
      row.querySelector('.num').textContent = v.number;
      row.querySelector('.name').textContent = v.title || `Chapter ${v.number}`;
      row.querySelector('.len').textContent = v.reason === 'removed'
        ? 'removed' : `${fmt(v.words)}w`;
      row.onclick = () => { closeSheet($('#versions-dialog')); openVersion(workId, v.id); };
      list.append(row);
    }
  }
}

const dateLabel = (day) => {
  if (!day) return 'at some point';
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.valueOf()) ? day
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};

/**
 * Read an archived chapter.
 *
 * Deliberately a dead end: it does not move the reader's place, and the page
 * turns are disabled, because the chapters either side of this one are the
 * current text and stepping from an old copy into a new one without noticing
 * would be worse than not offering it at all.
 */
async function openVersion(workId, versionId) {
  const token = ++pending;
  go('reader');
  $('#workskin').replaceChildren(skeleton('line', 'line', 'line', 'line'));
  $('#reader-head').hidden = true;

  let v;
  try {
    v = await api(`/api/works/${workId}/versions/${versionId}`);
  } catch (e) {
    if (token === pending) $('#workskin').replaceChildren(failure(e.message, () => {}));
    return;
  }
  if (token !== pending) return;

  viewingArchive = true;
  /* An old copy of the text: an offset into it does not point at the same
     words in the copy you have now, so this one never expires. */
  readingIsTransient = true;
  transientForever = true;
  current = { workId, chapter: v.number, count: v.number };

  $('#workskin-css').textContent = v.css || '';
  $('#workskin').innerHTML = `<div class="userstuff">${v.html}</div>`;
  $('#endnotes').hidden = true;

  const banner = $('#archive-banner');
  banner.hidden = false;
  $('#ab-text').textContent =
    `An earlier copy of chapter ${v.number}, kept on ${dateLabel(String(v.archived_at).slice(0, 10))}`;

  $('#prev').disabled = true;
  $('#next').disabled = true;
  const pos = $('#chappos');
  pos.textContent = '';
  pos.append(icon('chapters', 'ic ic-chev'), document.createTextNode(`${v.number} · archived`));

  window.scrollTo(0, 0);
}

/** Leaving the archived copy behind, back to what the work says now. */
function leaveArchive() {
  const workId = current.workId;
  viewingArchive = false;
  $('#archive-banner').hidden = true;
  if (workId) openChapter(workId, current.chapter);
}

$('#ab-current').onclick = leaveArchive;

/* -------------------------------------------------------------------- jobs */

/**
 * Work the app owes the archive, done in the background.
 *
 * Fetching an author's catalogue is hundreds of requests over an hour. It runs
 * while the reader does something else, reports as it goes, and can be
 * stopped or brought forward — which matters because the alternative to
 * showing it is an app that is quietly busy for an hour and never says so.
 */
const JOBS_KEY = 'fanfolio.jobs';

/* The last thing that went wrong in the background, shown in settings. */
let jobError = null;

/*
 * Redraw what the new work has changed, without pulling the rug.
 *
 * Rebuilding the home screen replaces its shelves, which resets where their
 * rails were scrolled to; reloading the library sends its list back to the
 * top. Neither is acceptable underneath somebody who is reading, so a screen
 * being looked at is only rebuilt while it is still at the top, and one that
 * is out of sight is rebuilt freely — it will be right when they return to it.
 *
 * Throttled because a work lands about every half minute and there is nothing
 * to be gained by rebuilding twice for two that arrive together.
 */
const FRESHEN_EVERY_MS = 20000;
let freshenAt = 0;
let freshenTimer = null;

/**
 * Put the screens back in step with the library. One way to do it.
 *
 * There were six of these, written one at a time as each was needed, and no
 * two of them agreed. Three rebuilt the shelves and forgot the tiles above
 * them, so Surprise me and Never opened went stale on some routes and not
 * others. Two reloaded the library list unconditionally and one would not.
 * Every one of them was individually reasonable and together they are why the
 * app behaves differently depending on how you got somewhere.
 *
 *   works  the set of works has changed, so the library list is stale too
 *   force  redraw even a screen being looked at, because what is on it is
 *          now wrong — a filter changed, or a work was just added
 *
 * Without `force` a screen is only rebuilt while it is still at the top or
 * out of sight: replacing shelves resets where their rails were scrolled to,
 * and reloading the list sends it back to its first row, neither of which is
 * worth doing underneath somebody mid-scroll.
 */
async function refresh({ works = false, force = false } = {}) {
  const settled = (view_) => force || $(`#${view_}`).hidden || window.scrollY < 40;
  const painting = [];
  if (settled('home')) painting.push(buildHome(), buildStartHere());
  if (works && settled('library') && !loading) { offset = 0; painting.push(loadMore(true)); }
  await Promise.allSettled(painting);
}

function freshen() {
  freshenAt = Date.now();
  clearTimeout(freshenTimer);
  freshenTimer = null;
  refresh({ works: true });
}

function freshenSoon() {
  if (freshenTimer) return;
  const due = Math.max(0, FRESHEN_EVERY_MS - (Date.now() - freshenAt));
  freshenTimer = setTimeout(freshen, due);
}

const jobs = createQueue({
  runTask: (workId) => paced(() => addWork(String(workId)).catch((e) => {
    if (/answered 429|rate limit|too many requests/i.test(String(e?.message))) slowDown();
    throw e;
  })),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  gap: () => nextGap(),
  shouldRetry: isTransient,
  retryWait: (attempt) => retryDelay(attempt),
  /*
   * What the database still does not hold, asked at the end of a run.
   *
   * A job used to call itself finished because the fetch did not throw, which
   * is a different statement from the work being here — a fetch can end having
   * stored a description and no text. So jobs reported themselves complete
   * while the works they had queued were still stubs. This asks the only
   * question that settles it, and whatever comes back is gone round again.
   */
  verify: async (workIds) => {
    const ids = workIds.map(String);
    const held = heldWithText(ids);
    return ids.filter((id) => !held.has(id));
  },
  onEvent: (e) => {
    if (e.type === 'progress') {
      toast(`${e.job.author} · ${e.job.part}: ${e.job.added} of ${e.job.total}`
        + (e.job.failed ? ` (${e.job.failed} unavailable)` : ''));
      /* A download of an author's catalogue runs for an hour, and the shelves
         it is filling were only redrawn when the whole thing ended — so the
         library grew all afternoon while the home screen said what it had
         said at breakfast. */
      freshenSoon();
    }
    if (e.type === 'finished') {
      toast(`${e.job.author} · ${e.job.part}: finished, ${e.job.added} added`);
      if (e.job.failed && e.job.lastError) {
        jobError = `${e.job.author} · ${e.job.part}: ${e.job.failed} skipped — ${e.job.lastError}`;
      }
      freshen();
    }
    keepQueue();
    sayWhatIsHappening();
    if (!$('#activity').hidden) { paintJobs(); paintStubs(); }
  },
});

/** "just now", "3h ago", "yesterday" — enough to place a finished job. */
function whenShort(at) {
  const mins = Math.max(0, Math.round((Date.now() - Number(at)) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/**
 * Do a finished job over.
 *
 * Whatever it could not get, if the ids are still to hand. Otherwise it is
 * worked out again from what the job was, because a record that cannot be
 * acted on is only half a record.
 */
function runAgain(job) {
  if (job.unfinished && jobs.rerun(job.id)) return;
  if (job.author === STUBS_JOB.author && job.part === STUBS_JOB.part) {
    const queued = stubIds();
    if (!queued.length) { toast('Everything described has been downloaded'); paintStubs(); return; }
    jobs.add({ ...STUBS_JOB, workIds: queued });
    toast(`Queued ${fmt(queued.length)} works`);
    return;
  }
  if (!isNative || !signedIn()) { toast('Sign in to the archive first'); return; }
  const part = job.part === 'bookmarks' ? 'bookmarks' : 'works';
  const id = jobs.add({ author: job.author, part, workIds: [], open: true });
  walkAuthor(job.author, { listing: part, jobId: id })
    .catch(() => {})
    .finally(() => jobs.seal(id));
  toast(`Reading ${job.author}'s ${part} again`);
}

/*
 * What the shell should be telling Android.
 *
 * A download is hours of paced requests and all of it used to stop when the
 * app went away, which the settings screen admitted to rather than fixed.
 * While there is something to do the app says so, with an ongoing notification
 * and a wake lock so the page's own timers keep firing; when there is nothing
 * left it says that too, because a notification that outlives its work is
 * worse than none.
 */
let lastSaid = '';

function sayWhatIsHappening() {
  if (!isNative) return;
  const busy = jobs.list().filter(
    (j) => j.state === 'running' || j.state === 'queued' || j.state === 'listing');
  if (!busy.length) {
    if (lastSaid) { lastSaid = ''; stopWorking(); }
    return;
  }
  const first = busy[0];
  const left = busy.reduce((n, j) => n + Math.max(0, j.total - j.added), 0);
  const said = busy.length === 1
    ? `${first.author} · ${first.part} — ${first.added} of ${first.total || '?'}`
    : `${busy.length} jobs, about ${left} works to go`;
  if (said === lastSaid) return;
  lastSaid = said;
  keepWorking(said);
}

/* The notification's Pause. Everything stops; nothing is thrown away. */
window.__pauseAll = () => {
  for (const job of jobs.list()) {
    if (job.state === 'running' || job.state === 'queued') jobs.pause(job.id);
  }
  keepQueue();
  sayWhatIsHappening();
};

/**
 * A series, put through the queue rather than downloaded on the spot.
 *
 * Sequential is not paced: fetching each work the moment the last one finished
 * walked straight through the rate the rest of the app keeps to. As a job it
 * takes its turns with everything else, and can be watched and paused.
 */
function queueSeries(plan) {
  const ids = (plan.workIds ?? []).map(String);
  const held = heldWithText(ids, { unknownIsHeld: false });
  const missing = ids.filter((id) => !held.has(id));
  if (!missing.length) return false;
  jobs.add({ author: `Series ${plan.seriesId}`, part: 'works', workIds: missing });
  paintJobs();
  return true;
}

function paintJobs() {
  const box = $('#job-list');
  box.textContent = '';
  /* A job that reached the end of its list without getting everything is not
     finished with, whatever its state says. It used to leave the screen the
     moment it stopped — reporting nothing downloaded and then disappearing,
     with no sign that the works were still owed. */
  /* Finished jobs stay on the list. A job that has been and gone is the only
     record of what was asked for, and with nowhere to see it there was no way
     to tell a job that got everything from one that quietly got none of it —
     or to ask for it again. */
  /* What is happening, then what happened. A finished job below the running
     ones is a record; above them it is in the way. */
  const RANK = { running: 0, queued: 1, listing: 1, paused: 2, done: 3, cancelled: 3 };
  const list = jobs.list()
    .map((j, i) => [j, i])
    .sort((a, b) => (RANK[a[0].state] ?? 9) - (RANK[b[0].state] ?? 9) || a[1] - b[1])
    .map(([j]) => j);

  if (jobError) {
    /* Failures from background work belong here, next to the thing that
       failed — not over the library, where the reader is doing something
       else and cannot act on it anyway. */
    const bad = document.createElement('p');
    bad.className = 'job-error';
    bad.textContent = jobError;
    box.append(bad);
  }

  if (!list.length) {
    const idle = document.createElement('p');
    idle.className = 'setting-note';
    idle.textContent = 'Nothing waiting, and nothing has run yet.';
    box.append(idle);
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'job-panel';
  box.append(panel);

  for (const job of list) {
    const row = document.createElement('div');
    row.className = 'job-row';

    const text = document.createElement('div');
    text.className = 'job-text';
    const who = document.createElement('span');
    who.className = 'job-who';
    who.textContent = `${job.author} · ${job.part}`;
    const how = document.createElement('span');
    how.className = 'job-how';
    /* "unavailable" said nothing about what happened or whether it would
       happen again. A work only counts here once retrying has been given up
       on, so what is left is deleted, locked to members, or an archive that
       stayed broken — and the last reason is shown when the job ends. */
    /* Until the index has been read there is no total to count towards, and
       inventing one — "0 of 0", or a number that grows as pages land and makes
       the bar slide backwards — is worse than saying plainly that the list is
       still being read. */
    /*
     * Three separate things, each said or not on its own: how much, what went
     * wrong, and where it stands. They were one chained expression, so making
     * the count read differently for a record with no total silently took the
     * skipped count, the state and the time down with it — a finished job
     * became the words "36 downloaded" and nothing else.
     */
    const counting = job.state === 'listing' && !job.total;
    /* A total lost by the older fault cannot come back, and "36 of 0" reads as
       a job asked for nothing that did thirty-six anyway. */
    const count = counting
      ? (job.part === 'works' ? 'reading their works…' : 'reading their bookmarks…')
      : !job.total && (job.added || job.failed)
      ? `${job.added} downloaded`
      : `${job.added} of ${job.total}${job.open ? '+' : ''}`;

    const trouble = job.retrying ? ' · archive busy, trying again'
      : job.failed ? ` · ${job.failed} skipped` : '';

    const standing = counting ? ''
      : job.state === 'running' ? (job.parallel ? ' · running now' : ' · downloading')
      : job.state === 'paused' ? ' · paused'
      : job.state === 'cancelled' ? ' · stopped'
      : job.state === 'listing' ? ' · still reading the list'
      : job.state === 'done' && job.unfinished ? ` · ${job.unfinished} never arrived`
      : job.state === 'done' ? ` · finished${job.at ? ` ${whenShort(job.at)}` : ''}`
      : job.unfinished ? ` · ${job.unfinished} still to get, will try again`
      : ' · waiting';

    how.textContent = count + trouble + standing;

    /* How far along, as a bar rather than a badge. A pill saying "downloading"
       spends a third of the row restating a word already in the line above it
       and shows nothing about progress; a bar under the text costs two pixels
       of height and answers the actual question at a glance. */
    const track = document.createElement('div');
    track.className = 'job-bar';
    const fill = document.createElement('div');
    if (counting) {
      /* Nothing is known about how far along this is, so the bar says that
         rather than sitting at zero looking stalled. */
      track.classList.add('job-bar-waiting');
    } else {
      fill.style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 0}%`;
      if (job.state !== 'running') fill.classList.add('idle');
    }
    track.append(fill);

    text.append(who, how, track);
    row.append(text);

    const acts = document.createElement('div');
    acts.className = 'job-acts';
    /* Icons, because these repeat on every row: six words per job would make
       each row three times as wide as the thing it describes. Every one keeps
       its name for anything that is not looking at it. */
    const act = (icon_, label, fn, danger = false) => {
      const b = document.createElement('button');
      b.className = `job-act${danger ? ' job-danger' : ''}`;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.append(icon(icon_, 'ic'));
      b.onclick = () => { fn(); paintJobs(); };
      acts.append(b);
    };

    if (job.state === 'running') {
      act('pause', 'Pause', () => jobs.pause(job.id));
      act('stop', 'Stop', () => jobs.stop(job.id));
    } else if (job.state === 'paused') {
      act('play', 'Resume', () => jobs.resume(job.id));
      act('stop', 'Stop', () => jobs.stop(job.id));
    } else if (job.state === 'queued') {
      act('bolt', 'Start now, alongside what is running', () => jobs.startNow(job.id));
      act('prev', 'Move up', () => jobs.moveUp(job.id));
      act('next', 'Move down', () => jobs.moveDown(job.id));
    } else if (job.state === 'done' || job.state === 'cancelled') {
      /*
       * Ask for it again.
       *
       * A finished job has emptied its list, so there is usually nothing left
       * to hand back to the runner — which is not a reason to offer nothing.
       * What the job was is enough to work out how to do it again: an author
       * is walked, and the library's own backlog is read off the database.
       */
      act('play', job.unfinished
        ? `Try the ${job.unfinished} that never arrived again`
        : 'Ask for this again', () => runAgain(job));
    }
    act('trash', 'Delete', () => jobs.remove(job.id), true);
    row.append(acts);
    panel.append(row);
  }
}

/** Whatever was left when the app last closed, minus anything since fetched. */
/*
 * Where the queue lives.
 *
 * It was in web storage, which is where a preference goes. This is not a
 * preference — it is a record of work owed and work done — so it sits beside
 * the works instead: it survives site data being cleared, it travels in a
 * backup, and nothing rebuilds it from a summary on the way back in.
 *
 * Web storage is still read once, so a queue saved by an older version is
 * carried over rather than dropped on the floor.
 */
const QUEUE_KEY = 'queue';

function keepQueue() {
  const list = jobs.save();
  if (isNative && saveMeta(QUEUE_KEY, JSON.stringify(list))) return;
  save(JOBS_KEY, list);            // no library open, or not the app at all
}

function storedQueue() {
  if (isNative) {
    const kept = readMeta(QUEUE_KEY);
    if (kept) {
      try {
        const list = JSON.parse(kept);
        if (Array.isArray(list)) return list;
      } catch { /* unreadable: fall through to what the browser has */ }
    }
  }
  const older = load(JOBS_KEY, []);
  if (older.length && isNative) saveMeta(QUEUE_KEY, JSON.stringify(older));
  return older;
}

function resumeJobs() {
  for (const job of storedQueue()) {
    const ids = (job.workIds ?? []).map(String);
    /*
     * Which of these are actually downloaded — text and all.
     *
     * This asked whether there was a row for the work, and a listing writes a
     * row for every work it names. So every work still queued, which is a
     * stub by definition, looked like one already held: the remaining list
     * emptied on every launch, the job became a record of nothing with a
     * total of zero, and it never ran again. That is the queue disappearing.
     */
    let left = ids;
    try {
      const held = heldWithText(ids, { unknownIsHeld: false });
      left = ids.filter((id) => !held.has(id));
    } catch {
      /* Asking is an optimisation; failing to ask is not a reason to abandon
         somebody's queue. The worst it costs is fetching something twice. */
    }
    /* A job with nothing left is a record of one that finished. It goes back
       on the list so the app can still say what it did, rather than opening
       with Nothing waiting and no account of yesterday. */
    if (!left.length && !job.open) {
      /* A record that says nothing is worse than no record: an earlier
         version did not keep the totals, so those rows come back reading
         0 of 0 and then save their zeros back over what they had done. */
      const says = (Number(job.total) || 0) + (Number(job.added) || 0)
        + (Number(job.failed) || 0);
      if (says > 0) jobs.restore({ ...job, workIds: [] });
      continue;
    }

    const id = jobs.add({
      author: job.author, part: job.part, workIds: left, open: Boolean(job.open),
    });

    /*
     * A job that was still reading an index goes back to reading it, from the
     * page after the last one it finished. Closing the app used to lose the
     * walk entirely: what it had already queued was kept, and the pages it
     * had not reached yet were simply forgotten.
     */
    if (job.open && isNative && signedIn()) {
      walkAuthor(job.author, {
        listing: job.part, jobId: id,
        fromPage: Math.max(1, Number(job.page) || 0),
        knownPages: job.pages ?? null,
      }).catch(() => {}).finally(() => jobs.seal(id));
    } else if (job.open) {
      jobs.seal(id);          // nothing can carry the walk on, so close it
    }
  }
}

/**
 * Collect the pictures a chapter is missing, while it is being read.
 *
 * A work fetched from the archive points at images on other hosts, and nothing
 * was fetching them — so a work that came from an EPUB with its pictures
 * stored lost them the moment it was refetched, and showed a column of empty
 * boxes instead.
 *
 * Fetched as the chapter is looked at rather than in a sweep: only the works
 * actually read cost anything, and the picture arrives in place without the
 * page being rebuilt underneath the reader.
 */
async function collectImages(workId) {
  if (!isNative) return;
  for (let i = 0; i < 60; i++) {
    if (current.workId !== workId) return;        // they have gone elsewhere
    const out = await fetchNextImage(workId);
    if (out.done) return;
    if (out.url && out.sha256) {
      /* Put in place rather than re-rendering: the reader is looking at this
         page, and rebuilding it under them to show a picture is worse than
         the picture arriving. */
      for (const img of $$(`#workskin img[data-remote-src]`)) {
        if (img.dataset.remoteSrc !== out.url) continue;
        img.src = `/img/${out.sha256}`;
        img.removeAttribute('data-remote-src');
        img.classList.remove('ar-missing-image');
        img.removeAttribute('alt');
      }
    }
    // an error is already recorded by the shell as not worth asking for again
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ------------------------------------------------------------------ author */

/**
 * Opening a person queues what they have written and what they kept.
 *
 * No buttons: choosing between "their works" and "their bookmarks" is a
 * decision nobody wants to make on the way to reading something, and the
 * answer is always both. Settings is where a download is stopped.
 *
 * What each person had last time is remembered, so opening them again is not
 * a reason to walk their whole index over. The archive prints the totals on
 * their own page — one request answers "has anything changed", where finding
 * out by walking is a page for every twenty works.
 */
const AUTHORS_KEY = 'fanfolio.authors';
const seenAuthors = load(AUTHORS_KEY, {});

let currentAuthor = null;

/**
 * Opening an author shows the author.
 *
 * It used to also start reading their whole index and downloading everything
 * they had written and everything they had bookmarked — for a prolific person,
 * hours of archive, begun by tapping a name. Looking at somebody is not the
 * same as asking for all of them.
 *
 * The work is still one tap and still both halves, because choosing between
 * their works and their bookmarks is a decision nobody wants to make. It is
 * simply a tap that says so.
 */
function openAuthor(name) {
  currentAuthor = name;
  filterBy('author', name);
  paintAuthorBar();
}

/** What is here of theirs, and the way to go and get the rest. */
function paintAuthorBar() {
  const bar = $('#author-bar');
  if (!bar) return;
  const chosen = view.author ?? [];
  const name = chosen.length === 1 ? chosen[0] : null;
  bar.hidden = !name || !isNative;
  if (bar.hidden) return;

  const note = $('#author-known');
  let held = 0;
  let known = 0;
  try {
    const rows = JSON.parse(window.ArchiveNative.query(
      'SELECT has_text, count(*) AS n FROM works WHERE authors LIKE ? ESCAPE \'\\\' GROUP BY has_text',
      JSON.stringify([`%${JSON.stringify(String(name)).replace(/[\\%_]/g, (c) => `\\${c}`)}%`])));
    for (const r of rows.rows ?? []) {
      if (Number(r.has_text) === 1) held = Number(r.n) || 0;
      else known += Number(r.n) || 0;
    }
  } catch { /* the counts are a courtesy; the button still works */ }

  const seen = seenAuthors[name] ?? {};
  const checked = seen.works?.n != null || seen.bookmarks?.n != null;
  note.textContent = `${fmt(held)} of theirs downloaded`
    + (known ? `, ${fmt(known)} known but not` : '')
    + (checked ? '. Checked before.' : '. Not checked against the archive yet.');

  const button = $('#author-sync');
  button.disabled = false;
  button.textContent = 'Fetch their works and bookmarks';
  button.onclick = () => {
    if (!signedIn()) { toast('Sign in to the archive first'); return; }
    button.disabled = true;
    button.textContent = 'Reading their index…';
    catchUpOn(name);
    toast(`Reading ${name}'s works and bookmarks`);
  };
}

async function catchUpOn(name) {
  /* Orphaning keeps the work and loses the author on purpose: the pseud page
     404s even though the byline still links to it. Queueing a walk here would
     spend a request to be told no, every time one of these is opened. */
  if (isOrphan(name)) {
    jobError = `${name}: this work was orphaned, so there is no author page to read`;
    paintJobs();
    return;
  }

  /*
   * Both jobs go up before anything is asked of the archive.
   *
   * Knowing what is in them takes two paced requests — the profile, then the
   * first page of the index — and a queue that shows nothing until then looks
   * like a tap that did not register, at exactly the moment somebody is
   * watching to see whether it did. They stand there saying they are reading
   * the list, and fill in as it is read.
   */
  const opened = {};
  for (const part of ['works', 'bookmarks']) {
    opened[part] = jobs.add({ author: name, part, workIds: [], open: true });
  }
  const closeAll = () => { for (const id of Object.values(opened)) jobs.seal(id); };

  let counts;
  try {
    counts = parseUserCounts(await archivePage(authorProfileUrl(name)));
  } catch (e) {
    jobError = `${name}: ${e.message}`;
    closeAll();
    return;
  }

  const seen = seenAuthors[name] ?? {};
  for (const part of ['works', 'bookmarks']) {
    if (currentAuthor !== name) { closeAll(); return; }
    const total = counts[part];
    /*
     * A count is a cheap first question and a poor last one.
     *
     * Remembering only how many there were meant an author who deleted one
     * work and posted another still had the number the app remembered, so it
     * concluded nothing had changed and never saw the new one. The same for
     * bookmarks: remove one, add one, same total, invisible.
     *
     * So the count decides whether to walk the whole index, and the first
     * page — one request — decides whether even that is needed, by comparing
     * the newest thing on it with the newest thing last time.
     */
    const before = seen[part];
    const knownCount = typeof before === 'number' ? before : before?.n;
    const knownTop = typeof before === 'number' ? null : before?.top ?? null;
    const unchangedCount = total != null && knownCount === total;

    try {
      const walked = await walkAuthor(name, {
        listing: part, jobId: opened[part],
        stopIfTopIs: unchangedCount ? knownTop : null,
        /* Where an interrupted walk left off, so this one carries on. */
        fromPage: Math.max(1, Number(before?.nextPage) || 1),
        knownPages: before?.pages ?? null,
      });
      /*
       * Only a walk that reached the end may say the listing was checked. An
       * interrupted one records how far it got instead, so opening the author
       * again carries on rather than trusting a fingerprint for pages nobody
       * read.
       */
      seenAuthors[name] = {
        ...(seenAuthors[name] ?? {}),
        [part]: walked?.complete
          ? { n: total, top: walked?.top ?? knownTop ?? null }
          : { n: null, top: null, nextPage: (walked?.reached ?? 0) + 1,
              pages: walked?.pages ?? null },
      };
      save(AUTHORS_KEY, seenAuthors);
    } catch {
      // recorded for settings; the other half still gets its turn
    }
    jobs.seal(opened[part]);
    await wait(nextGap());
  }
}

/**
 * Read one of a person's indexes and queue whatever is missing.
 *
 * Queued as each page lands rather than after the whole walk: an index is read
 * a page at a time with a pause between, so waiting for the end means minutes
 * of an app that looks like it has done nothing.
 */
async function walkAuthor(name, { listing = 'works', jobId = null,
                                  fromPage = 1, knownPages = null,
                                  stopIfTopIs = null } = {}) {
  const url = listing === 'works' ? authorWorksUrl : authorBookmarksUrl;

  const keep = (works) => {
    saveStubs(asStubs(works));
    const missing = needsFetching(works);
    if (!missing.length) return;
    if (jobId === null) jobId = jobs.add({ author: name, part: listing, workIds: missing });
    else jobs.append(jobId, missing);
  };

  try {
    /* Resuming: the total was written down last time, so the first page does
       not have to be read again just to learn it. */
    let pages = knownPages;
    let top = null;
    if (fromPage <= 1 || pages == null) {
      const first = parseListing(await archivePage(url(name, fromPage)));
      pages = first.pagination?.total ?? 1;
      top = first.works?.[0]?.workId != null ? String(first.works[0].workId) : null;
      /* The count said nothing had changed and the newest one agrees, so the
         rest of the index is what it was. One request rather than none, and
         far fewer than walking all of it. */
      if (stopIfTopIs && top && top === stopIfTopIs) return { complete: true, top, pages };
      keep(first.works);
      if (jobId !== null) jobs.note(jobId, { page: fromPage, pages });
      offset = 0;
      await loadMore(true);
    }

    /* A page that will not come after several tries is one page. Carrying on
       collects the rest, and the author's totals are deliberately not recorded
       unless every page was read, so opening them again finishes the job
       rather than believing it is already done. */
    /*
     * Whether the whole index was read, which is not the same as the loop
     * ending. Walking away stopped it and it returned like any other success,
     * so the count and the newest work were written down as current — and the
     * seventy-seven pages nobody had looked at were never asked for again,
     * because next time the fingerprint would match.
     */
    let complete = true;
    let missed = 0;
    let reached = Math.max(1, fromPage);
    for (let page = Math.max(2, fromPage + 1); page <= pages; page++) {
      if (currentAuthor !== name) { complete = false; break; }
      await wait(nextGap());
      try {
        keep(parseListing(await archivePage(url(name, page))).works);
        reached = page;
        if (jobId !== null) jobs.note(jobId, { page, pages });
      } catch (e) {
        complete = false;
        missed++;
        jobError = `${name} · ${listing}: page ${page} of ${pages} — ${e.message}`;
      }
    }
    if (missed) throw new Error(`${missed} of ${pages} pages could not be read`);
    return { complete, top, pages, reached };
  } catch (e) {
    /* Kept for settings. "The archive answered 500" over a shelf is a sentence
       the reader cannot act on while doing something else. */
    jobError = `${name} · ${listing}: ${e.message}`;
    throw e;
  }
}

const asStubs = (works) => works.map((w) => ({
  workId: w.workId,
  title: w.title ?? null,
  authors: JSON.stringify(w.authors ?? []),
  summary: w.summary ?? null,
  rating: w.rating ?? null,
  language: w.language ?? null,
  complete: Boolean(w.complete),
  words: w.words ?? 0,
  chapters: w.chapters ?? 0,
  chaptersPlanned: w.chaptersPlanned ?? null,
  kudos: w.kudos ?? 0,
  bookmarkCount: w.bookmarkCount ?? 0,
  hits: w.hits ?? 0,
  tags: {
    fandom: w.fandoms ?? [], relationship: w.relationships ?? [],
    character: w.characters ?? [], freeform: w.freeform ?? [],
    warning: w.warnings ?? [], category: w.categories ?? [],
  },
}));



/* -------------------------------------------------------------------- sync */

/**
 * Bring the library up to date with the archive, from here.
 *
 * This only ever existed as a script on a laptop, so a bookmark made on the
 * archive stayed invisible until somebody ran a tool and carried a database
 * across. It walks the bookmark pages until they stop saying anything new —
 * they are listed newest first, so that is usually one page — and fetches
 * whatever is missing.
 *
 * Slow on purpose. Everything goes through one pacer, because an app that
 * walks somebody's bookmarks impatiently gets their account limited and they
 * will not know why.
 */
let syncing = false;
let stopRequested = false;

const syncSay = (text) => {
  const el = $('#sync-status');
  el.hidden = false;
  el.textContent = text;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * One page from the archive, asked for again if the archive was the problem.
 *
 * A 5xx here is Cloudflare reporting that the archive's own origin did not
 * answer it, and it is common enough to see on a first request and gone on
 * the next — checked directly: the same address, seconds apart, answered 200
 * and then 525. Treating that as a refusal was costing whole walks. An
 * author with 44 works is three pages, and a listing page that threw took the
 * pages after it with it, so the queue was quietly short by twenty works and
 * nothing said so.
 *
 * A 4xx is the archive answering, and is not asked again.
 */
/*
 * One pace for everything the app asks of the archive.
 *
 * There were five clocks. A walk reading somebody's index, a job downloading
 * works, a bookmark sync, and any job told to start now alongside the others
 * each waited its own half minute — so four things running together made a
 * request every seven seconds while every one of them believed it was making
 * one every twenty-eight. Nothing coordinated them, and the archive sees the
 * total, not the intent.
 *
 * A single request from a work page was never throttled because it is a
 * single request. The headers are identical: both go through the same call,
 * the same proxy and the same handful of browser headers. It was only ever
 * the rate.
 *
 * So: one queue for turns, one memory of when the last request went, and a
 * cool-off that everything honours when the archive says to slow down.
 */
let archiveTurn = Promise.resolve();
let lastArchiveAt = 0;
let coolUntil = 0;

/** The archive asked for room. Everything waits, not just whoever was told. */
function slowDown(ms = 5 * 60_000) {
  coolUntil = Math.max(coolUntil, Date.now() + ms);
}

function paced(run) {
  const turn = archiveTurn;
  let release;
  archiveTurn = new Promise((r) => { release = r; });
  return (async () => {
    await turn;
    const now = Date.now();
    const owed = Math.max(coolUntil - now, nextGap() - (now - lastArchiveAt), 0);
    if (owed > 0) await wait(owed);
    lastArchiveAt = Date.now();
    try {
      return await run();
    } finally {
      release();
    }
  })();
}

async function archivePage(url, { attempts = 4 } = {}) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await wait(retryDelay(attempt));
    try {
      const res = await paced(() => fetch(`/__net/?url=${encodeURIComponent(url)}`));
      const body = await res.text();
      if (res.ok) return body;
      if (res.status === 429) slowDown();
      failure = new Error(`the archive answered ${res.status}`);
    } catch (e) {
      failure = e;
    }
    if (!isTransient(failure.message)) throw failure;
  }
  throw failure;
}

/**
 * Whose bookmarks. Read from the archive rather than asked for.
 *
 * The name was cached and never let go of, which is fine while one person is
 * signed in and wrong the moment that changes: signing out left it, signing in
 * as somebody else did not replace it, and the next sync went looking for the
 * previous account's bookmark pages. Whatever that returned — a stranger's
 * public bookmarks, or nothing, or a confident "up to date" — was not an
 * answer about the person actually signed in.
 *
 * It is still cached, because asking on every sync is a request spent to be
 * told something that rarely changes. It is dropped whenever the account
 * might have.
 */
async function whoAmI() {
  if (prefs.archiveUser) return prefs.archiveUser;
  const name = signedInUser(await archivePage(`${AO3}/`));
  if (!name) throw new Error('the archive did not say who is signed in — sign in again');
  prefs.archiveUser = name;
  save(PREFS_KEY, prefs);
  return name;
}

/** The account may not be the same one. Ask again before trusting the name. */
function forgetArchiveUser() {
  if (!prefs.archiveUser) return;
  delete prefs.archiveUser;
  save(PREFS_KEY, prefs);
}

/**
 * Read the whole bookmark list and make the library agree with it.
 *
 * Checking for new ones reads the newest pages and stops where they stop being
 * new. That is quick and it can only add — removing a bookmark on the archive
 * is the absence of something, and an absence cannot be noticed by looking at
 * what is there. So the local idea of "bookmarked" only ever grew, until the
 * filter meant "has ever been bookmarked" rather than "is".
 *
 * This reads all of it, which is slow enough to be its own deliberate act, and
 * changes only which works are marked. A work you unbookmarked is not a work
 * you asked to lose.
 */
async function reconcileAllBookmarks() {
  if (syncing) return;
  if (!isNative) { toast('Syncing needs the app'); return; }
  if (!signedIn()) { toast('Sign in to the archive first'); return; }

  syncing = true;
  stopRequested = false;
  $('#sync-now').disabled = true;
  $('#sync-all').disabled = true;
  $('#sync-stop').hidden = false;
  syncSay('Asking the archive who you are…');

  try {
    const user = await whoAmI();
    const all = [];
    let pages = null;
    for (let page = 1; page <= 200; page++) {
      if (stopRequested) break;
      const listing = parseListing(await archivePage(bookmarksUrl(user, page)));
      pages = listing.pagination?.total ?? pages;
      for (const w of listing.works) if (w.workId) all.push(String(w.workId));
      syncSay(`Page ${page}${pages ? ` of ${pages}` : ''} — ${all.length} bookmarks read`);
      if (pages && page >= pages) break;
      if (!listing.works.length) break;
    }

    if (stopRequested) {
      /* A partial list would read as "everything else was unbookmarked". */
      syncSay(`Stopped after ${all.length}. Nothing changed — a half-read list `
        + 'cannot say what was removed.');
      return;
    }

    const { kept, dropped } = reconcileBookmarks(all);
    await refresh({ works: true, force: true });
    tick('commit');
    syncSay(`${fmt(kept)} bookmark${kept === 1 ? '' : 's'}`
      + (dropped ? `, ${fmt(dropped)} no longer bookmarked.` : ', nothing removed.')
      + ' Works already downloaded were kept.');
  } catch (e) {
    syncSay(e.message);
  } finally {
    syncing = false;
    $('#sync-now').disabled = false;
    $('#sync-all').disabled = false;
    $('#sync-stop').hidden = true;
  }
}

async function syncBookmarks() {
  if (syncing) return;
  if (!isNative) { toast('Syncing needs the app'); return; }
  if (!signedIn()) { toast('Sign in to the archive first'); return; }

  syncing = true;
  stopRequested = false;
  $('#sync-now').disabled = true;
  $('#sync-stop').hidden = false;
  syncSay('Asking the archive who you are…');

  try {
    const user = await whoAmI();
    /*
     * Where the sync stops walking backwards.
     *
     * It stops at the bookmarks it already has, and it decided that by asking
     * whether there was a row — so a work described by some listing and never
     * downloaded counted as one it had. With thousands of those in a library,
     * the walk stopped at the first one it met and reported itself up to
     * date, leaving every bookmark past that point unseen.
     */
    const known = new Map();
    const isHeld = (id) => {
      const key = String(id);
      if (!known.has(key)) {
        known.set(key, heldWithText([key], { unknownIsHeld: false }).has(key));
      }
      return known.get(key);
    };

    let first = true;
    /* Whether the library already lists it as one of yours, which is what
       says where the new bookmarks stop — not whether its text is here. */
    const bookmarked = new Map();
    const isBookmarked = (id) => {
      const key = String(id);
      if (!bookmarked.has(key)) {
        let yes = false;
        try {
          yes = JSON.parse(window.ArchiveNative.query(
            'SELECT 1 FROM works WHERE work_id = ? AND in_bookmarks = 1',
            JSON.stringify([key]))).rows?.length > 0;
        } catch { yes = false; }
        bookmarked.set(key, yes);
      }
      return bookmarked.get(key);
    };

    const { workIds, seen } = await findNewBookmarks({
      fetchPage: async (page) => {
        if (!first) await wait(nextGap());
        first = false;
        return parseListing(await archivePage(bookmarksUrl(user, page)));
      },
      isHeld,
      isBookmarked,
      shouldStop: () => stopRequested,
      onProgress: ({ page, found }) =>
        syncSay(`Page ${page} — ${found} new bookmark${found === 1 ? '' : 's'} so far`),
    });

    /* Every bookmark the walk saw is one of yours, whether or not its text
       needed fetching. Recording that is the point of a bookmark sync; the
       downloading is a consequence of it. */
    let noted = 0;
    for (const id of seen ?? []) if (markBookmarked(id)) noted += 1;

    if (!workIds.length) {
      syncSay(noted
        ? `Up to date. ${noted} bookmark${noted === 1 ? '' : 's'} checked, all already here.`
        : 'Nothing new. The library already has everything you have bookmarked.');
      await refresh({ works: true, force: true });
      return;
    }

    syncSay(`${workIds.length} to fetch. About ${Math.ceil(workIds.length / 2)} minutes.`);
    const { added, failed } = await fetchWorks({
      workIds,
      fetchWork: (workId) => addWork(String(workId)),
      wait,
      shouldStop: () => stopRequested,
      onProgress: ({ done, total, added: n }) =>
        syncSay(`Fetched ${n} of ${total}${done < total ? '…' : ''}`),
    });

    await refresh({ works: true, force: true });
    tick('commit');
    syncSay(`Added ${added.length}`
      + (failed.length ? `, ${failed.length} could not be fetched.` : '.')
      + (stopRequested ? ' Stopped early.' : ''));
  } catch (e) {
    syncSay(e.message);
  } finally {
    syncing = false;
    $('#sync-now').disabled = false;
    $('#sync-stop').hidden = true;
  }
}

/** One work, straight from the database — cheaper than holding the whole library. */
/**
 * Which of these the app actually has to ask the archive for.
 *
 * "Do we have a row for it" was the wrong question, and it was being asked
 * after the stubs for that very page had just been written — so every work in
 * an index looked like one the app already had. It also meant the 2,753 works
 * described from listings and never downloaded could not be fetched by
 * opening their author, because a description counts as a row.
 *
 * Two things make a work worth a request:
 *
 *   there is no text, only a description of it
 *   the index says it changed after the copy on disk
 *
 * Both are answered from the page that named it and one query against what is
 * already stored, so checking costs nothing. Everything else is left alone,
 * which is the point: an author of ninety works whose ninety are current
 * should cost the pages of their index and not one request more.
 */
function needsFetching(works) {
  const ids = works.map((w) => String(w.workId));
  const known = new Map();
  if (nativeStatus().hasDatabase) {
    for (let i = 0; i < ids.length; i += 400) {
      const block = ids.slice(i, i + 400);
      const marks = block.map(() => '?').join(',');
      try {
        const out = JSON.parse(window.ArchiveNative.query(
          `SELECT work_id, has_text, updated FROM works WHERE work_id IN (${marks})`,
          JSON.stringify(block.map(String))));
        for (const row of out.rows ?? []) known.set(String(row.work_id), row);
      } catch { /* nothing known: everything is asked for, which is safe */ }
    }
  }

  return works.filter((w) => {
    const held = known.get(String(w.workId));
    if (!held) return true;                       // never seen
    if (!held.has_text) return true;              // described, not held
    const listed = blurbDate(w);
    return Boolean(listed && held.updated && listed > held.updated);
  }).map((w) => String(w.workId));
}

/**
 * Which of these are downloaded, text and all.
 *
 * Not "is there a row": a listing writes a row for every work it names, so a
 * row is a description. This asks for the ones that actually have chapters
 * behind them, which is what a job is for.
 */
function heldWithText(ids, { unknownIsHeld = true } = {}) {
  const held = new Set();
  if (!nativeStatus().hasDatabase) return unknownIsHeld ? new Set(ids) : held;
  for (let i = 0; i < ids.length; i += 400) {
    const block = ids.slice(i, i + 400);
    const marks = block.map(() => '?').join(',');
    try {
      const out = JSON.parse(window.ArchiveNative.query(
        `SELECT work_id FROM works WHERE has_text = 1 AND work_id IN (${marks})`,
        JSON.stringify(block.map(String))));
      for (const r of out.rows ?? []) held.add(String(r.work_id));
    } catch {
      /* Which way to lean depends on what the answer is for. Deciding a job
         has finished: treat what cannot be checked as held, or it goes round
         for ever. Deciding what is still owed on the way in: treat it as
         missing, or the queue throws away work it has not done. */
      if (unknownIsHeld) for (const id of block) held.add(String(id));
    }
  }
  return held;
}


$('#sync-now').onclick = syncBookmarks;
$('#sync-all').onclick = reconcileAllBookmarks;
$('#sync-stop').onclick = () => { stopRequested = true; syncSay('Stopping after this one…'); };

/* ------------------------------------------------------------------ sheets */

/**
 * Dialogs that behave like surfaces rather than boxes whose CSS changed.
 *
 * These were `<dialog>` elements opened and closed outright: no entrance, no
 * exit, no way to push one away. A sheet that simply appears reads as a web
 * modal, and one that vanishes gives no sense that it went back where it came
 * from. They rise from the bottom now, can be dragged down to dismiss, and
 * leave the way they arrived.
 *
 * `close()` is immediate and cannot be animated, so the exit is played first
 * and the dialog closed at the end of it.
 */
const SHEET_OUT = DURATION.base;

function sheetHandle(d) {
  if (d.querySelector('.sheet-grab')) return;
  const grab = document.createElement('div');
  grab.className = 'sheet-grab';
  // decoration to a screen reader: the dialog is already dismissible
  grab.setAttribute('aria-hidden', 'true');
  d.prepend(grab);
}

/*
 * Pressing the dimmed part of the screen puts a sheet away.
 *
 * A modal dialog fills the window and paints its backdrop through a
 * pseudo-element, so a press on what looks like the page behind is really a
 * press on the dialog itself — which is why nothing happened. What separates
 * the two is where it landed: outside the box the sheet actually occupies.
 *
 * Measured on pointerdown rather than acted on at click, because a drag that
 * starts inside the sheet and ends outside it is a drag, not a dismissal.
 */
function dismissOnBackdrop(d) {
  if (d.dataset.backdropClose) return;
  d.dataset.backdropClose = '1';
  let startedOutside = false;
  d.addEventListener('pointerdown', (e) => {
    if (e.target !== d) { startedOutside = false; return; }
    const box = d.getBoundingClientRect();
    startedOutside = e.clientX < box.left || e.clientX > box.right
      || e.clientY < box.top || e.clientY > box.bottom;
  });
  d.addEventListener('click', (e) => {
    if (e.target === d && startedOutside) closeSheet(d);
    startedOutside = false;
  });
}

function openSheet(d) {
  if (d.open) return;
  sheetHandle(d);
  dismissOnBackdrop(d);
  d.classList.remove('sheet-out');
  d.showModal();
  d.classList.add('sheet-in');
  d.addEventListener('animationend', () => d.classList.remove('sheet-in'), { once: true });
}

function closeSheet(d) {
  if (!d.open || d.classList.contains('sheet-out')) return;
  if (reduceMotion()) { d.close(); return; }
  d.classList.add('sheet-out');
  setTimeout(() => {
    d.classList.remove('sheet-out');
    d.style.removeProperty('--sheet-y');
    d.close();
  }, SHEET_OUT);
}

/**
 * Drag a sheet down to push it away.
 *
 * Only from the sheet's own furniture — the handle and the heading. Starting
 * anywhere would fight every list inside it: dragging down a chapter list is
 * scrolling it, and a sheet that closes when you scroll is a sheet you cannot
 * use.
 */
function draggableSheet(d) {
  let y0 = 0; let t0 = 0; let dragging = false;

  d.addEventListener('pointerdown', (e) => {
    const onFurniture = e.target.closest('.sheet-grab, h2');
    if (!onFurniture) return;
    y0 = e.clientY; t0 = performance.now(); dragging = true;
    d.classList.add('sheet-dragging');
  }, { passive: true });

  d.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // upward is someone reaching for content, and the sheet stays put
    d.style.setProperty('--sheet-y', `${Math.max(0, e.clientY - y0)}px`);
  }, { passive: true });

  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    d.classList.remove('sheet-dragging');
    const dy = e.clientY - y0;
    const speed = dy / Math.max(1, performance.now() - t0);   // px per ms
    if (dismisses(dy, d.getBoundingClientRect().height, { velocity: speed })) {
      tick('commit');
      closeSheet(d);
    } else {
      d.classList.add('sheet-settling');
      d.style.setProperty('--sheet-y', '0px');
      setTimeout(() => d.classList.remove('sheet-settling'), DURATION.base);
    }
  };
  d.addEventListener('pointerup', release, { passive: true });
  d.addEventListener('pointercancel', release, { passive: true });
}

for (const d of $$('dialog')) draggableSheet(d);

/* ----------------------------------------------------------------- search */

let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  // a keystroke is not a query; 42 million words deserve a moment's patience
  searchTimer = setTimeout(() => (q ? runSearch(q) : leaveSearch()), 250);
});

/**
 * What this search box means, where it is standing.
 *
 * The same box used to run the same query everywhere: every word of every
 * chapter, always. Typing an author into the library returned the fourteen
 * chapters that mention them instead of their works, and typing a phrase you
 * remembered while reading searched the other nine hundred works too. Where
 * the reader is says what they are looking for, so the box asks accordingly.
 */
function searchScope() {
  const here = VIEWS.find((v) => !$(`#${v}`).hidden) ?? searchOrigin;
  if (here === 'reader' || here === 'detail') return currentWork ? 'work' : 'text';
  if (here === 'library') return 'meta';
  if (here === 'home' || here === 'browse') return 'everything';
  return searchInScope;
}

const SCOPE_PLACEHOLDER = {
  everything: 'Search works, tags and text…',
  meta: 'Search this library…',
  text: 'Search every word held…',
  work: 'Search within this work…',
};

/** The scope the current results were fetched in, so leaving one view for the
    results does not silently re-scope the search the reader already ran. */
let searchInScope = 'text';

function paintSearchPlaceholder() {
  $('#q').placeholder = SCOPE_PLACEHOLDER[searchScope()] ?? SCOPE_PLACEHOLDER.text;
}

/**
 * Leave the results, back to wherever searching began.
 *
 * Emptying the box is the same movement as pressing Back: it returns to the
 * place the search was typed from, at the offset it was typed from. This used
 * to clear the stack and go Home, throwing away the reader's filters, their
 * scroll position and their sense of place for the ordinary act of emptying a
 * text field.
 */
let searchOrigin = 'home';

function leaveSearch() {
  if (showing() !== 'results') return;
  if (!goBack()) show(searchOrigin);
}

/* ------------------------------------------------------------------- home */

/**
 * A colour per fandom, so cards on a shelf are distinguishable at a glance.
 * Fic has no cover art; this is the nearest honest equivalent to a spine.
 */
function spineColour(seed) {
  let hash = 0;
  for (const ch of String(seed ?? '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 52%)`;
}

function workCard(w) {
  const card = document.createElement('button');
  card.className = 'card';
  card.style.setProperty('--spine', spineColour(w.fandom || w.title));
  const p = progressOf(w);
  /* A title and an author name are not much to go on when a shelf is mostly
     works you have never opened. The space was already there — the card had a
     gap in the middle of it holding nothing. */
  card.innerHTML = `<div class="card-title"></div><div class="card-by"></div>
    ${w.summary ? '<p class="card-sum"></p>' : ''}
    <div class="card-fandom"></div>
    <div class="card-foot">${fmt(w.words)} words${w.complete ? '' : ' · WIP'}</div>
    <div class="card-when"></div>
    ${p ? `<div class="bar"><div style="width:${p.pct}%"></div></div>` : ''}`;
  const cardTitle = card.querySelector('.card-title');
  cardTitle.textContent = w.title ?? '(untitled)';
  cardTitle.prepend(...marks(w));
  card.querySelector('.card-by').textContent = authorsOf(w.authors)[0] ?? 'Anonymous';
  // author-written, so textContent rather than innerHTML, as everywhere else
  if (w.summary) card.querySelector('.card-sum').textContent = w.summary;
  const cardWhen = whenOf(w);
  if (cardWhen) card.querySelector('.card-when').append(...whenParts(cardWhen));
  card.querySelector('.card-fandom').textContent = w.fandom ?? '';
  /*
   * Tapping a work shows the work.
   *
   * This card used to go straight into the reader when there was progress and
   * to the summary when there was not, so the same tap did two different
   * things depending on whether you had read it — and a different thing again
   * from tapping the same work in the library, which has always shown the
   * summary. Continue and Read are the ways into the reader, and they say so.
   */
  card.onclick = () => openWork(w.work_id);
  return card;
}

const STAT_LABELS = [
  ['works', 'works'], ['words', 'words'], ['finished', 'finished'],
  ['later', 'for later'], ['wordsRead', 'words read'],
];

async function buildHome() {
  let data;
  try {
    data = await api('/api/home');
  } catch (e) {
    // say what actually went wrong; a blank home screen teaches nobody anything
    $('#shelves').innerHTML = '<p class="empty"></p>';
    $('#shelves .empty').textContent = `Home could not load: ${e.message}`;
    toast(e.message);
    return;
  }

  const stats = $('#stats');
  stats.textContent = '';
  for (const [key, label] of STAT_LABELS) {
    const n = data.stats?.[key];
    if (n == null) continue;
    const cell = document.createElement('div');
    cell.className = 'stat';
    // millions of words are easier to read rounded than in full
    const shown = n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : fmt(n);
    cell.innerHTML = '<b></b><span></span>';
    cell.querySelector('b').textContent = shown;
    cell.querySelector('span').textContent = label;
    stats.append(cell);
  }

  const box = $('#shelves');
  box.textContent = '';
  for (const shelf of data.shelves ?? []) {
    const section = document.createElement('section');
    section.className = 'shelf';
    section.innerHTML = '<div class="shelf-head"><h2></h2><button>See all</button></div>'
      + '<div class="rail"></div>';
    section.querySelector('h2').textContent = shelf.title;
    section.querySelector('.shelf-head button').onclick = () => {
      view.state = ['reading', 'later'].includes(shelf.key) ? shelf.key : 'all';
      view.sort = shelf.key === 'added' ? 'added' : shelf.key === 'long' ? 'words'
        : shelf.key === 'short' ? 'shortest' : view.sort;
      save(VIEW_KEY, view);
      $('#sort').value = view.sort;
      paintActiveFilters();
      loadMore(true);
      show('library');
    };
    const rail = section.querySelector('.rail');
    for (const w of shelf.works) rail.append(workCard(w));
    box.append(section);
  }

  buildBrowse(data.browse ?? {});
}

const BROWSE_TABS = [
  ['fandom', 'Fandoms'], ['relationship', 'Pairings'], ['character', 'Characters'],
  ['freeform', 'Tags'], ['rating', 'Rating'],
];
let browseKind = 'fandom';

/**
 * Ways in that are not a list.
 *
 * Fic is found by fandom and pairing far more often than by title, so those
 * are the front door. Each chip is a filter, not a category page — tapping one
 * lands you in the library already narrowed.
 */
function buildBrowse(browse) {
  const box = $('#fandoms');
  box.textContent = '';
  if (!Object.keys(browse).length) return;

  box.innerHTML = '<h2>Browse</h2><div class="browse-tabs"></div><div class="fandom-list"></div>';
  const tabs = box.querySelector('.browse-tabs');
  const list = box.querySelector('.fandom-list');

  const paint = () => {
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.kind === browseKind);
    list.textContent = '';
    for (const item of browse[browseKind] ?? []) {
      const b = document.createElement('button');
      b.innerHTML = '<span class="name"></span><span class="n"></span>';
      b.querySelector('.name').textContent = item.name;
      b.querySelector('.n').textContent = item.n;
      /* A card's spine is a hash of its fandom, so the same name is the same
         colour wherever it appears. Tinting the fandom chip with it makes the
         row above the shelves a key to them: the blue pill and the blue
         spines are the same thing said twice. Only fandoms — a pairing or a
         rating has no spine of its own to agree with. */
      if (browseKind === 'fandom') {
        b.dataset.spine = '';
        b.style.setProperty('--spine', spineColour(item.name));
      }
      b.onclick = () => openTag(browseKind === 'rating' ? null : item.name,
        browseKind === 'rating' ? item.name : null);
      list.append(b);
    }
  };

  for (const [kind, label] of BROWSE_TABS) {
    if (!browse[kind]?.length) continue;
    const b = document.createElement('button');
    b.className = 'browse-tab';
    b.dataset.kind = kind;
    b.textContent = label;
    b.onclick = () => { browseKind = kind; paint(); };
    tabs.append(b);
  }
  paint();
}

/** Land in the library, already narrowed to one tag. */
/**
 * Show everything that shares this value.
 *
 * A fresh view rather than one more condition on the last one. "All of this
 * author's works" means all of them — narrowing what was already on screen
 * would answer a question nobody asked, and the reader has no way to see what
 * they are still filtered by from a work page.
 *
 * The remembered sort survives, because that is a preference rather than a
 * question.
 */
const FILTERS = {
  tag: (value) => { view.include = [value]; },
  author: (value) => { view.author = [value]; },   // openAuthor adds the archive half
  rating: (value) => { view.rating = [value]; },
  language: (value) => { view.language = value; },
};

function filterBy(kind, value) {
  const apply = FILTERS[kind];
  if (!apply || !value) return;
  // filtering by anything else means we are no longer looking at a person
  if (kind !== 'author') currentAuthor = null;
  Object.assign(view, {
    state: 'all', include: [], exclude: [], rating: [], author: [],
    complete: '', language: '', wordsMin: '', wordsMax: '',
  });
  apply(value);
  save(VIEW_KEY, view);
  paintActiveFilters();
  offset = 0;
  loadMore(true);
  go('library', { filters: JSON.parse(JSON.stringify(view)) });
}

/* Every value on a work page carries what it filters by, so one listener
   serves the tags, the author, the rating and the language alike. */
$('#detail').addEventListener('click', (e) => {
  const pill = e.target.closest?.('[data-filter]');
  if (!pill) return;
  e.preventDefault();
  if (pill.dataset.filter === 'author') openAuthor(pill.dataset.value);
  else filterBy(pill.dataset.filter, pill.dataset.value);
});

function openTag(tag, rating) {
  if (tag && !view.include.includes(tag)) view.include = [...view.include, tag];
  if (rating && !view.rating.includes(rating)) view.rating = [...view.rating, rating];
  save(VIEW_KEY, view);
  paintActiveFilters();
  loadMore(true);
  show('library');
}

async function buildStartHere() {
  const box = $('#starthere');
  box.textContent = '';
  const row = document.createElement('div');
  row.className = 'start-row';

  const pick = document.createElement('button');
  pick.className = 'start-tile';
  pick.innerHTML = '<b>Surprise me</b><span>something you have never opened</span>';
  pick.onclick = async () => {
    try {
      const { work_id: id } = await api('/api/surprise');
      if (id) openWork(id);
      else toast('Nothing unread left');
    } catch { toast('Could not pick a work'); }
  };

  const later = document.createElement('button');
  later.className = 'start-tile';
  later.innerHTML = '<b>Marked for later</b><span>what you meant to get to</span>';
  later.onclick = () => { view.state = 'later'; save(VIEW_KEY, view);
    paintActiveFilters(); loadMore(true); show('library'); };

  const unread = document.createElement('button');
  unread.className = 'start-tile';
  unread.innerHTML = '<b>Never opened</b><span>the ones still waiting</span>';
  unread.onclick = () => { view.state = 'unread'; save(VIEW_KEY, view);
    paintActiveFilters(); loadMore(true); show('library'); };

  row.append(pick, later, unread);
  box.append(row);
}

async function runSearch(q) {
  // remember where searching started, so clearing the box can return there
  const showing = VIEWS.find((v) => !$(`#${v}`).hidden);
  if (showing && showing !== 'results') searchOrigin = showing;
  const scope = searchScope();
  searchInScope = scope;
  const box = $('#results');
  box.innerHTML = '<div class="count">Searching…</div>';
  go('results', { query: q, scope, workId: current.workId ? String(current.workId) : '' });

  const params = new URLSearchParams({ q, scope });
  // searching the library searches *this* library: whatever is already
  // filtered out stays out, which is what makes the box feel like it belongs
  // to the shelf rather than to the whole archive
  if (scope === 'meta') for (const [k, v] of filterParams()) params.set(k, v);
  if (scope === 'work') params.set('workId', currentWork.work_id);

  let data;
  try {
    data = await api(`/api/search?${params}`);
  } catch (e) {
    box.innerHTML = '<p class="empty"></p>';
    box.querySelector('.empty').textContent = e.message;
    return;
  }
  box.textContent = '';
  if (data.error) {
    box.innerHTML = '<p class="empty">Keep typing — that isn\'t a complete search yet.</p>';
    return;
  }

  const works = data.works ?? [];
  const tags = data.tags ?? [];
  const hits = data.hits ?? [];
  const found = works.length + tags.length + hits.length;

  const count = document.createElement('div');
  count.className = 'count';
  count.textContent = found
    ? `${SCOPE_SUMMARY[scope](works.length, tags.length, hits.length)} · ${data.ms}ms`
    : `Nothing found for \u201c${q}\u201d`;
  box.append(count);

  if (!found) {
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = scope === 'meta'
      ? 'No work here matches. Filters are still applied — clearing them widens the search.'
      : 'Try fewer words, or a phrase in "quotes" to match it exactly.';
    box.append(hint);
    if (scope === 'meta' && activeCount()) {
      const wider = document.createElement('button');
      wider.className = 'primary';
      wider.textContent = 'Search everything held instead';
      wider.onclick = () => { searchOrigin = 'results'; searchInScope = 'text'; runSearch(q); };
      box.append(wider);
    }
  }

  if (works.length) {
    box.append(heading(scope === 'meta' ? 'Works' : 'Works held'));
    // library results are rows, as they are on the shelf itself; a discovery
    // search shows cards, because it is offering rather than listing
    if (scope === 'meta') for (const w of works) box.append(workRow(w));
    else {
      const rail = document.createElement('div');
      rail.className = 'rail';
      for (const w of works) rail.append(workCard(w));
      box.append(rail);
    }
  }

  if (tags.length) {
    box.append(heading('Tags'));
    const row = document.createElement('div');
    row.className = 'chips';
    for (const t of tags) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = `${t.name} (${fmt(t.n)})`;
      // a tag is not a result, it is a narrowing: taking it goes to the library
      chip.onclick = () => { $('#q').value = ''; openTag(t.name); };
      row.append(chip);
    }
    box.append(row);
  }

  if (hits.length) {
    box.append(heading(scope === 'work' ? 'In this work' : 'Passages'));
    for (const h of hits) box.append(passage(h));
  }

}

const SCOPE_SUMMARY = {
  everything: (w, t, h) => [w && `${w} works`, t && `${t} tags`, h && `${h} passages`]
    .filter(Boolean).join(' \u00b7 '),
  meta: (w) => `${w} work${w === 1 ? '' : 's'}`,
  text: (w, t, h) => `${h} passage${h === 1 ? '' : 's'}`,
  work: (w, t, h) => `${h} match${h === 1 ? '' : 'es'} in this work`,
};

function heading(text) {
  const h = document.createElement('h3');
  h.className = 'group';
  h.textContent = text;
  return h;
}

function passage(h) {
  const node = document.createElement('div');
  node.className = 'hit';
  node.innerHTML = '<div class="where"></div><div class="snip"></div>';
  node.querySelector('.where').textContent =
    `${h.title} \u2014 ${authorsOf(h.authors)[0] ?? 'Anonymous'} \u00b7 chapter ${h.number}`;
  // the snippet is the one place server HTML is trusted: SQLite built it from
  // <mark> delimiters we chose, over text we stored
  node.querySelector('.snip').innerHTML = h.snippet;
  node.onclick = () => openChapter(h.work_id, h.number, { transient: true });
  return node;
}

/* ----------------------------------------------------------------- detail */

let currentWork = null;

/**
 * A tap is answered before the data is.
 *
 * openWork used to fetch the work, build the whole page, and only then
 * navigate — so the interaction read as tap, nothing, and eventually a new
 * screen. Even when the query is quick, nothing on screen had acknowledged
 * the tap, which on a slower one is long enough to press again.
 *
 * The destination now opens immediately with its shape in place, and the
 * content replaces that shape when it arrives. A failure appears in the
 * destination with a way to try again, rather than leaving the reader on the
 * previous screen wondering whether they missed.
 */
let pending = 0;

function skeleton(...shapes) {
  const box = document.createElement('div');
  box.className = 'skeleton';
  box.setAttribute('aria-hidden', 'true');   // it is scaffolding, not content
  for (const shape of shapes) {
    const bar = document.createElement('div');
    bar.className = `sk sk-${shape}`;
    box.append(bar);
  }
  return box;
}

/** An error where the reader was going, with the way onwards. */
function failure(message, retry) {
  const box = document.createElement('div');
  box.className = 'failure';
  const text = document.createElement('p');
  text.className = 'empty';
  text.textContent = message;
  const again = document.createElement('button');
  again.className = 'primary';
  again.textContent = 'Try again';
  again.onclick = retry;
  box.append(text, again);
  return box;
}

/* ------------------------------------------------------- the work page
 *
 * Built here rather than borrowed from the archive.
 *
 * The archive's own markup lays a work out for a wide page: labels in a
 * left-hand column a quarter of the width, values floated beside them. On a
 * phone that column is most of the screen and the values pile into it. Its
 * stylesheet is vendored to render an author's skin faithfully, which is a
 * different job from laying out our furniture.
 *
 * The rules this page sets, and the rest should follow:
 *   one primary action, filled; everything else outlined or plain text
 *   labels above their content, never beside it
 *   prose in the reading face, chrome in the interface face
 *   tags are chips with the whole width to wrap into
 */

/** A label and the things under it. Nothing is drawn for an empty group. */
function tagGroup(label, names, filter = 'tag') {
  if (!names?.length) return null;
  const section = document.createElement('section');
  section.className = 'tag-group';
  const head = document.createElement('h3');
  head.className = 'group';
  head.textContent = label;
  const chips = document.createElement('div');
  chips.className = 'chip-wrap';
  for (const name of names) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.filter = filter;
    chip.dataset.value = name;
    chip.textContent = name;
    chips.append(chip);
  }
  section.append(head, chips);
  return section;
}

/** The line that decides whether somebody reads a work at all. */
function factsOf(w) {
  const chapters = w.chapters_planned && w.chapters_planned === w.chapter_count
    ? `${w.chapter_count} chapters`
    : `${w.chapter_count}/${w.chapters_planned ?? '?'} chapters`;
  return [
    w.rating,
    `${fmt(w.words)} words`,
    w.chapter_count === 1 ? 'one chapter' : chapters,
    w.complete ? 'Complete' : 'In progress',
  ].filter(Boolean).join(' · ');
}

async function openWork(workId) {
  /* Opening a second work before the first has answered must not let the
     first overwrite the second when it lands. */
  const token = ++pending;
  go('detail', { workId: String(workId) });
  const box = $('#detail');
  box.replaceChildren(skeleton('title', 'line', 'line', 'meta', 'button'));

  let w;
  try {
    w = await api(`/api/works/${workId}`);
  } catch (e) {
    if (token === pending) box.replaceChildren(failure(e.message, () => openWork(workId)));
    return;
  }
  if (token !== pending) return;    // the reader has already gone elsewhere

  currentWork = w;
  // the database is authoritative; the local cache only remembers the exact
  // scroll offset, which is not worth a column of its own
  if (w.at_chapter && (!positions[workId] || positions[workId].chapter !== w.at_chapter)) {
    positions[workId] = { ...(positions[workId] ?? {}), chapter: w.at_chapter, y: 0 };
  }
  box.textContent = '';

  /* The head: what it is, who wrote it, and the line somebody decides on. */
  const head = document.createElement('header');
  head.className = 'work-head';

  const title = document.createElement('h1');
  title.className = 'work-title';
  title.textContent = w.title ?? '(untitled)';
  title.prepend(...marks(w));

  const by = document.createElement('p');
  by.className = 'work-by';
  const authors = authorsOf(w.authors);
  if (authors.length) {
    by.append('by ');
    authors.forEach((name, i) => {
      if (i) by.append(', ');
      const link = document.createElement('button');
      link.className = 'metapill';
      link.dataset.filter = 'author';
      link.dataset.value = name;
      link.textContent = name;
      by.append(link);
    });
  } else {
    by.textContent = 'by Anonymous';
  }

  const facts = document.createElement('p');
  facts.className = 'work-facts';
  facts.textContent = factsOf(w);

  head.append(title, by, facts);
  box.append(head);

  const saved = positions[workId];
  const actions = document.createElement('div');
  actions.className = 'actions';
  const read = document.createElement('button');
  read.className = 'primary';
  read.textContent = saved?.chapter ? `Continue chapter ${saved.chapter}` : 'Read';
  read.onclick = () => openChapter(workId, saved?.chapter ?? 1);
  if (!w.has_text) {
    read.disabled = true;
    read.textContent = 'Fetching…';
  }
  actions.append(read);
  if (saved?.chapter && w.has_text) {
    const restart = document.createElement('button');
    restart.className = 'linkish';
    restart.textContent = 'Start again';
    restart.onclick = () => openChapter(workId, 1);
    actions.append(restart);
  }
  box.append(actions);

  if (w.summary) {
    const summary = document.createElement('div');
    summary.className = 'work-summary';
    for (const para of String(w.summary).split(/\n+/)) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.textContent = para;      // author's words: text, never markup
      summary.append(p);
    }
    box.append(summary);
  }

  box.append(archiveActions(w));

  /* Tags, each group labelled above its own chips rather than beside them.
     A relationship tag can be longer than the screen; given the whole width it
     wraps, and given a quarter of it it does not. */
  const tags = document.createElement('div');
  tags.className = 'work-tags';
  for (const [kind, label] of [
    ['fandom', 'Fandom'], ['relationship', 'Relationships'], ['character', 'Characters'],
    ['category', 'Category'], ['warning', 'Warnings'], ['freeform', 'Tags'],
    ['collection', 'Collections'],
  ]) {
    const group = tagGroup(label, w.tags?.[kind]);
    if (group) tags.append(group);
  }
  if (tags.children.length) box.append(tags);

  /* What the archive says about it, and where it came from. */
  const details = document.createElement('dl');
  details.className = 'work-details';
  const detail = (label, value) => {
    if (value == null || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    details.append(dt, dd);
  };
  detail('Kudos', w.kudos == null ? null : fmt(w.kudos));
  detail('Bookmarks', w.bookmark_count == null ? null : fmt(w.bookmark_count));
  detail('Hits', w.hits == null ? null : fmt(w.hits));
  detail('Language', w.language ? languageName(w.language) : null);
  detail('Published', w.published);
  detail('Updated', w.updated && w.updated !== w.published ? w.updated : null);
  if (details.children.length) {
    /* Every other block on this page announces itself with a small label
       above it. This one never did, so five numbers in a bare grid butted
       straight up against the last row of tag chips and read as something
       the page had forgotten to finish. */
    const head = document.createElement('h3');
    head.className = 'group';
    head.textContent = 'On the archive';
    const section = document.createElement('section');
    section.className = 'work-detail-block';
    section.append(head, details);
    box.append(section);
  }

  /*
   * One control, not a chapter per row.
   *
   * A thirty-one chapter work turned the page into a wall of "Chapter N ·
   * 2,728 words" that buried the summary and the tags. The chapters are
   * navigation, so they live behind the same drawer the reader uses.
   */
  if (w.chapters.length > 1) {
    const open = document.createElement('button');
    open.className = 'chapters-open';
    open.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-chapters"/></svg>'
      + '<span class="label"></span>'
      + '<svg class="ic ic-chev chev" aria-hidden="true"><use href="#i-chevron"/></svg>';
    open.querySelector('.label').textContent =
      `${w.chapters.length} chapters` + (saved?.chapter ? ` · you are on ${saved.chapter}` : '');
    open.onclick = () => showChapterDrawer(workId, saved?.chapter ?? 1);
    box.append(open);
  }

  const hint = document.createElement('p');
  hint.className = 'swipe-hint';
  hint.textContent = 'Swipe left to start reading';
  box.append(hint);

  if (!w.has_text) await fetchOnArrival(workId, token);
}

/**
 * A work opened but not held fetches itself.
 *
 * Navigating to a work is the instruction to have it, the same way choosing
 * this app for a link is. Asking again with a button was a second tap for a
 * decision already made — and the button did exactly what Fetch again does,
 * by the same call.
 *
 * Immediate rather than queued: a queue is for a catalogue running for an
 * hour, and this is one work the reader is looking at now.
 */
async function fetchOnArrival(workId, token) {
  if (!isNative) return;
  try {
    await addWork(String(workId));
    if (token !== pending) return;      // they moved on while it was fetching
    tick('commit');
    openWork(workId);
  } catch (e) {
    if (token !== pending) return;
    const read = $('#detail .actions .primary');
    if (!read) return;
    read.disabled = false;
    read.textContent = 'Try fetching again';
    read.onclick = () => openWork(workId);
    toast(e.message);
  }
}

/* ----------------------------------------------------------------- reader */

let current = { workId: null, chapter: 1, count: 1 };

/*
 * A glance stays a glance; reading becomes reading.
 *
 * Jumping to a passage from a search result should not move the bookmark. You
 * are at chapter eleven, you search for a line, you land in chapter three,
 * you read the paragraph and leave — and you should still be at chapter
 * eleven. That much was right.
 *
 * What was wrong is that the flag was set when the chapter opened and cleared
 * only by opening another one deliberately, so it was a statement about how
 * you arrived rather than about what you did next. Arrive from a search and
 * then read the work for an hour, and nothing was written down all hour.
 *
 * So it expires. Once you have read about a screenful past where you landed,
 * this is not a glance any more and the place starts being kept. Viewing an
 * archived version never expires: that is an older copy of the text, and an
 * offset into it does not mean anything in the copy you have now.
 */
let readingIsTransient = false;
let transientFrom = 0;
let transientForever = false;

async function openChapter(workId, number, { transient = false } = {}) {
  readingIsTransient = transient;
  transientFrom = window.scrollY;
  transientForever = false;
  viewingArchive = false;
  $('#archive-banner').hidden = true;
  const token = ++pending;

  /* Entering the reader is acknowledged before the chapter is read. Turning a
     page is not: the swipe is already carrying the old page off, and a
     skeleton flashing behind it would be noise rather than feedback. */
  const arriving = showing() !== 'reader';
  if (arriving) {
    go('reader', { workId: String(workId), chapter: Number(number) || 1 });
    $('#workskin').replaceChildren(skeleton('line', 'line', 'line', 'line', 'line', 'line'));
    $('#reader-head').hidden = true;
    $('#endnotes').hidden = true;
    $('#chappos').textContent = '…';   // replaced once the chapter count is known
  }

  let w; let ch;
  try {
    w = currentWork?.work_id === workId ? currentWork : await api(`/api/works/${workId}`);
    ch = await api(`/api/works/${workId}/chapters/${number}`);
  } catch (e) {
    if (token !== pending) return;
    $('#workskin').replaceChildren(
      failure(e.message, () => openChapter(workId, number, { transient })));
    return;
  }
  if (token !== pending) return;

  currentWork = w;

  /* A scroll write is queued 400ms after the last scroll and keyed on whatever
     `current` says when it fires. Changing `current` with one still pending
     files the old chapter's offset under the new chapter — which is then
     faithfully restored, landing the reader somewhere arbitrary in a chapter
     they have never seen. The chapter being left has already been recorded. */
  clearTimeout(posTimer);
  current = { workId, chapter: number, count: w.chapter_count };

  // the skin is already scoped to #workskin; this element holds one work's CSS,
  // replaced wholesale on every navigation
  $('#workskin-css').textContent = ch.css || '';
  $('#workskin').innerHTML = `<div class="userstuff">${ch.html}</div>`;

  const notes = $('#endnotes');
  if (number >= w.chapter_count && w.end_notes_html) {
    notes.hidden = false;
    notes.innerHTML = '<h4>Notes</h4>';
    const body = document.createElement('div');
    body.innerHTML = w.end_notes_html;
    notes.append(body);
  } else {
    notes.hidden = true;
    notes.textContent = '';
  }

  /* The top of a chapter used to be bare prose: nothing said which work this
     was, and scrolling up to look for its front matter found nothing at all.
     The way back to the work was a book icon in a row of six, which is not
     something anyone reads as "the whole work". */
  const head = $('#reader-head');
  head.hidden = false;
  $('#rh-title').textContent = w.title ?? '(untitled)';
  $('#rh-by').textContent = authorsOf(w.authors)[0] ?? 'Anonymous';
  const chapterTitle = ch.title && ch.title !== `Chapter ${number}` ? `: ${ch.title}` : '';
  $('#rh-chapter').textContent = `Chapter ${number} of ${w.chapter_count}${chapterTitle}`;

  const pos = $('#chappos');
  pos.textContent = '';
  pos.append(icon('chapters', 'ic ic-chev'),
    document.createTextNode(`${number} / ${w.chapter_count}`));
  $('#prev').disabled = number <= 1;
  $('#next').disabled = number >= w.chapter_count;

  keepAwake(true);

  /* Replacing the chapter changes the height of the document, and the browser
     adjusts the scroll position afterwards to keep what was on screen on
     screen — after this line, undoing it. Scroll anchoring is turned off for
     the reader, and the position is set again on the next frame, once the new
     chapter has actually been laid out. */
  const offset = openingOffset(positions, workId, number, { transient });
  window.scrollTo(0, offset);
  requestAnimationFrame(() => {
    if (current.workId === workId && current.chapter === number) window.scrollTo(0, offset);
    updateProgress();
    readerAnchor = blockAtTop();
  });
  updateProgress();

  /*
   * Opening a work is the thing that puts it on the Continue reading shelf,
   * and nothing recorded it before: only the scroll handler wrote anything,
   * so a work opened and read without scrolling left no trace.
   *
   * Being opened and being positioned are two different facts, so they are
   * two different calls. A peek from a search result must not move the
   * bookmark — jumping to a passage two chapters back and leaving should not
   * cost somebody the place they had reached — but it is still reading, and
   * it still belongs at the front of the shelf. Only the position is skipped.
   */
  markOpened(workId);
  if (!transient) saveProgress(workId, number, offset);
  collectImages(workId);
}

// moving by hand is deliberate, so the bookmark starts following again
$('#prev').onclick = () => openChapter(current.workId, current.chapter - 1);
$('#next').onclick = () => openChapter(current.workId, current.chapter + 1);

/**
 * The chapter drawer, shared by the work page and the reader.
 *
 * Read chapters are marked, and the one you are on is highlighted and scrolled
 * to — in a fifty chapter work, opening at the top means scrolling to find
 * where you already are.
 */
async function showChapterDrawer(workId, at) {
  /* This used to return silently when the work in hand was not the one asked
     for, so the control did nothing at all and said nothing about why. The
     list is what it needs; if it does not have it, it fetches it. */
  const work = currentWork?.work_id === workId && currentWork.chapters
    ? currentWork
    : await api(`/api/works/${workId}`).catch(() => null);
  if (!work?.chapters?.length) { toast('That work has no chapter list'); return; }
  currentWork = work;
  const list = $('#chapter-list');
  list.textContent = '';
  const readTo = positions[workId]?.chapter ?? 0;

  for (const c of work.chapters) {
    const b = document.createElement('button');
    b.className = c.number === at ? 'at' : (c.number < readTo ? 'read' : '');
    b.innerHTML = '<span class="num"></span><span class="name"></span><span class="len"></span>';
    b.querySelector('.num').textContent = c.number;
    b.querySelector('.name').textContent = c.title ?? `Chapter ${c.number}`;
    b.querySelector('.len').textContent = `${fmt(c.words)}w`;
    b.onclick = () => { closeSheet($('#chapters-dialog')); openChapter(workId, c.number); };
    list.append(b);
  }
  openSheet($('#chapters-dialog'));
  list.querySelector('.at')?.scrollIntoView({ block: 'center' });
}

/* The chapter, on the archive. Chapter ids are the archive's own and are not
   stored here, so this opens the full-work view at the right anchor — which is
   the same place, reached by a route that needs nothing we do not have. */
/**
 * Up to the work, which is not the same as back.
 *
 * The only route, deliberately. The head of the chapter used to carry a link
 * saying the same thing, which meant two ways to one place — and a text link
 * in the middle of the reading column, where nothing else is tappable.
 *
 * A card on the Continue reading shelf opens the chapter directly, so the
 * work's own page was never visited and Back rightly returns to the shelf. That
 * left no route to it at all: the summary, the tags, the chapter list, the
 * kudos button. This is that route, and it exists whether or not the work page
 * happens to be behind us.
 */
$('#to-work').onclick = () => upToWork(current.workId);
$('#kudos-here').onclick = () => giveKudos(current.workId, $('#kudos-here'));

$('#on-archive').onclick = () => {
  if (!current.workId) return;
  openOnArchive(`/works/${current.workId}?view_full_work=true#chapter-${current.chapter}`);
};

$('#chappos').onclick = () => currentWork && showChapterDrawer(current.workId, current.chapter);

function updateProgress() {
  const doc = document.documentElement;
  const height = doc.scrollHeight - window.innerHeight;
  const pct = height > 0 ? Math.min(100, (window.scrollY / height) * 100) : 0;
  $('#progress-bar').style.width = `${pct}%`;
}

/* Remember the place, but not on every scroll event — that writes constantly. */
let posTimer;
addEventListener('scroll', () => {
  if ($('#reader').hidden || !current.workId) return;
  updateProgress();
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    /* Far enough past where the search dropped you that this is no longer a
       glance at a passage but reading the work. */
    if (readingIsTransient && !transientForever
        && Math.abs(window.scrollY - transientFrom) > window.innerHeight) {
      readingIsTransient = false;
    }
    if (readingIsTransient) return;
    positions[current.workId] = {
      chapter: current.chapter, y: Math.round(window.scrollY), at: Date.now(),
    };
    save(POS_KEY, positions);
    saveProgress(current.workId, current.chapter, window.scrollY);
    readerAnchor = blockAtTop();     // in case the screen changes shape next
  }, 400);
}, { passive: true });

/*
 * Keeping your place when the screen changes shape.
 *
 * A phone that folds changes the width of the column mid-chapter, and the
 * text reflows to a different height — so the pixel offset the reader was
 * saved at now points somewhere else entirely, usually a screenful or two
 * out. A paragraph does not move: it is the same paragraph at either width.
 * So the place is remembered as a paragraph and how far into it you had got,
 * and that survives a fold, an unfold and a change of type size alike.
 */
function blockAtTop() {
  const blocks = $$('#workskin .userstuff > *');
  for (let i = 0; i < blocks.length; i++) {
    const box = blocks[i].getBoundingClientRect();
    if (box.bottom > 0) {
      return { index: i, within: box.height ? -box.top / box.height : 0 };
    }
  }
  return null;
}

function returnToAnchor(anchor) {
  if (!anchor) return;
  const block = $$('#workskin .userstuff > *')[anchor.index];
  if (!block) return;
  const box = block.getBoundingClientRect();
  window.scrollTo(0, Math.max(0, window.scrollY + box.top + anchor.within * box.height));
}

/*
 * The manifest claims screenSize and screenLayout, so folding does not
 * recreate the activity — which is what keeps a chapter open and a download
 * running across a fold. The shell calls this to say the shape changed.
 */
function onScreenResized() {
  for (const r of $$('.rail')) markOverflow(r);
  if ($('#reader').hidden || !current.workId) return;
  const anchor = readerAnchor;
  // after the reflow, not during it
  requestAnimationFrame(() => requestAnimationFrame(() => {
    returnToAnchor(anchor);
    updateProgress();
  }));
}

let readerAnchor = null;
window.__resized = onScreenResized;

/* ------------------------------------------------------- feeling like an app */

const nativeShell = typeof window !== 'undefined' ? window.ArchiveNative : undefined;

/** Hold the screen awake while a chapter is open, the way reading apps do. */
function keepAwake(on) {
  try { nativeShell?.keepAwake?.(Boolean(on)); } catch { /* browser: no such thing */ }
}

/**
 * Swipe between chapters.
 *
 * Deliberately ignores anything starting within 24px of the left edge: that
 * belongs to Android's own back gesture, and an app that fights the system
 * gesture is worse than one with no gestures at all.
 *
 * Requires a mostly-horizontal movement so it cannot fire while someone is
 * scrolling the page, which is what they are doing almost all of the time.
 */
/**
 * Turning a page, felt rather than guessed at.
 *
 * The gesture used to be a secret command: touchstart remembered where a
 * finger landed, touchend measured how far it had gone, and nothing moved in
 * between. A swipe that was going to succeed looked exactly like one that was
 * going to be cancelled, and the chapter changed only once the finger had
 * already lifted.
 *
 * Now the page travels with the finger, resists where there is nothing to turn
 * to, and either completes or visibly settles back. The requirement is not the
 * animation — it is that the surface answers the finger continuously.
 */
/**
 * Whether this point belongs to something that scrolls sideways itself.
 *
 * A tag row and a shelf of cards both pan horizontally, and a finger that
 * lands on one is asking for that pan, not for a page turn.
 */
function scrollsSideways(node, direction) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    const { scrollWidth, clientWidth, scrollLeft } = el;
    if (scrollWidth <= clientWidth + 4) continue;      // cheap test before styles
    const style = { scrollWidth, clientWidth, scrollLeft, overflowX: getComputedStyle(el).overflowX };
    if (ownsHorizontal(style, { direction })) return true;
  }
  return false;
}

const SWIPE = {
  OUT: DURATION.base,     // carrying a committed page off screen
  IN: DURATION.enter,     // bringing the next one on, which travels further
};

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * @param el        the view that receives the gesture
 * @param surface   the element whose --page-x is animated (the content, not
 *                  the chrome: the chapter bar must not slide off with the prose)
 */
/**
 * Turning a page.
 *
 * The gesture itself lives in core/swipe.js so it can be run outside a
 * browser: two attempts at fixing page turns were made by reasoning about this
 * code and shipping an APK, and both were wrong. Everything it touches is
 * passed in, and there are tests that drive a fake finger across a fake
 * surface and assert that the page turned.
 */
function wireSwipe(el, { onLeft = null, onRight = null, canLeft = null, canRight = null } = {}) {
  return createSwipe(el, {
    onLeft: onLeft ?? (() => openChapter(current.workId, current.chapter + 1)),
    onRight: onRight ?? (() => openChapter(current.workId, current.chapter - 1)),
    canLeft: canLeft ?? (() => !viewingArchive && current.chapter < current.count),
    canRight: canRight ?? (() => !viewingArchive && current.chapter > 1),
    viewportWidth: () => window.innerWidth,
    scrollsSideways,
    reduceMotion,
    onCommit: () => { tick('commit'); suppressMotion = true; },
    onReject: () => tick('reject'),
    duration: { out: DURATION.base, in: DURATION.enter, settle: DURATION.base },
    frame: (fn) => { suppressMotion = false; requestAnimationFrame(fn); },
  });
}

/**
 * Backwards, all the way out.
 *
 * Swiping right walked back a chapter at a time and then stopped dead at the
 * first one, resisting — which is honest about there being no chapter zero,
 * but wrong about there being nowhere to go. Backwards from the first chapter
 * is the work itself.
 *
 * Forwards keeps its resistance at the last chapter, because past the end of
 * a work there genuinely is nothing.
 */
wireSwipe($('#reader'), {
  canRight: () => !viewingArchive && Boolean(current.workId),
  onRight: () => (current.chapter > 1
    ? openChapter(current.workId, current.chapter - 1)
    : upToWork(current.workId)),
});

/**
 * Swipe left on a work to start reading it.
 *
 * The same gesture that turns a page in the reader opens the work from its
 * detail page, so the motion means the same thing throughout: onward.
 */
wireSwipe($('#detail'), {
  canLeft: () => Boolean(currentWork),
  onLeft: () => {
    if (!currentWork) return;
    const at = positions[currentWork.work_id]?.chapter ?? 1;
    return openChapter(currentWork.work_id, at);
  },
  /* And back out again the way you came in. Onward was a gesture and returning
     was not, which left the movement meaning something in one direction and
     nothing at all in the other. */
  canRight: () => stack.depth > 0,
  onRight: () => goBack(),
});

/**
 * Keys that do what they do everywhere else.
 *
 * Ignored while typing, so a search for "next" does not turn a page.
 */
addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '');
  if (typing) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  if (e.key === '/' ) { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'Escape') { if (window.__onBack()) e.preventDefault(); return; }

  if (!$('#reader').hidden) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      if (current.chapter < current.count) { e.preventDefault(); openChapter(current.workId, current.chapter + 1); }
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (current.chapter > 1) { e.preventDefault(); openChapter(current.workId, current.chapter - 1); }
    } else if (e.key === 'c') {
      e.preventDefault();
      if (currentWork) showChapterDrawer(current.workId, current.chapter);
    }
  }
});

/* ------------------------------------------------------------- dialogues */

$('#typo').onclick = () => openSheet($('#typography'));
for (const b of $$('[data-close]')) b.onclick = () => closeSheet($(`#${b.dataset.close}`));

for (const [id, key, transform] of [
  ['theme', 'theme', String], ['face', 'face', String], ['align', 'align', String],
  ['bg', 'bg', String], ['fg', 'fg', String],
  ['weight', 'weight', Number], ['size', 'size', Number], ['lh', 'lh', Number],
  ['margin', 'margin', Number], ['vmargin', 'vmargin', Number],
]) {
  const input = $(`#${id}`);
  input.value = prefs[key];
  let debounce;
  input.addEventListener('input', () => {
    prefs[key] = transform(input.value);
    if (key === 'face') {
      clearTimeout(debounce);                 // don't request a half-typed family
      debounce = setTimeout(applyPrefs, 400);
      save(PREFS_KEY, prefs);
      return;
    }
    // touching a colour is an unambiguous request for a custom theme
    if ((key === 'bg' || key === 'fg') && prefs.theme !== 'custom') {
      prefs.theme = 'custom';
      $('#theme').value = 'custom';
    }
    applyPrefs();
  });
}

/* ------------------------------------------------------------------ start */

for (const b of $$('#tabs button')) {
  b.onclick = () => {
    stack.reset();
    const tab = b.dataset.tab;
    if (tab === 'activity') { show('activity', 'lateral'); buildActivity(); return; }
    if (tab === 'search') {
      /* The results screen is one reused element, so arriving at it with an
         empty box used to show whatever was searched for last — an old result
         set under a field that says nothing was asked. */
      if (!$('#q').value.trim()) {
        $('#results').innerHTML =
          '<p class="empty">Search your library — works, tags, and every word held.</p>';
      }
      show('results', 'lateral');
      $('#q').focus();
      return;
    }
    show(tab, 'lateral');
    if (tab === 'library' && !offset) loadMore(true);
    // Home is refreshed by show(), the same way arriving at it any other way is
  };
}

/* --------------------------------------------------------------- account */

function paintAccount() {
  const button = $('#account');
  if (!button) return;
  if (!isNative) { button.textContent = 'App only'; button.disabled = true; return; }
  const on = signedIn();
  button.textContent = on ? 'Sign out' : 'Sign in';
  button.classList.toggle('on', on);
  button.onclick = () => {
    if (on) { signOut(); forgetArchiveUser(); toast('Signed out'); paintAccount(); }
    else { closeSheet($('#typography')); signIn(); }
  };
}

/**
 * The shell calls this when the notification is tapped.
 *
 * A notification about a download has one sensible destination, and it is not
 * wherever the app happened to be left.
 */
window.__open = (where) => {
  if (!VIEWS.includes(String(where))) return;
  stack.reset();
  show(String(where), 'lateral');
  if (where === 'activity') buildActivity();
};

/* The shell calls this when the archive's login page has finished with us. */
window.__signedIn = (ok) => {
  /* Signing in may be a different person from the one signed in before. */
  forgetArchiveUser();
  paintAccount();
  toast(ok ? 'Signed in to the archive' : 'Not signed in');
  if (ok) $('#addwork-signin').hidden = true;
};

/* ------------------------------------------------------------ add a work */

const addDialog = $('#addwork');

$('#add').onclick = async () => {
  $('#addwork-status').hidden = true;
  $('#addwork-url').value = '';
  openSheet(addDialog);
  // most links arrive from somewhere else, so offer what is on the clipboard
  try {
    const pasted = await navigator.clipboard?.readText?.();
    if (pasted && /\/works\/\d+/.test(pasted)) $('#addwork-url').value = pasted.trim();
  } catch { /* no clipboard permission; typing still works */ }
  $('#addwork-url').focus();
};

async function submitAddWork() {
  const input = $('#addwork-url').value.trim();
  if (!input) return;
  const status = $('#addwork-status');
  const button = $('#addwork-go');

  status.hidden = false;
  status.className = 'addwork-status';
  status.textContent = 'Fetching…';
  button.disabled = true;

  try {
    const out = await addWork(input);
    status.className = 'addwork-status ok';

    /* A series is a batch, so it goes through the queue like any other batch:
       paced, visible, and able to be paused. It used to download itself, one
       work straight after another, which is sequential rather than paced. */
    if (out.kind === 'series') {
      const queued = queueSeries(out);
      status.textContent = queued
        ? `Queued ${fmt(out.count)} work${out.count === 1 ? '' : 's'} from the series`
        : 'Those works are all here already';
    } else {
      status.textContent = `${out.added === false ? 'Updated' : 'Added'} “${out.title}” — `
        + `${out.chapters} chapter${out.chapters === 1 ? '' : 's'}`;
    }

    // the library and home shelves are both stale now
    await refresh({ works: true, force: true });
    setTimeout(() => {
      closeSheet(addDialog);
      if (out.workId) openWork(out.workId);
    }, out.kind === 'series' ? 1400 : 700);
  } catch (e) {
    status.className = 'addwork-status bad';
    status.textContent = e.message;
    // the commonest reason a work refuses is that it is locked to members
    $('#addwork-signin').hidden = !(isNative && !signedIn() && /restricted|login|403|404/i.test(e.message));
  } finally {
    button.disabled = false;
  }
}

/**
 * A link opened or shared into the app.
 *
 * The work is added straight away rather than waiting for a second tap: the
 * reader has already expressed the intent by choosing this app for the link.
 * The dialog opens to show what is happening and what came of it.
 */
window.__openLink = async (link) => {
  if (!link) return;

  /* No dialog and nothing to confirm. Opening a work in this app *is* the
     instruction to keep it — the reader already chose this app for the link,
     and asking again is asking them to say the same thing twice. The sheet
     appears only if something goes wrong, because then there is a decision to
     make: sign in, or try a different link.

     The work opens on a skeleton immediately, so the wait happens somewhere
     that already looks like the destination rather than behind a modal. */
  toast('Fetching from the archive…');
  try {
    const out = await addWork(link);
    await refresh({ works: true, force: true });
    tick('commit');

    if (out.kind === 'series') {
      const queued = queueSeries(out);
      toast(queued
        ? `Queued ${fmt(out.count)} work${out.count === 1 ? '' : 's'} from the series`
        : 'Those works are all here already');
      go('library');
      return;
    }
    toast(`Saved “${out.title}”`);
    openWork(out.workId);
  } catch (e) {
    /* A failure is the one case with something to decide, so it gets the sheet
       — with the link still in it, ready to retry. */
    $('#addwork-url').value = link;
    if (!addDialog.open) openSheet(addDialog);
    const status = $('#addwork-status');
    status.hidden = false;
    status.className = 'addwork-status bad';
    status.textContent = e.message;
    $('#addwork-signin').hidden = !(isNative && !signedIn()
      && /restricted|login|403|404|sign in/i.test(e.message));
  }
};

$('#addwork-go').onclick = submitAddWork;
$('#addwork-signin-go').onclick = () => { closeSheet(addDialog); signIn(); };
$('#addwork-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitAddWork(); }
});

$('#import').onclick = () => {
  if (!isNative) { toast('Import is only available in the app'); return; }
  importDatabase();
};

async function adoptImportedTheme() {
  if (STORED_PREFS) return;                   // the reader's own choice outranks it
  try {
    const { prefs: imported } = await api('/api/prefs');
    if (!imported) return;
    Object.assign(prefs, imported);
    for (const id of ['theme', 'bg', 'fg', 'face', 'weight', 'size', 'lh', 'margin', 'vmargin', 'align']) {
      const input = $(`#${id}`);
      if (input) input.value = prefs[id];
    }
    applyPrefs();
  } catch { /* nothing to import; the defaults stand */ }
}

async function start() {
  applyPrefs();
  const status = nativeStatus();
  if (!status.hasDatabase) {
    // the internal path is not information a reader can act on
    $('#setup-hint').textContent = 'Look under Internal storage → Download.';
    show('setup');
    return;
  }
  if (!status.search) toast('This device\'s SQLite cannot do full-text search');
  show('home');

  /*
   * The home screen is built before anything else is seen to.
   *
   * It used to come last, after the queue had been resumed, the account
   * painted and the imported theme awaited — so the first thing the app did
   * with the reader watching was everything except the screen they were
   * looking at. Any one of those being slow, and a resumed queue asking after
   * hundreds of works was, left a blank page until something else happened to
   * redraw it. None of that housekeeping is worth a moment of empty screen,
   * and none of it needs to have finished for home to be right.
   */
  const painted = refresh({ force: true });

  /* Each chore stands on its own: one of them failing is not a reason for the
     rest not to run, and never a reason to take the screen down with it. */
  for (const chore of [
    () => resumeJobs(),        // whatever was owed when the app last closed
    () => paintAccount(),
    () => paintActiveFilters(),
    // an intent can arrive before this page exists, so the shell holds it
    () => { const opened = pendingLink();
            if (opened) setTimeout(() => window.__openLink(opened), 0); },
    /* Tapped a download notification while the app was closed: land there. */
    () => { const where = pendingOpen();
            if (where) setTimeout(() => window.__open(where), 0); },
  ]) {
    try { chore(); } catch (e) { console.warn('startup', e); }
  }

  await adoptImportedTheme();
  await painted;
}

start();
