/**
 * Where the app's data comes from.
 *
 * One client, two backends. In the APK it runs the queries itself against
 * Android's SQLite through the native bridge; against the dev server it talks
 * HTTP. Everything above this file is identical either way, so the reader can
 * be developed in a browser and shipped without changing a line of it.
 */

import { fetchRecoverableWork, resolveRecoverableChapter } from './core/ao3/recovery.js';
import { createArchiveTransport, archiveRetryAfter, createPublicRecoveryRequests } from './archive-transport.js';
import { createReadRoutes, createAsyncReadRoutes } from './core/routes.js';
import { parseListing } from './core/ao3/parse.js';
import { workPage, linkTarget, seriesPage, ORIGIN } from './core/ao3/urls.js';
import { parseForm, encodeForm } from './core/ao3/forms.js';
import { refusal } from './core/ao3/refusal.js';
import { htmlToText, countWords } from './core/epub.js';

const native = typeof window !== 'undefined' ? window.ArchiveNative : undefined;
export const isNative = Boolean(native);

// Older shells and the browser dev server retain their existing HTTP adapter.
const archiveTransport = createArchiveTransport({
  native: isNative && nativeStatus().nativeArchiveRequests === true ? native : null,
  fetchPage: url => fetch(`/__net/?url=${encodeURIComponent(url)}`),
});
const publicRecoveryRequest = createPublicRecoveryRequests(url => archiveTransport.requestPublic(url));
export const archiveRequest = async (url) => {
  const response = await archiveTransport.request(url);
  if (response.status === 429 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('archive-rate-limit', { detail: archiveRetryAfter(response.headers) }));
  }
  return response;
};
export const pollArchiveRequests = () => archiveTransport.poll();
if (typeof window !== 'undefined') window.__pollArchiveRequests = pollArchiveRequests;

/**
 * One read-only query through the bridge.
 *
 * Android binds selection arguments as text — its rawQuery takes String[] and
 * nothing else — and SQLite rejects text where it needs an integer, so a
 * bound `LIMIT ?` fails with a datatype mismatch. Counts are therefore
 * validated as integers and written into the SQL by `lim()` below, never
 * bound. Everything a reader can influence still goes through binding.
 */
function sql(query, args = []) {
  const raw = native.query(query, JSON.stringify(args.map(String)));
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(`bridge returned unparseable JSON: ${String(raw).slice(0, 120)}`); }
  if (result.error) throw new Error(`${result.error} — in: ${query.trim().slice(0, 90)}…`);
  return result.rows;
}

const parseAuthors = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

const LOCAL = createReadRoutes(sql);

/**
 * The same query, without the page standing still for it.
 *
 * `native.query` returns when SQLite does, and nothing else in the page runs
 * until then. Where the shell offers it, the query is handed over instead:
 * the shell runs it on a thread of its own, says when it is done, and the
 * rows are collected then.
 *
 * It falls back rather than failing. A shell without the method, a call that
 * throws, or an answer that does not come in time each send that query down
 * the old synchronous path — and after one missed answer, every later one
 * too, so a fault here costs one pause and never a library that will not open.
 */
const QUERY_WAIT_MS = 6000;
const waitingQueries = new Map();
let queryId = 0;
let asyncQueries = Boolean(native?.queryAsync && native?.takeQuery);

function parseRows(raw, query) {
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(`bridge returned unparseable JSON: ${String(raw).slice(0, 120)}`); }
  if (result.error) throw new Error(`${result.error} — in: ${query.trim().slice(0, 90)}…`);
  return result.rows;
}

if (typeof window !== 'undefined') {
  window.__queryDone = (id) => {
    const wait = waitingQueries.get(id);
    if (!wait) return;
    waitingQueries.delete(id);
    clearTimeout(wait.timer);
    try { wait.resolve(parseRows(native.takeQuery(id), wait.query)); }
    catch (e) { wait.reject(e); }
  };
}

function sqlAsync(query, args = []) {
  if (!asyncQueries) return sql(query, args);
  return new Promise((resolve, reject) => {
    const id = `q${++queryId}`;
    const synchronously = () => {
      asyncQueries = false;
      waitingQueries.delete(id);
      try { resolve(sql(query, args)); } catch (e) { reject(e); }
    };
    const timer = setTimeout(synchronously, QUERY_WAIT_MS);
    waitingQueries.set(id, { resolve, reject, query, timer });
    try {
      native.queryAsync(id, query, JSON.stringify(args.map(String)));
    } catch {
      clearTimeout(timer);
      synchronously();
    }
  });
}
const LATER = createAsyncReadRoutes(sqlAsync);

