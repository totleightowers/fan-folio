/**
 * Fetch the author's work skin for works that need one.
 *
 * A work skin exists only on the work page — not in the EPUB, not in AO3's own
 * HTML download. Without it, a fic built around chat bubbles or letters or
 * newspaper columns renders as undifferentiated prose, which is what both the
 * EPUB route and Archive Reader do today.
 *
 * One request per work, and only for works whose stored markup carries classes
 * AO3 and Calibre never emit — 248 of 1596 rather than all of them.
 */
import { DatabaseSync } from 'node:sqlite';
import { createClient } from './lib/client.mjs';
import { parseWorkPage } from '../app/core/ao3/parse.js';
import { workPage } from '../app/core/ao3/urls.js';
import { htmlToText, countWords } from '../app/core/epub.js';
import { applyWithVersioning, chapterHash } from './lib/versioning.mjs';
import { SCHEMA } from '../app/core/store/schema.js';

const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
db.exec(SCHEMA);
const explicitIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const limit = Number(process.env.LIMIT || 25);

/* Works whose markup uses classes outside AO3's and Calibre's own vocabulary:
   the sign of an author skin, and the only works worth spending a request on. */
const CANDIDATES = `
  SELECT DISTINCT w.work_id
  FROM works w JOIN chapters c ON c.work_id = w.work_id
  WHERE w.skin_css IS NULL
    AND (c.html LIKE '%class="%' AND c.html NOT LIKE '%__never__%')
  LIMIT ?`;

const ids = explicitIds.length
  ? explicitIds
  : db.prepare(CANDIDATES).all(limit).map((r) => r.work_id);

if (!ids.length) { console.log('nothing to fetch'); process.exit(0); }

const client = await createClient();
const save = db.prepare("UPDATE works SET skin_css = ?, source = 'ao3', fetched_at = datetime('now') WHERE work_id = ?");
const clearChapters = db.prepare('DELETE FROM chapters WHERE work_id = ?');
const insertChapter = db.prepare(`
  INSERT INTO chapters (work_id, number, title, html, text, words, content_hash)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(work_id, number) DO UPDATE SET
    title=excluded.title, html=excluded.html, text=excluded.text,
    words=excluded.words, content_hash=excluded.content_hash`);

/*
 * A skin styles classes — .twtchat, .breply, .messagebody — that Calibre threw
 * away when it built the EPUB. Storing the CSS without the markup it targets
 * changes nothing on screen, so the work page's own chapter HTML replaces the
 * EPUB's. AO3's markup is also what every work skin was written against, so
 * this is the version that renders as the author intended.
 */
async function storeChapters(workId, chapters) {
  if (!chapters.length) return 0;
  clearChapters.run(workId);
  for (const [i, c] of chapters.entries()) {
    // store AO3's whole chapter block for display, but index only the prose
    const display = c.block ?? c.html;
    const text = htmlToText(c.html || c.block || '');
    insertChapter.run(workId, i + 1, c.title, display, text, countWords(text),
      await chapterHash(display));
  }
  return chapters.length;
}

let withSkin = 0;
for (const id of ids) {
  const held = db.prepare('SELECT skin_css FROM works WHERE work_id = ?').get(id)?.skin_css || null;
  const { status, body } = await client.get(workPage(id), { label: `work ${id}` });
  if (status !== 200) { console.log(`  ${id}: status ${status}`); continue; }

  const parsed = parseWorkPage(body, { workId: id });
  if (parsed.skinCss) {
    // archive anything about to be overwritten BEFORE writing the new copy
    /* Compare what is actually stored. The display copy is AO3's whole chapter
       block; comparing the prose-only field instead reported "no change" while
       replacing every chapter, which is the one outcome versioning exists to
       prevent. */
    const plan = await applyWithVersioning(db, id, {
      chapters: parsed.chapters.map((c, i) => ({ ...c, number: i + 1, html: c.block ?? c.html })),
      skinCss: parsed.skinCss,
    });
    const n = await storeChapters(id, parsed.chapters);
    save.run(parsed.skinCss, id);
    withSkin++;
    // report what was archived, not what changed: a work with no stored copy
    // has nothing to supersede, and saying otherwise is a false claim
    const archivedChapters = plan.changes.filter((c) => c.previous).length;
    const archivedSkin = Boolean(plan.skinChange && plan.skinChange.previousHash && held);
    const parts = [];
    if (archivedChapters) parts.push(`${archivedChapters} chapter version(s)`);
    if (archivedSkin) parts.push('the previous work skin');
    const note = parts.length ? ` — archived ${parts.join(' and ')}` : '';
    console.log(`  ${id}: skin ${parsed.skinCss.length} bytes, ${parsed.images.length} images, ${n} chapters${note}`);
  } else {
    // record the visit so the work is not asked about again on every run
    save.run('', id);
    console.log(`  ${id}: no work skin`);
  }
}

console.log(`\n${withSkin} of ${ids.length} works had a skin`);
console.log(`requests ${client.limiter.stats.requests}, throttled ${client.limiter.stats.throttled}`);
db.close();
