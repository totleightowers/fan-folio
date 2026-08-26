/**
 * The reader.
 *
 * Views, one history stack, no framework. State a reader would be annoyed to
 * lose — typography, theme, and where they were in every work — is written to
 * localStorage as it changes: losing your place in a 100,000 word fic is the
 * difference between an app you keep and one you abandon.
 */

import { api, isNative, nativeStatus, importDatabase } from './api.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ------------------------------------------------------------------ state */

const PREFS_KEY = 'archive.prefs';
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
const view = load(VIEW_KEY, { sort: 'title', filter: 'all', fandom: '', rating: '' });
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

const faceStack = (family) => SYSTEM_FACES[family] ?? `'${String(family).replace(/'/g, '')}', Georgia, serif`;

function applyPrefs() {
  const r = document.documentElement;
  if (prefs.theme === 'system' || prefs.theme === 'custom') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', prefs.theme);

  if (prefs.theme === 'custom') {
    r.style.setProperty('--bg', prefs.bg);
    r.style.setProperty('--fg', prefs.fg);
    r.style.setProperty('--pane', prefs.bg);
  } else {
    for (const v of ['--bg', '--fg', '--pane']) r.style.removeProperty(v);
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
let stack = [];

/** Views the tab bar owns; anything deeper hides it and shows Back instead. */
const TABBED = new Set(['home', 'library', 'results']);

function show(name) {
  for (const v of VIEWS) $(`#${v}`).hidden = v !== name;
  $('#back').hidden = stack.length === 0;
  $('#tabs').hidden = !TABBED.has(name);
  for (const b of $$('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === (name === 'results' ? 'search' : name));
  }
  window.scrollTo(0, 0);
}

function go(name) {
  stack.push({ name, scroll: window.scrollY });
  show(name);
}

$('#back').onclick = () => {
  stack.pop();
  const prev = stack.at(-1);
  show(prev?.name ?? 'library');
  if (prev) window.scrollTo(0, prev.scroll);
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

function workRow(w) {
  const node = document.createElement('div');
  node.className = 'work';
  const authors = authorsOf(w.authors);
  const p = progressOf(w);

  node.innerHTML = `
    <h3></h3>
    <div class="by"></div>
    <div class="meta">
      <span class="pill">${fmt(w.words)} words</span>
      <span class="pill">${w.chapter_count} ch</span>
      ${w.complete ? '' : '<span class="pill wip">WIP</span>'}
      ${w.rating ? `<span class="pill">${w.rating}</span>` : ''}
      ${w.marked_later ? '<span class="pill later">later</span>' : ''}
      ${w.has_skin ? '<span class="pill skin">styled</span>' : ''}
    </div>
    ${w.summary ? '<p class="sum"></p>' : ''}
    ${p ? `<div class="bar"><div style="width:${p.pct}%"></div></div>
           <div class="progress-note">${p.read} of ${p.total} chapters read</div>` : ''}`;

  // textContent, never innerHTML: titles and summaries are author-written
  node.querySelector('h3').textContent = w.title ?? '(untitled)';
  node.querySelector('.by').textContent = authors.join(', ') || 'Anonymous';
  if (w.summary) node.querySelector('.sum').textContent = w.summary;
  node.onclick = () => openWork(w.work_id);
  return node;
}

async function loadMore(reset = false) {
  if (loading) return;
  loading = true;
  if (reset) { offset = 0; $('#works').textContent = ''; }
  $('#more').textContent = 'Loading…';
  try {
    const params = new URLSearchParams({
      limit: '50', offset: String(offset), sort: view.sort, filter: view.filter,
    });
    if (view.fandom) params.set('tag', view.fandom);
    if (view.rating) params.set('rating', view.rating);
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

async function buildChips() {
  let facets = null;
  try { facets = await api('/api/facets'); } catch { /* older backend */ }
  const box = $('#chips');
  box.textContent = '';
  for (const [key, label] of Object.entries(FILTER_LABELS)) {
    const n = facets?.counts?.[key];
    if (n === 0 && key !== 'all') continue;              // don't offer an empty filter
    const chip = document.createElement('button');
    chip.className = 'chip' + (view.filter === key ? ' on' : '');
    chip.textContent = n == null ? label : `${label} ${n}`;
    chip.onclick = () => {
      view.filter = key;
      save(VIEW_KEY, view);
      buildChips();
      loadMore(true);
    };
    box.append(chip);
  }
}

$('#sort').value = view.sort;
$('#sort').onchange = () => {
  view.sort = $('#sort').value;
  save(VIEW_KEY, view);
  loadMore(true);
};

/* ----------------------------------------------------------------- search */

let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  // a keystroke is not a query; 42 million words deserve a moment's patience
  searchTimer = setTimeout(() => (q ? runSearch(q) : backToLibrary()), 250);
});

function backToLibrary() {
  stack = [];
  show('home');
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
  try { data = await api('/api/home'); }
  catch (e) { $('#shelves').innerHTML = '<p class="empty"></p>'; $('#shelves .empty').textContent = e.message; return; }

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
      view.filter = ['reading', 'later'].includes(shelf.key) ? shelf.key : 'all';
      view.sort = shelf.key === 'added' ? 'added' : shelf.key === 'long' ? 'words'
        : shelf.key === 'short' ? 'shortest' : view.sort;
      save(VIEW_KEY, view);
      $('#sort').value = view.sort;
      buildChips();
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
  view.fandom = tag ?? '';
  view.rating = rating ?? '';
  view.filter = 'all';
  save(VIEW_KEY, view);
  buildChips();
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
  later.onclick = () => { view.filter = 'later'; view.fandom = ''; save(VIEW_KEY, view);
    buildChips(); loadMore(true); show('library'); };

  const unread = document.createElement('button');
  unread.className = 'start-tile';
  unread.innerHTML = '<b>Never opened</b><span>the ones still waiting</span>';
  unread.onclick = () => { view.filter = 'unread'; view.fandom = ''; save(VIEW_KEY, view);
    buildChips(); loadMore(true); show('library'); };

  row.append(pick, later, unread);
  box.append(row);
}

async function runSearch(q) {
  const box = $('#results');
  box.innerHTML = '<div class="count">Searching…</div>';
  show('results');
  let data;
  try {
    data = await api(`/api/search?q=${encodeURIComponent(q)}`);
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
  const count = document.createElement('div');
  count.className = 'count';
  count.textContent = data.hits.length
    ? `${data.hits.length} passages · ${data.ms}ms`
    : `Nothing found for “${q}”`;
  box.append(count);

  for (const h of data.hits) {
    const node = document.createElement('div');
    node.className = 'hit';
    node.innerHTML = '<div class="where"></div><div class="snip"></div>';
    node.querySelector('.where').textContent =
      `${h.title} — ${authorsOf(h.authors)[0] ?? 'Anonymous'} · chapter ${h.number}`;
    // the snippet is the one place server HTML is trusted: SQLite built it from
    // <mark> delimiters we chose, over text we stored
    node.querySelector('.snip').innerHTML = h.snippet;
    node.onclick = () => openChapter(h.work_id, h.number);
    box.append(node);
  }
  if (stack.at(-1)?.name !== 'results') stack.push({ name: 'results', scroll: 0 });
}

/* ----------------------------------------------------------------- detail */

let currentWork = null;

async function openWork(workId) {
  const w = await api(`/api/works/${workId}`);
  currentWork = w;
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

  const list = document.createElement('div');
  list.className = 'chapters';
  for (const c of w.chapters) {
    const b = document.createElement('button');
    b.className = saved?.chapter === c.number ? 'at' : '';
    b.textContent = `${c.number}. ${c.title ?? 'Chapter ' + c.number} · ${fmt(c.words)} words`;
    b.onclick = () => openChapter(workId, c.number);
    list.append(b);
  }
  box.append(list);
  go('detail');
}

/* ----------------------------------------------------------------- reader */

let current = { workId: null, chapter: 1, count: 1 };

async function openChapter(workId, number) {
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

  if (stack.at(-1)?.name !== 'reader') go('reader'); else show('reader');

  const saved = positions[workId];
  window.scrollTo(0, saved?.chapter === number && saved.y ? saved.y : 0);
  updateProgress();
}

$('#prev').onclick = () => openChapter(current.workId, current.chapter - 1);
$('#next').onclick = () => openChapter(current.workId, current.chapter + 1);

$('#chappos').onclick = () => {
  if (!currentWork) return;
  const list = $('#chapter-list');
  list.textContent = '';
  for (const c of currentWork.chapters) {
    const b = document.createElement('button');
    b.className = c.number === current.chapter ? 'at' : '';
    b.textContent = `${c.number}. ${c.title ?? 'Chapter ' + c.number}`;
    b.onclick = () => { $('#chapters-dialog').close(); openChapter(current.workId, c.number); };
    list.append(b);
  }
  $('#chapters-dialog').showModal();
};

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
    positions[current.workId] = {
      chapter: current.chapter, y: Math.round(window.scrollY), at: Date.now(),
    };
    save(POS_KEY, positions);
  }, 400);
}, { passive: true });

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
    stack = [];
    const tab = b.dataset.tab;
    if (tab === 'search') { show('results'); $('#q').focus(); return; }
    show(tab);
    if (tab === 'library' && !offset) loadMore(true);
    if (tab === 'home') { buildHome(); buildStartHere(); }
  };
}

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
    $('#setup-hint').textContent = status.path ? `It will be copied to ${status.path}` : '';
    show('setup');
    return;
  }
  if (!status.fts5) toast('This device\'s SQLite has no FTS5 — search is unavailable');
  show('home');
  await adoptImportedTheme();
  await Promise.all([buildHome(), buildStartHere(), buildChips()]);
}

start();