export async function api(path) {
  if (!isNative) {
    const res = await fetch(path);
    return res.json();
  }

  const answer = await LATER.read(path);
  if (answer !== undefined) return answer;
  const p = new URL(path, 'https://local/').pathname;

  // the imported Archive Reader theme is a development convenience only
  if (p === '/api/prefs') return { prefs: null };

  throw new Error(`no route for ${p}`);
}

/**
 * What a fetched work looks like on its way into storage.
 *
 * Built here rather than in the shell so the shape is decided once, in the
 * same code that parsed it — the native side writes what it is given and makes
 * no decisions of its own about what a work is.
 */
function payloadFor(workId, w) {
  const meta = w.meta ?? {};
  const tags = {};
  for (const [field, kind] of [
    ['fandoms', 'fandom'], ['relationships', 'relationship'], ['characters', 'character'],
    ['freeform', 'freeform'], ['warnings', 'warning'], ['categories', 'category'],
    ['collections', 'collection'],
  ]) {
    if (meta[field]?.length) tags[kind] = meta[field];
  }

  return {
    workId,
    title: w.title ?? null,
    authors: JSON.stringify(w.authors ?? []),
    summary: w.summary ?? null,
    rating: meta.rating ?? null,
    language: meta.language ?? null,
    published: meta.published ?? null,
    updated: meta.updated ?? null,
    complete: Boolean(meta.complete),
    words: meta.words ?? 0,
    chaptersPlanned: meta.chaptersPlanned ?? null,
    skin_css: w.skinCss ?? null,
    // parsed all along and, until now, dropped on the floor
    kudos: meta.kudos ?? null,
    bookmarkCount: meta.bookmarkCount ?? null,
    hits: meta.hits ?? null,
    tags,
    chapters: w.chapters.map((c) => {
      const display = c.block ?? c.html ?? '';
      const text = htmlToText(c.html || display);
      return { title: c.title ?? null, html: display, text, words: countWords(text) };
    }),
  };
}

/**
 * Add a work from a link.
 *
 * In the app the page fetches through the shell's proxy — AO3 sends no CORS
 * headers — parses with the same code the tooling uses, and hands the result
 * to the shell to store. Against the dev server the whole job happens there.
 */
/**
 * Add whatever a link points at.
 *
 * The archive names works in more shapes than one, and they are not
 * interchangeable. A chapter id is not a work id — fetching /works/<chapter
 * id> would quietly return a different story rather than fail — and a series
 * names many works at once. Where the link does not carry a work id, the
 * archive is asked rather than guessed at.
 */
export async function addWork(input) {
  const target = linkTarget(input);

  if (target.kind === 'external') {
    throw new Error('That is a link to a work hosted elsewhere; the archive only holds its details');
  }
  if (target.kind === 'unknown') {
    throw new Error('That link does not name a work');
  }

  if (!isNative) {
    const res = await fetch(`/api/add?url=${encodeURIComponent(input)}`, { method: 'POST' });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    return out;
  }

  if (target.kind === 'series') return addSeries(target.seriesId);

  const workId = target.kind === 'chapter'
    ? await workIdForChapter(target.chapterId)
    : target.workId;

  return fetchAndSave(workId);
}

/**
 * Which work owns this chapter.
 *
 * Only the archive knows. A chapter page always links back to the work it
 * belongs to, so the id is read from the page rather than from the URL that
 * was followed to reach it — the shell's proxy reports its own address, not
 * the one the archive redirected to.
 */
async function workIdForChapter(chapterId) {
  return resolveRecoverableChapter(chapterId, {
    request: archiveRequest,
    requestPublic: publicRecoveryRequest,
  });
}

/**
 * Every work in a series, one at a time.
 *
 * Deliberately sequential: a series can be long, and the archive is quick to
 * throttle anything that asks for a lot at once. One failure does not abandon
 * the rest — a series with a single restricted work in it should still bring
 * back the others.
 */
