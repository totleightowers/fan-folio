/**
 * The reader.
 *
 * Views, one history stack, no framework. State a reader would be annoyed to
 * lose — typography, theme, and where they were in every work — is written to
 * localStorage as it changes: losing your place in a 100,000 word fic is the
 * difference between an app you keep and one you abandon.
 */

import { History } from './core/nav.js';
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

const VIEWS = ['setup', 'home', 'library', 'results', 'detail', 'reader'];
const stack = new History();

/** Views the tab bar owns; anything deeper hides it and shows Back instead. */
const TABBED = new Set(['home', 'library', 'results']);

/** The view currently on screen. */
const showing = () => VIEWS.find((v) => !$(`#${v}`).hidden) ?? 'home';

function show(name) {
  if (name !== 'reader') keepAwake(false);
  for (const v of VIEWS) $(`#${v}`).hidden = v !== name;
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
  show(name);
}

function goBack() {
  const from = stack.back();
  if (!from) return false;
  show(from.screen);
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

/* The shell asks this before it closes the app; true means we handled it. */
window.__onBack = () => {
  for (const d of $$('dialog[open]')) { d.close(); return true; }
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
  node.querySelector('h3').textContent = (w.marked_later ? '★ ' : '') + (w.title ?? '(untitled)');
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
        <span class="sec-chev">›</span>
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
  $('#filters').showModal();
  await refreshAfterFilterChange();
};
$('#apply-filters').onclick = () => {
  $('#filters').close();
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
  card.querySelector('.card-title').textContent = w.title ?? '(untitled)';
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

async function openWork(workId) {
  const w = await api(`/api/works/${workId}`);
  currentWork = w;
  // the database is authoritative; the local cache only remembers the exact
  // scroll offset, which is not worth a column of its own
  if (w.at_chapter && (!positions[workId] || positions[workId].chapter !== w.at_chapter)) {
    positions[workId] = { ...(positions[workId] ?? {}), chapter: w.at_chapter, y: 0 };
  }
  const box = $('#detail');
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
    open.innerHTML = '<span class="glyph">☰</span><span class="label"></span>'
      + '<span class="chev">›</span>';
    open.querySelector('.label').textContent =
      `${w.chapters.length} chapters` + (saved?.chapter ? ` · you are on ${saved.chapter}` : '');
    open.onclick = () => showChapterDrawer(workId, saved?.chapter ?? 1);
    box.append(open);
  }

  const hint = document.createElement('p');
  hint.className = 'swipe-hint';
  hint.textContent = 'Swipe left to start reading';
  box.append(hint);
  go('detail');
}

/* ----------------------------------------------------------------- reader */

let current = { workId: null, chapter: 1, count: 1 };

/* True while reading somewhere the reader jumped to from a search result.
   Their bookmark stays where it was until they navigate deliberately. */
let readingIsTransient = false;

async function openChapter(workId, number, { transient = false } = {}) {
  readingIsTransient = transient;
  const w = currentWork?.work_id === workId ? currentWork : await api(`/api/works/${workId}`);
  currentWork = w;
  const ch = await api(`/api/works/${workId}/chapters/${number}`);
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

  $('#chappos').textContent = `${number} / ${w.chapter_count}`;
  $('#prev').disabled = number <= 1;
  $('#next').disabled = number >= w.chapter_count;

  go('reader');   // a no-op when already reading, e.g. turning a page
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
function showChapterDrawer(workId, at) {
  const work = currentWork?.work_id === workId ? currentWork : null;
  if (!work) return;
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
    b.onclick = () => { $('#chapters-dialog').close(); openChapter(workId, c.number); };
    list.append(b);
  }
  $('#chapters-dialog').showModal();
  list.querySelector('.at')?.scrollIntoView({ block: 'center' });
}

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
function wireSwipe(el, { onLeft = null, onRight = null } = {}) {
  const EDGE = 24;
  const MIN_X = 70;
  const MAX_DRIFT = 0.6;   // vertical travel relative to horizontal
  let x0 = 0; let y0 = 0; let live = false;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { live = false; return; }
    const t = e.touches[0];
    live = t.clientX > EDGE && t.clientX < window.innerWidth - EDGE;
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    if (!live) return;
    live = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0;
    const dy = t.clientY - y0;
    if (Math.abs(dx) < MIN_X || Math.abs(dy) > Math.abs(dx) * MAX_DRIFT) return;
    if (dx < 0) {
      if (onLeft) onLeft();
      else if (current.chapter < current.count) openChapter(current.workId, current.chapter + 1);
    } else if (dx > 0) {
      if (onRight) onRight();
      else if (current.chapter > 1) openChapter(current.workId, current.chapter - 1);
    }
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
  onLeft: () => {
    if (!currentWork) return;
    const at = positions[currentWork.work_id]?.chapter ?? 1;
    openChapter(currentWork.work_id, at);
  },
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

$('#typo').onclick = () => $('#typography').showModal();
for (const b of $$('[data-close]')) b.onclick = () => $(`#${b.dataset.close}`).close();

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
    if (tab === 'search') { show('results'); $('#q').focus(); return; }
    show(tab);
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
    else { $('#typography').close(); signIn(); }
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
  addDialog.showModal();
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
    status.textContent = `${out.added === false ? 'Updated' : 'Added'} “${out.title}” — `
      + `${out.chapters} chapter${out.chapters === 1 ? '' : 's'}`;
    // the library and home shelves are both stale now
    offset = 0;
    await Promise.all([loadMore(true), buildHome().catch(() => {})]);
    setTimeout(() => { addDialog.close(); openWork(out.workId); }, 700);
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
  $('#addwork-url').value = link;
  $('#addwork-status').hidden = true;
  $('#addwork-signin').hidden = true;
  if (!addDialog.open) addDialog.showModal();
  await submitAddWork();
};

$('#addwork-go').onclick = submitAddWork;
$('#addwork-signin-go').onclick = () => { addDialog.close(); signIn(); };
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
