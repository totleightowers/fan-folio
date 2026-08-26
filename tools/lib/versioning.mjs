/**
 * Archive what is about to be overwritten, then write the new copy.
 *
 * The rule is simple and worth stating plainly: nothing that has been stored
 * is ever destroyed by a sync. A chapter is only replaced after its previous
 * text has been copied into chapter_versions, and the same for a work skin.
 */
import { planVersioning, hashContent, normaliseForComparison } from '../../app/core/versions.js';

export async function applyWithVersioning(db, workId, incoming) {
  const heldChapters = db.prepare(
    'SELECT number, title, html, text, words, content_hash FROM chapters WHERE work_id = ? ORDER BY number'
  ).all(workId);
  const held = db.prepare('SELECT skin_css FROM works WHERE work_id = ?').get(workId);

  const plan = await planVersioning(
    { chapters: heldChapters, skinCss: held?.skin_css ?? null },
    incoming
  );

  const archiveChapter = db.prepare(`
    INSERT INTO chapter_versions (work_id, number, title, html, text, words, content_hash, reason, archived_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))`);
  const archiveSkin = db.prepare(`
    INSERT INTO skin_versions (work_id, skin_css, skin_hash, archived_at)
    VALUES (?,?,?,datetime('now'))`);

  for (const change of plan.changes) {
    if (!change.previous) continue;                 // a brand new chapter supersedes nothing
    const p = change.previous;
    archiveChapter.run(workId, change.number, p.title ?? null, p.html, p.text ?? null,
      p.words ?? null, change.previousHash ?? null, change.removed ? 'removed' : 'content');
  }

  if (plan.skinChange && held?.skin_css) {
    archiveSkin.run(workId, held.skin_css, plan.skinChange.previousHash);
  }

  return plan;
}

/** Content hash for a chapter as it will be stored, so later syncs can compare. */
export async function chapterHash(html) {
  return hashContent(normaliseForComparison(html));
}