async function addSeries(seriesId) {
  const res = await archiveRequest(seriesPage(seriesId));
  const body = await res.text();
  if (!res.ok) throw new Error(`The archive answered ${res.status} for that series`);

  const workIds = [...new Set(parseListing(body).works.map((w) => w.workId).filter(Boolean))]
    .map(String);
  if (!workIds.length) throw new Error('That series has no works we can see');

  /*
   * A plan, not a download.
   *
   * This used to fetch every work in the series itself, one after another with
   * nothing between them — sequential, which is not the same as paced. A long
   * series therefore asked the archive for a work the instant the last one
   * finished, and walked straight through the rate the rest of the app is so
   * careful about. Handing back the list lets it go through the same queue as
   * everything else, which paces it, shows it, and can pause it.
   */
  return { kind: 'series', seriesId, workIds, count: workIds.length };
}

/** One work: fetch the whole thing, parse it, hand it to the shell to store. */
async function fetchAndSave(workId) {
  const recovered = await fetchRecoverableWork(workId, {
    request: archiveRequest,
    requestPublic: publicRecoveryRequest,
    onProgress: message => window.dispatchEvent(new CustomEvent('archive-recovery-progress', { detail: { workId, message } })),
  });
  const w = recovered.work;
  const payload = { ...payloadFor(workId, w), source: recovered.source, sourceUrl: recovered.sourceUrl };
  const out = JSON.parse(native.saveWork(JSON.stringify(payload)));
  if (out.error) throw new Error(out.error);
  return { workId, source: recovered.source, title: w.title, authors: w.authors, chapters: w.chapters.length, words: w.meta?.words ?? 0 };
}

/** What the shell can tell us about the archive it opened. */
export function nativeStatus() {
  if (!isNative) return { hasDatabase: true, search: true, dev: true };
  try { return JSON.parse(native.status()); } catch { return { hasDatabase: false, search: false }; }
}

/**
 * Write the library out to a file the reader chooses.
 *
 * Only the shell can do this: the page has no way to reach the filesystem, and
 * the database is the app's entire contents rather than something it can
 * reassemble. Outside the APK there is nothing to export — the dev server
 * already reads a file sitting on disk.
 */
export function exportDatabase() {
  if (!isNative) return false;
  native.exportDatabase();
  return true;
}

/** Bytes on disk, so the page can say what a backup will cost. */
export function databaseSize() {
  if (!isNative) return 0;
  try { return Number(native.databaseSize()) || 0; } catch { return 0; }
}

/**
 * A tick at the moment something commits.
 *
 * The shell routes this through the system's own haptic setting, so a phone
 * with haptics turned off gets nothing without the app having to ask.
 */
export function haptic(kind = 'tick') {
  if (!isNative) return;
  try { native.haptic(kind); } catch { /* a device without an actuator */ }
}

/**
 * Open a page on the archive in a browser, deliberately not in here.
 *
 * The app claims archive links now, so an ordinary link would be offered
 * straight back to it and the reader would arrive where they already were.
 * The shell excludes this app from the chooser.
 */
export function openOnArchive(path) {
  if (!isNative) { window.open(new URL(path, ORIGIN).toString(), '_blank', 'noopener'); return; }
  native.openInBrowser(path);
}

/**
 * Record works a listing described, without fetching any of them.
 *
 * One request describes twenty works; fetching twenty costs twenty. This is
 * how an author's whole catalogue becomes browsable for the price of reading
 * their index.
 */
export function saveStubs(works) {
  if (!isNative) return { added: 0 };
  const out = JSON.parse(native.saveStubs(JSON.stringify(works)));
  if (out.error) throw new Error(out.error);
  return out;
}

/**
 * Ask the shell to fetch the next picture this work is missing.
 *
 * No address crosses the bridge: the shell reads the next one out of the
 * chapter text it already holds. Returns the url it dealt with and the hash it
 * was stored under, or done when there is nothing left.
 */
