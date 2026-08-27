/**
 * The reader.
 *
 * Views, one history stack, no framework. State a reader would be annoyed to
 * lose — typography, theme, and where they were in every work — is written to
 * localStorage as it changes: losing your place in a 100,000 word fic is the
 * difference between an app you keep and one you abandon.
 */

import { History } from './core/nav.js';
import { DURATION } from './core/motion.js';
import { axisOf, travel, commits, inSystemEdge, ownsHorizontal, dismisses } from './core/gesture.js';
import { exportDatabase, databaseSize, haptic, leaveKudos, bookmarkWork, commentOnWork, openOnArchive } from './api.js';
import { api, isNative, nativeStatus, importDatabase, addWork, signIn, signOut, signedIn, saveProgress, pendingLink } from './api.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ------------------------------------------------------------------ state */

const PREFS_KEY = 'archive.prefs';
/* A cache of what the database already knows, so the reader can restore a
   scroll offset without a round trip. The database is the source of truth. */
const POS_KEY = 'archive.positions';
const VIEW_KEY = 'archive.view';

const load = (key, fallback) => {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
  catch { return { ...fallback }; }      // a corrupt or blocked store must not break reading
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
  include: [], exclude: [], rating: [],
  complete: '', language: '', wordsMin: '', wordsMax: '',
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

function applyPrefs() {
  const r = document.documentElement;
  if (prefs.theme === 'system' || prefs.theme === 'custom') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', prefs.theme);

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

const VIEWS = ['setup', 'home', 'library', 'results', 'detail', 'reader', 'settings'];
const stack = new History();

/** Views the tab bar owns; anything deeper hides it and shows Back instead. */
const TABBED = new Set(['home', 'library', 'results']);

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
function here() {
  return { screen: showing(), scrollY: window.scrollY, query: $('#q').value };
}

function go(name) {
  if (!stack.go(here(), name)) return;
  show(name, 'forward');
}

function goBack() {
  const from = stack.back();
  if (!from) return false;
  show(from.screen, 'back');
  /* Views are hidden rather than torn down, so the library's rows, the results
     and the work page are all still in the DOM exactly as they were left —
     returning is a matter of showing them again at the right offset, with no
     refetch and no flash of rebuilt content. */
  $('#q').value = from.query ?? '';
  paintSearchPlaceholder();
  requestAnimationFrame(() => window.scrollTo(0, from.scrollY ?? 0));
  return true;
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
  if (stack.depth === 0) return;
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
window.__onBack = () => {
  for (const d of $$('dialog[open]')) { closeSheet(d); return true; }
  return goBack();
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
  node.querySelector('.by').textContent = 'by ' + (authorsOf(w.authors).join(', ') || 'Anonymous');
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
    open: () => (p ? openChapter(w.work_id, w.at_chapter ?? 1) : openChapter(w.work_id, 1)),
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
    if (!total) {
      box.innerHTML = '<p class="empty">No works match this filter.</p>';
    }
  } catch (e) {
    $('#more').textContent = '';
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
  for (const key of ['include', 'exclude', 'rating']) {
    if (view[key]?.length) p.set(key, view[key].join('\t'));
  }
  for (const key of ['complete', 'language', 'wordsMin', 'wordsMax']) {
    if (view[key]) p.set(key, view[key]);
  }
  return p;
}

const activeCount = () =>
  view.include.length + view.exclude.length + view.rating.length
  + (view.complete ? 1 : 0) + (view.language ? 1 : 0)
  + (view.wordsMin ? 1 : 0) + (view.wordsMax ? 1 : 0)
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

/* Which sections are open. Remembered, so reopening the panel is not a reset. */
const openSections = new Set(['state']);
const sectionSearch = {};
const SHOW_AT_FIRST = 12;

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
          const at = find.selectionStart;
          paintChips();
          const again = box.querySelector('.sec-find');
          again.focus();
          again.setSelectionRange(at, at);
        };
        box.append(find);
      }

      const opts = document.createElement('div');
      opts.className = 'opts';
      box.append(opts);

      let expanded = box.dataset.expanded === '1';
      function paintChips() {
        const list = (sectionSearch[kind] ?? '')
          ? items.filter((t) => t.name.toLowerCase().includes((sectionSearch[kind] ?? '').toLowerCase()))
          : items;
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
          more.textContent = `Show all ${list.length}`;
          more.onclick = () => { expanded = true; box.dataset.expanded = '1'; paintChips(); };
          opts.append(more);
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

  if (view.state !== 'all') pill(view.state, 'state', () => { view.state = 'all'; });
  for (const t of view.include) pill(t, 'in', () => { view.include = view.include.filter((x) => x !== t); });
  for (const t of view.exclude) pill(`not ${t}`, 'out', () => { view.exclude = view.exclude.filter((x) => x !== t); });
  for (const r of view.rating) pill(r, 'in', () => { view.rating = view.rating.filter((x) => x !== r); });
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
  Object.assign(view, {
    state: 'all', include: [], exclude: [], rating: [],
    complete: '', language: '', wordsMin: '', wordsMax: '',
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
addEventListener('resize', () => { for (const r of $$('.rail')) markOverflow(r); }, { passive: true });

/* --------------------------------------------------------------- settings */

/**
 * One place for the things that are not reading.
 *
 * The account button used to live inside the reading-settings dialog, between
 * line spacing and text alignment, which is not where anybody would look for
 * it. Backing up had no home at all — the library is a single file assembled
 * over months and there was no way to get a copy of it off the phone.
 */
const VERSION = 'v0.15.0';

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
  if (bytes) add('Backup size', `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);

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
function archiveActions(w) {
  const row = document.createElement('div');
  row.className = 'actions archive-actions';

  const kudos = document.createElement('button');
  const already = Boolean(w.kudos_given);
  kudos.className = 'archive-act';
  kudos.disabled = already;
  kudos.append(icon('star', 'ic ic-inline'), document.createTextNode(already ? 'Kudos left' : 'Kudos'));
  kudos.onclick = async () => {
    kudos.classList.add('is-busy');
    try {
      const out = await leaveKudos(w.work_id);
      kudos.textContent = '';
      kudos.append(icon('star', 'ic ic-inline'), document.createTextNode('Kudos left'));
      kudos.disabled = true;
      tick('commit');
      toast(out.already ? 'You had already left kudos' : 'Kudos left');
    } catch (e) {
      toast(e.message);
    } finally {
      kudos.classList.remove('is-busy');
    }
  };

  const bookmark = document.createElement('button');
  bookmark.className = 'archive-act';
  bookmark.append(icon('bookmark', 'ic ic-inline'),
    document.createTextNode(w.in_bookmarks ? 'Bookmarked' : 'Bookmark'));
  bookmark.onclick = () => {
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

  const onArchive = document.createElement('button');
  onArchive.className = 'archive-act';
  onArchive.append(icon('external', 'ic ic-inline'), document.createTextNode('On the archive'));
  onArchive.onclick = () => openOnArchive(`/works/${w.work_id}`);

  row.append(kudos, bookmark, comment, onArchive);
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

function openSheet(d) {
  if (d.open) return;
  sheetHandle(d);
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
  card.innerHTML = `<div class="card-title"></div><div class="card-by"></div>
    <div class="card-fandom"></div>
    <div class="card-foot">${fmt(w.words)} words${w.complete ? '' : ' · WIP'}</div>
    ${p ? `<div class="bar"><div style="width:${p.pct}%"></div></div>` : ''}`;
  const cardTitle = card.querySelector('.card-title');
  cardTitle.textContent = w.title ?? '(untitled)';
  cardTitle.prepend(...marks(w));
  card.querySelector('.card-by').textContent = authorsOf(w.authors)[0] ?? 'Anonymous';
  card.querySelector('.card-fandom').textContent = w.fandom ?? '';
  card.onclick = () => (p ? openChapter(w.work_id, w.at_chapter ?? 1) : openWork(w.work_id));
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
  go('results');

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

async function openWork(workId) {
  /* Opening a second work before the first has answered must not let the
     first overwrite the second when it lands. */
  const token = ++pending;
  go('detail');
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

  /* AO3's own preface and meta block, generated server-side from stored fields
     with every value escaped on the way out — none of it is author markup. */
  const preface = document.createElement('div');
  preface.innerHTML = w.preface_html ?? '';
  box.append(preface);

  const saved = positions[workId];
  const actions = document.createElement('div');
  actions.className = 'actions';
  const read = document.createElement('button');
  read.className = 'primary';
  read.textContent = saved?.chapter ? `Continue chapter ${saved.chapter}` : 'Read';
  read.onclick = () => openChapter(workId, saved?.chapter ?? 1);
  actions.append(read);
  if (saved?.chapter) {
    const restart = document.createElement('button');
    restart.textContent = 'Start again';
    restart.onclick = () => openChapter(workId, 1);
    actions.append(restart);
  }
  box.append(actions);
  box.append(archiveActions(w));

  const meta = document.createElement('div');
  meta.innerHTML = w.meta_html ?? '';
  box.append(meta);

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
}

/* ----------------------------------------------------------------- reader */

let current = { workId: null, chapter: 1, count: 1 };

/* True while reading somewhere the reader jumped to from a search result.
   Their bookmark stays where it was until they navigate deliberately. */
let readingIsTransient = false;

async function openChapter(workId, number, { transient = false } = {}) {
  readingIsTransient = transient;
  const token = ++pending;

  /* Entering the reader is acknowledged before the chapter is read. Turning a
     page is not: the swipe is already carrying the old page off, and a
     skeleton flashing behind it would be noise rather than feedback. */
  const arriving = showing() !== 'reader';
  if (arriving) {
    go('reader');
    $('#workskin').replaceChildren(skeleton('line', 'line', 'line', 'line', 'line', 'line'));
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

  const pos = $('#chappos');
  pos.textContent = '';
  pos.append(icon('chapters', 'ic ic-chev'),
    document.createTextNode(`${number} / ${w.chapter_count}`));
  $('#prev').disabled = number <= 1;
  $('#next').disabled = number >= w.chapter_count;

  keepAwake(true);

  const saved = positions[workId];
  window.scrollTo(0, saved?.chapter === number && saved.y ? saved.y : 0);
  updateProgress();
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
    // a search excursion must not move the reader's bookmark
    if (readingIsTransient) return;
    positions[current.workId] = {
      chapter: current.chapter, y: Math.round(window.scrollY), at: Date.now(),
    };
    save(POS_KEY, positions);
    saveProgress(current.workId, current.chapter, window.scrollY);
  }, 400);
}, { passive: true });

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
function wireSwipe(el, { onLeft = null, onRight = null, canLeft = null, canRight = null } = {}) {
  const allowLeft = canLeft ?? (() => current.chapter < current.count);
  const allowRight = canRight ?? (() => current.chapter > 1);
  const goLeft = onLeft ?? (() => openChapter(current.workId, current.chapter + 1));
  const goRight = onRight ?? (() => openChapter(current.workId, current.chapter - 1));

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

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // the screen edges belong to the system, not to us
    if (inSystemEdge(e.clientX, window.innerWidth)) return;
    if (el.classList.contains('settling')) return;
    origin = e.target;
    x0 = e.clientX; y0 = e.clientY;
    tracking = true; dragging = false;
    pointerId = e.pointerId;
  }, { passive: true });

  el.addEventListener('pointermove', (e) => {
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
         moved, and deciding it early is what stopped chapters turning at all. */
      if (scrollsSideways(origin, Math.sign(dx))) { tracking = false; return; }

      dragging = true;
      el.classList.add('swiping');
      el.setPointerCapture?.(e.pointerId);
    }

    const blocked = (dx < 0 && !allowLeft()) || (dx > 0 && !allowRight());
    setX(travel(dx, { blocked }));
  }, { passive: true });

  const release = async (e) => {
    if (!tracking || (pointerId != null && e.pointerId !== pointerId)) return;
    if (!dragging) { done(); return; }

    const dx = e.clientX - x0;
    const forward = dx < 0;
    const allowed = forward ? allowLeft() : allowRight();
    const committed = commits(dx, window.innerWidth, { allowed });

    if (!committed) {
      // a pull towards a chapter that isn't there: the resistance already said
      // so, and this is the same refusal in another sense
      if (!allowed && commits(dx, window.innerWidth)) tick('reject');
      settle(DURATION.base);           // visibly back where it started
      setX(0);
      setTimeout(done, DURATION.base + 10);
      return;
    }

    tick('commit');

    if (reduceMotion()) {
      done();
      await (forward ? goLeft() : goRight());
      return;
    }

    suppressMotion = true;   // the gesture is the transition

    // carry the page off, swap the content, bring the next one in from the
    // side the finger was heading towards
    settle(SWIPE.OUT);
    setX(forward ? -window.innerWidth : window.innerWidth);
    await new Promise((r) => setTimeout(r, SWIPE.OUT));

    el.classList.remove('settling');
    setX(forward ? window.innerWidth : -window.innerWidth);
    await (forward ? goLeft() : goRight());

    suppressMotion = false;
    requestAnimationFrame(() => {
      settle(SWIPE.IN);
      setX(0);
      setTimeout(done, SWIPE.IN + 10);
    });
  };

  el.addEventListener('pointerup', release, { passive: true });
  el.addEventListener('pointercancel', () => {
    if (!dragging) { done(); return; }
    settle(DURATION.base);
    setX(0);
    setTimeout(done, DURATION.base + 10);
  }, { passive: true });
}

wireSwipe($('#reader'));

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
    if (tab === 'search') { show('results', 'lateral'); $('#q').focus(); return; }
    show(tab, 'lateral');
    if (tab === 'library' && !offset) loadMore(true);
    if (tab === 'home') { buildHome(); buildStartHere(); }
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
    if (on) { signOut(); toast('Signed out'); paintAccount(); }
    else { closeSheet($('#typography')); signIn(); }
  };
}

/* The shell calls this when the archive's login page has finished with us. */
window.__signedIn = (ok) => {
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

    /* A series link brings back many works rather than one, so it reports a
       count and opens nothing — there is no single work to open, and one that
       partly failed should say so rather than look like a clean success. */
    if (out.kind === 'series') {
      status.textContent = `Added ${out.added} work${out.added === 1 ? '' : 's'}`
        + (out.failed.length ? `, ${out.failed.length} could not be fetched` : '');
    } else {
      status.textContent = `${out.added === false ? 'Updated' : 'Added'} “${out.title}” — `
        + `${out.chapters} chapter${out.chapters === 1 ? '' : 's'}`;
    }

    // the library and home shelves are both stale now
    offset = 0;
    await Promise.all([loadMore(true), buildHome().catch(() => {})]);
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
    offset = 0;
    await Promise.all([loadMore(true), buildHome().catch(() => {})]);
    tick('commit');

    if (out.kind === 'series') {
      toast(`Saved ${out.added} work${out.added === 1 ? '' : 's'} from the series`);
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
  paintAccount();

  // an intent can arrive before this page exists, so the shell holds it
  const opened = pendingLink();
  if (opened) setTimeout(() => window.__openLink(opened), 0);
  await adoptImportedTheme();
  paintActiveFilters();
  await Promise.all([buildHome(), buildStartHere()]);
}

start();
