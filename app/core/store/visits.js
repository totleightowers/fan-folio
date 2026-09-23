/** AO3 snapshots and local reading sessions stay distinct; totals add them once. */
export const VISIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS reading_visits (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_by_work ON reading_visits(work_id);
`;
export const RECORD_VISIT = `INSERT OR IGNORE INTO reading_visits (id, work_id, started_at)
  SELECT ?, work_id, datetime('now') FROM works WHERE work_id = ?`;
export const FF_VISITS = '(SELECT count(*) FROM reading_visits v WHERE v.work_id = w.work_id)';
export const TOTAL_VISITS = `(COALESCE(w.visits, 0) + ${FF_VISITS})`;
export const HISTORY_UPDATE = `UPDATE works SET in_history = 1, visits = ?, last_visited = ?, visits_synced_at = ? WHERE work_id = ?`;

export function visitLabel(w) {
  const local = Number(w.ff_visits) || 0;
  const archive = w.visits == null ? null : Number(w.visits) || 0;
  if (archive == null && !local) return '';
  const total = local + (archive || 0);
  return `${total} visit${total === 1 ? '' : 's'} · ${archive == null ? 'AO3 not synced' : archive + ' AO3'} + ${local} Fan Folio`;
}