export async function fetchNextImage(workId, { chapter = 1, proxy = true } = {}) {
  if (!isNative) return { done: true };
  const params = new URLSearchParams({ workId: String(workId), chapter: String(chapter), proxy: String(proxy) });
  const response = await fetch(`/__images/next?${params}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Images could not be loaded');
  return response.json();
}

export async function retryImages(workId, chapter = 1, broken = []) {
  if (!isNative) throw new Error('Image recovery needs the Android app');
  const params = new URLSearchParams({ workId: String(workId), chapter: String(chapter), broken: JSON.stringify(broken) });
  const response = await fetch(`/__images/retry?${params}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Images could not be retried');
  const out = await response.json();
  if (out.error) throw new Error(out.error);
  return out;
}

export function importDatabase() {
  if (isNative) native.importDatabase();
}

/** Choose a shelf of EPUBs. The shell calls back with how many. */
export function pickEpubs() {
  if (!isNative) throw new Error('Bringing in books needs the app');
  native.pickEpubs();
}

/** One chosen book, as bytes. Read on demand rather than all at once. */
export function readPickedEpub(at) {
  if (!isNative) return null;
  const base64 = native.readPickedEpub(Number(at));
  if (!base64) return null;
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pickedEpubName(at) {
  if (!isNative) return '';
  try { return native.pickedEpubName(Number(at)) || ''; } catch { return ''; }
}

/**
 * A book read off a file, handed to the library to place.
 *
 * The library decides whether it is the work or a version of one: it knows
 * whether the archive's copy is already here, and this does not.
 */
export function saveEpub(payload) {
  if (!isNative) throw new Error('Bringing in books needs the app');
  const out = JSON.parse(native.saveEpub(JSON.stringify(payload)));
  if (out.error) throw new Error(out.error);
  return out;
}

/** A link the shell was opened with, if it arrived before the page was ready. */
/** Where an intent asked the app to land, if it arrived before the page did. */
export function pendingOpen() {
  if (!isNative) return '';
  try { return native.takePendingOpen() || ''; } catch { return ''; }
}

export function pendingLink() {
  if (!isNative) return '';
  try { return native.takePendingLink() || ''; } catch { return ''; }
}

/**
 * Record where the reader has got to.
 *
 * One store, not two: everything that shows progress reads the same table.
 * Failures are swallowed — losing a scroll position is not worth interrupting
 * somebody's reading with an error.
 */
/**
 * Say the work was opened, without saying where in it you are.
 *
 * A peek from a search result must not move the bookmark, but it is still
 * reading and still belongs at the front of Continue reading.
 */
/**
 * A note kept beside the library rather than beside the browser.
 *
 * Used for the download queue, which is not a preference: it is a record of
 * work owed and work done, and it belongs with the works — surviving cleared
 * site data and travelling in a backup.
 */
/**
 * Tell the shell there is work going on, or that there is not.
 *
 * The queue runs in this page; this only asks Android to keep the app running
 * while it has something to do, and to say so where it can be seen.
 */
/**
 * Say that work is going on, and which state it is in.
 *
 * The state is what the notification is allowed to offer. Work in progress
 * offers Pause; work that has been paused offers Resume and Stop, and stays
 * on screen — pressing Pause used to take the whole notification down, so the
 * only sign the app had stopped halfway through a catalogue was the absence
 * of something, and the only way back was to go and find the Activity screen.
 */
export function keepWorking(summary, state = 'working') {
  if (!isNative) return;
  try { native.keepWorking(String(summary), String(state)); } catch { /* the work carries on */ }
}

export function stopWorking() {
  if (!isNative) return;
  try { native.stopWorking(); } catch { /* nothing to take down */ }
}

/**
 * The run is over: one notification that can be dismissed, then stand down.
 *
 * An hour of downloading that ends in silence is indistinguishable from an
 * hour of downloading that was killed. And what never arrived is worth
 * saying, because that is the only moment somebody would think to ask for it
 * again — by which time the ongoing notification has gone.
 */
export function workFinished(summary, attention = false) {
  if (!isNative) return;
  try { native.workFinished(String(summary), Boolean(attention)); } catch { /* it ended anyway */ }
}

export function saveMeta(key, value) {
  if (!isNative) return false;
  try {
    const out = JSON.parse(native.saveMeta(String(key), String(value)));
    return !out.error;
  } catch {
    return false;
  }
}

export function readMeta(key) {
  if (!isNative) return null;
  try {
    return sql('SELECT value FROM meta WHERE key = ?', [key])[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Record that a work is one of yours on the archive.
 *
 * Separate from downloading it. A work already in the library that you
 * bookmarked today is a new bookmark and needs no fetching, and the sync had
 * no way to write that down.
 */
/**
 * Which works are your bookmarks now — all of them, as one answer.
 *
 * Removal cannot be seen a page at a time, because it is the absence of
 * something. Only membership changes: a work you unbookmarked is not a work
 * you asked to lose.
 */
/**
 * Make an empty library, so a first run does not need a file from elsewhere.
 */
export function createDatabase() {
  if (!isNative) throw new Error('Only the app can make a library');
  const out = JSON.parse(native.createDatabase());
  if (out.error) throw new Error(out.error);
  return out;
}

export function reconcileBookmarks(workIds) {
  if (!isNative) return { kept: 0, dropped: 0 };
  const out = JSON.parse(native.reconcileBookmarks(JSON.stringify(workIds.map(String))));
  if (out.error) throw new Error(out.error);
  return out;
}

export function markBookmarked(workId) {
  if (!isNative) return false;
  try {
    native.markWork(String(workId), 'in_bookmarks', true);
    return true;
  } catch {
    return false;
  }
}

export async function recordVisit(workId, visitId) {
  if (!visitId) return;
  if (isNative) {
    const out = JSON.parse(native.recordVisit(String(workId), String(visitId)));
    if (out.error) throw new Error(out.error);
    return;
  }
  const response = await fetch(`/api/visit?${new URLSearchParams({ workId, visitId })}`, { method: 'POST' });
  if (!response.ok) throw new Error('Reading visit could not be saved');
}

export function saveHistory(works, syncedAt) {
  if (!isNative) throw new Error('History syncing needs the Android app');
  const out = JSON.parse(native.saveHistory(JSON.stringify(works), syncedAt));
  if (out.error) throw new Error(out.error);
  return out.updated;
}

export async function markOpened(workId) {
  try {
    if (isNative) { native.markOpened(String(workId)); return; }
    await fetch(`/api/opened?workId=${encodeURIComponent(workId)}`, { method: 'POST' });
  } catch { /* the reader carries on regardless */ }
}

export async function saveProgress(workId, chapter, offset) {
  try {
    if (isNative) {
      native.saveProgress(String(workId), Number(chapter), Number(offset) || 0);
      return;
    }
    await fetch(`/api/progress?workId=${encodeURIComponent(workId)}`
      + `&chapter=${Number(chapter)}&offset=${Number(offset) || 0}`, { method: 'POST' });
  } catch { /* the reader carries on regardless */ }
}

/**
 * Finished, said rather than inferred.
 *
 * Progress is stored as chapters completed, and a chapter is only complete
 * once you have left it: reading chapter 6 of 6 stores five. Nothing ever
 * stored the sixth, so a work read from first line to last inside this app
 * stayed "reading" for ever, and the finished count and words read on Home
 * were quietly short by every work anybody had actually finished here.
 *
 * The reader says this when it reaches the end of the last chapter, and the
 * work page offers it directly for the ones this app never saw you read.
 */
export async function restartReading(workId) {
  const out = isNative ? JSON.parse(native.restartReading(String(workId)))
    : await fetch(`/api/restart?workId=${encodeURIComponent(workId)}`, { method: 'POST' }).then(r => r.json());
  if (out.error) throw new Error(out.error);
  return out;
}

export async function markFinished(workId, done = true) {
  try {
    if (isNative) { native.markFinished(String(workId), !!done); return; }
    await fetch(`/api/finished?workId=${encodeURIComponent(workId)}&done=${done ? 1 : 0}`,
      { method: 'POST' });
  } catch { /* the reader carries on regardless */ }
}

/**
 * Remove a work and remember that it went.
 *
 * The remembering is the half that matters. Taking the rows out is easy and
 * every listing this app reads would put them straight back — a bookmark
 * sync, an author walk, the backlog of works described but not held — so a
 * deletion without a tombstone is a work that disappears until the next time
 * anybody looks at the archive.
 */
export async function deleteWork(workId) {
  if (isNative) {
    const out = JSON.parse(native.deleteWork(String(workId)));
    if (out.error) throw new Error(out.error);
    return out;
  }
  const res = await fetch(`/api/delete?workId=${encodeURIComponent(workId)}`, { method: 'POST' });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}

/**
 * Whose bookmark list these works are in.
 *
 * Recorded in the same pass that saves the stubs from a bookmark walk, so it
 * costs no requests and changes nothing about what downloads or when. The
 * fact was always on the page being read; it was simply thrown away.
 */
export async function noteBookmarkedBy(person, workIds) {
  const ids = [...new Set(workIds.map(String))];
  if (!ids.length) return { ok: true };
  if (isNative) {
    const out = JSON.parse(native.noteBookmarkedBy(String(person), JSON.stringify(ids)));
    if (out.error) throw new Error(out.error);
    return out;
  }
  const res = await fetch(`/api/bookmarked-by?person=${encodeURIComponent(person)}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ids) });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}

/** A whole author's worth, in one transaction rather than hundreds. */
export async function deleteWorks(workIds) {
  const ids = workIds.map(String);
  if (!ids.length) return { deleted: 0 };
  if (isNative) {
    const out = JSON.parse(native.deleteWorks(JSON.stringify(ids)));
    if (out.error) throw new Error(out.error);
    return out;
  }
  for (const id of ids) await deleteWork(id);
  return { deleted: ids.length };
}

/** Let it be fetched again. The work is gone; this drops the refusal. */
export async function allowAgain(workId) {
  if (isNative) {
    const out = JSON.parse(native.allowAgain(String(workId)));
    if (out.error) throw new Error(out.error);
    return out;
  }
  const res = await fetch(`/api/allow?workId=${encodeURIComponent(workId)}`, { method: 'POST' });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}

/**
 * Never fetch them again, and stop showing what is solely theirs.
 *
 * A work with another author on it stays: blocking somebody should not cost
 * you a work you like that they happened to write half of.
 */
export async function blockAuthor(name) {
  if (isNative) {
    const out = JSON.parse(native.blockAuthor(String(name)));
    if (out.error) throw new Error(out.error);
    return out;
  }
  const res = await fetch(`/api/block?name=${encodeURIComponent(name)}`, { method: 'POST' });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}

/** Undo it. What is theirs is shown again; nothing is fetched by this. */
export async function unblockAuthor(name) {
  if (isNative) {
    const out = JSON.parse(native.unblockAuthor(String(name)));
    if (out.error) throw new Error(out.error);
    return out;
  }
  const res = await fetch(`/api/unblock?name=${encodeURIComponent(name)}`, { method: 'POST' });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}

/* --------------------------------------------------------------- signing in */

/**
 * Signing in happens on the archive's own page, in a window of its own.
 *
 * Nothing here ever sees a password: the shell opens the real login form over
 * HTTPS with no bridge attached, and what comes back is a session cookie the
 * proxy attaches to archive requests. It expires by itself and is forgotten on
 * sign out.
 */
export function signIn() {
  if (!isNative) throw new Error('Signing in is only available in the app');
  native.signIn();
}

export function signOut() {
  if (isNative) native.signOut();
}

export function signedIn() {
  if (!isNative) return false;
  try { return Boolean(native.signedIn()); } catch { return false; }
}

/* ------------------------------------------------------ acting on the archive
 *
 * Kudos, bookmarks and comments are writes performed as the signed-in reader,
 * and they go through a bridge method rather than the usual proxy: Android
 * never hands a request body to shouldInterceptRequest, so the proxy the rest
 * of the app uses can only ever perform a GET.
 *
 * None of the field names are hardcoded. Each of these reads the form the
 * archive itself served and submits it with the reader's values substituted,
 * so a renamed field stays working and a missing form fails loudly instead of
 * posting something malformed.
 */

/** GET a page through the ordinary proxy and hand back its HTML. */
async function page(url) {
  const res = await archiveRequest(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`The archive answered ${res.status}`);
  return body;
}

/**
 * POST a form, as the signed-in reader.
 *
 * A path, never a URL: the shell holds the host as a constant, so nothing
 * crossing the bridge can decide where a signed-in write is sent. A form
 * action is usually a path already; one written absolutely is reduced to its
 * path here, and anything pointing off the archive has nowhere to go.
 */
async function submit(action, fields, refererPath) {
  const raw = native.archivePost(pathOnArchive(action), encodeForm(fields), refererPath);
  const out = JSON.parse(raw);
  if (out.error) throw new Error(out.error);
  return out;
}

/** The path a form action names, refusing anything that leaves the archive. */
function pathOnArchive(action) {
  const url = new URL(action, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error('That form points somewhere other than the archive');
  return `${url.pathname}${url.search}`;
}

/** The first of several shapes the form might be identified by. */
function findForm(html, matchers) {
  for (const m of matchers) {
    const form = parseForm(html, m);
    if (form) return form;
  }
  return null;
}

function requireSignedIn() {
  if (!isNative) throw new Error('Acting on the archive needs the app');
  if (!signedIn()) throw new Error('Sign in to the archive first');
}

/**
 * Leave kudos.
 *
 * The archive accepts them once per work per person and answers a second
 * attempt with an error rather than a success, which is why this is recorded
 * locally: there is no way to ask afterwards whether they were left.
 */
export async function leaveKudos(workId) {
  requireSignedIn();
  const referer = `/works/${Number(workId)}`;
  const html = await page(workPage(workId));
  const form = findForm(html, ['id="new_kudo"', 'action="/kudos"', 'id="kudo_submit"']);
  if (!form) throw new Error('The archive did not offer a kudos form on that work');

  const res = await submit(form.action, form.fields, referer);
  /* The archive says so in the page it returns rather than in the status: a
     duplicate is an error, and an error that says "already left kudos" is the
     one outcome worth treating as success. */
  const already = /already left kudos/i.test(res.body ?? '');
  if (!already && res.status >= 400) throw new Error(refusal(res, 'The archive refused the kudos'));

  native.markWork(String(workId), 'kudos_given', true);
  return { workId, already };
}

/**
 * Bookmark a work.
 *
 * The form lives on its own page rather than on the work, and carries the
 * reader's pseud and their defaults — which is exactly why it is read rather
 * than reconstructed. An unticked box is left out, because submitting one is
 * how a private bookmark quietly becomes a public one.
 */
export async function bookmarkWork(workId, { notes = '', tags = '', isPrivate = false, rec = false } = {}) {
  requireSignedIn();
  const referer = `/works/${Number(workId)}`;
  /* view_adult, for the same reason workPage sends it: without it a Mature
     work answers with the consent interstitial instead of the page asked for,
     and that interstitial carries a form of its own. */
  const html = await page(`${ORIGIN}/works/${Number(workId)}/bookmarks/new?view_adult=true`);
  const form = findForm(html, ['id="bookmark-form"', 'id="new_bookmark"',
    `action="/works/${Number(workId)}/bookmarks"`]);
  if (!form) throw new Error('The archive did not offer a bookmark form for that work');

  const fields = { ...form.fields };
  const set = (suffix, value) => {
    const key = Object.keys(fields).find((k) => k.endsWith(suffix))
      ?? `bookmark[${suffix.replace(/^\[|\]$/g, '')}]`;
    if (value === false) delete fields[key];
    else fields[key] = value === true ? '1' : value;
  };
  if (notes) set('[bookmarker_notes]', notes);
  if (tags) set('[tag_string]', tags);
  set('[private]', isPrivate);
  set('[rec]', rec);

  const res = await submit(form.action, fields, referer);
  if (res.status >= 400) throw new Error(refusal(res, 'The archive refused the bookmark'));

  native.markWork(String(workId), 'in_bookmarks', true);
  if (rec) native.markWork(String(workId), 'rec', true);
  return { workId, rec };
}

/**
 * Leave a comment.
 *
 * Refuses an empty one before anything is sent: an empty comment is a form
 * error round-trip that tells the reader nothing they did not already know.
 */
export async function commentOnWork(workId, text) {
  requireSignedIn();
  const content = String(text ?? '').trim();
  if (!content) throw new Error('There is nothing to say yet');

  const referer = `/works/${Number(workId)}`;
  const html = await page(workPage(workId));
  const form = findForm(html, ['id="new_comment"',
    `action="/works/${Number(workId)}/comments"`]);
  if (!form) throw new Error('That work does not take comments');

  const fields = { ...form.fields };
  const key = Object.keys(fields).find((k) => k.endsWith('[comment_content]'))
    ?? 'comment[comment_content]';
  fields[key] = content;

  const res = await submit(form.action, fields, referer);
  if (res.status >= 400) throw new Error(refusal(res, 'The archive refused the comment'));
  return { workId };
}

/** A notification command delivered while Android is restoring a closed app. */
export function takeDownloadCommand() {
  return isNative && native.takeDownloadCommand ? native.takeDownloadCommand() : '';
}

export function downloadsReady(pending) {
  if (isNative && native.downloadsReady) native.downloadsReady(Boolean(pending));
}

/** Numeric, local-only diagnostics. Never send exception messages or library content. */
export function downloadDiagnostic(event, values = {}) {
  try { if (isNative && native.downloadDiagnostic) native.downloadDiagnostic(event, JSON.stringify(values)); }
  catch { /* Recording must not interrupt work. */ }
}
export function exportDownloadDiagnostics() {
  if (!isNative || !native.exportDownloadDiagnostics) return false;
  native.exportDownloadDiagnostics();
  return true;
}
