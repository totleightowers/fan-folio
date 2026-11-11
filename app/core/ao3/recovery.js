import { workPage, chapterUrl } from './urls.js';
import { parseWorkPage } from './parse.js';

// Public reads only. These origins never receive archive credentials.
export const RECOVERY_ORIGINS = [
  'https://archiveofourown.gay',
  'https://archive.transformativeworks.org',
];

export function snapshotForWork(snapshot, workId) {
  return snapshotForPath(snapshot, `/works/${workId}`);
}

function snapshotForPath(snapshot, path) {
  if (!snapshot?.available || String(snapshot.status) !== '200') return null;
  try {
    const url = new URL(snapshot.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'web.archive.org'
      || url.port || url.username || url.password) return null;
    const match = /^\/web\/(\d{14})(?:id_)?\/(https?:\/\/.*)$/.exec(url.pathname + url.search);
    if (!match) return null;
    const original = new URL(match[2]);
    if (original.hostname !== 'archiveofourown.org' || original.port || original.username || original.password
      || original.pathname !== path) return null;
    for (const key of original.searchParams.keys()) if (!['view_full_work', 'view_adult'].includes(key)) return null;
    return { url: `https://web.archive.org/web/${match[1]}id_/${original.href}`, timestamp: match[1] };
  } catch { return null; }
}

/** Reject interstitials, a different work and captures missing posted chapters. */
export function recoveredWork(body, workId) {
  const work = parseWorkPage(body);
  const canonical = body.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["'][^"']*\/works\/(\d+)/i)?.[1];
  if (String(work.workId || canonical || '') !== String(workId) || !work.title || !work.chapters.length) return null;
  if (!work.meta?.chapters || work.meta.chapters !== work.chapters.length) return null;
  if (work.chapters.some((ch, i) => ch.number !== i + 1 || !ch.html?.trim())) return null;
  return work;
}

/** AO3 first, bounded alternate reads, then the newest usable Wayback capture. */
export async function fetchRecoverableWork(workId, { request, requestPublic, onProgress = () => {} }) {
  if (!/^\d+$/.test(String(workId))) throw new Error('Invalid work ID');
  const original = workPage(workId);
  onProgress('Checking AO3…');
  let primary, body = '', problem;
  try { primary = await request(original); body = await primary.text(); }
  catch (e) { problem = e; }
  if (primary?.ok) {
    const work = parseWorkPage(body, { workId });
    if (work.title && work.chapters.length && (!work.meta.chapters || work.meta.chapters === work.chapters.length)) {
      return { work, source: 'ao3', sourceUrl: original };
    }
  }
  // Do not turn authentication refusals into anonymous mirror requests.
  if (primary?.status === 401) {
    throw new Error('That work is restricted — sign in to the archive first');
  }
  // Respect rate limits: do not re-route a throttled live request to AO3 aliases.
  if (primary?.status !== 429) {
    for (const origin of RECOVERY_ORIGINS) {
      onProgress(`Checking ${new URL(origin).hostname}…`);
      try {
        const sourceUrl = original.replace('https://archiveofourown.org', origin);
        const res = await requestPublic(sourceUrl);
        if (res.status === 429) break;
        if (!res.ok) continue;
        const work = recoveredWork(await res.text(), workId);
        if (work) return { work, source: 'mirror', sourceUrl };
      } catch { /* Try the next bounded source. */ }
    }
  }
  onProgress('Checking the Wayback Machine…');
  const captures = new Set();
  // A capture of the full-work URL is preferable; the plain URL may be a one-shot.
  for (const url of [original, `https://archiveofourown.org/works/${workId}?view_full_work=true`, `https://archiveofourown.org/works/${workId}`]) {
    try {
      const available = await requestPublic(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
      if (available.status === 429) break;
      if (!available.ok) continue;
      const snapshot = snapshotForWork(JSON.parse(await available.text()).archived_snapshots?.closest, workId);
      if (!snapshot || captures.has(snapshot.url)) continue;
      captures.add(snapshot.url);
      const res = await requestPublic(snapshot.url);
      if (res.status === 429) break;
      if (!res.ok) continue;
      const work = recoveredWork(await res.text(), workId);
      if (work) return { work, source: 'wayback', sourceUrl: snapshot.url, snapshotAt: snapshot.timestamp };
    } catch { /* A failed lookup does not erase the original failure. */ }
  }
  let reason = primary ? `AO3 answered ${primary.status}` : problem?.message || 'AO3 could not be reached';
  if (primary?.status === 502) reason = 'The app could not reach the archive';
  if (primary?.status === 525) reason = 'The archive answered 525 — Cloudflare could not establish a secure connection to AO3';
  if (primary?.status === 403 && primary.headers?.get?.('CF-Mitigated') === 'challenge') reason = 'Cloudflare verification is required — open archive sign-in to complete it';
  if (primary?.ok) reason = 'No complete work was returned. The work may be restricted, deleted, or need a login';
  throw new Error(`${reason}. No complete readable copy was found on the alternate sites or Wayback Machine. Your saved text has been kept.`);
}

/** Chapter-only links must resolve their owning work before downloading it. */
export async function resolveRecoverableChapter(chapterId, { request, requestPublic }) {
  if (!/^\d+$/.test(String(chapterId))) throw new Error('Invalid chapter ID');
  const original = chapterUrl(chapterId);
  const identify = async res => {
    if (!res.ok) return null;
    const work = parseWorkPage(await res.text());
    return work.title && work.chapters.length && /^\d+$/.test(work.workId || '') ? work.workId : null;
  };
  let primary;
  try { primary = await request(original); const id = await identify(primary); if (id) return id; } catch { /* recovery below */ }
  if (primary?.status === 401) throw new Error('That chapter is restricted — sign in to the archive first');
  if (primary?.status !== 429) for (const origin of RECOVERY_ORIGINS) {
    try {
      const res = await requestPublic(original.replace('https://archiveofourown.org', origin));
      if (res.status === 429) break;
      const id = await identify(res); if (id) return id;
    } catch { /* next source */ }
  }
  for (const url of [original, `https://archiveofourown.org/chapters/${chapterId}`]) {
    try {
      const res = await requestPublic(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
      if (res.status === 429) break;
      if (!res.ok) continue;
      const capture = snapshotForPath(JSON.parse(await res.text()).archived_snapshots?.closest, `/chapters/${chapterId}`);
      if (!capture) continue;
      const page = await requestPublic(capture.url);
      if (page.status === 429) break;
      const id = await identify(page); if (id) return id;
    } catch { /* next lookup */ }
  }
  throw new Error('Could not identify the work from that chapter on AO3, alternate sites or Wayback. Try a link containing /works/ instead.');
}
