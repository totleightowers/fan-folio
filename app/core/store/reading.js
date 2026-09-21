import { CHAPTERS } from '../query.js';

// One atomic change: keep earlier completion while resetting this reading.
export const RESTART_READING = `
INSERT INTO reading (work_id, chapter, offset, chapters_read, completed_before, updated_at, opened_at)
SELECT w.work_id, 1, 0, 0,
       CASE WHEN COALESCE(r.completed_before, 0) = 1 OR COALESCE(r.chapters_read, 0) >= ${CHAPTERS}
            THEN 1 ELSE 0 END,
       datetime('now'), datetime('now')
FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
WHERE w.work_id = ?
ON CONFLICT(work_id) DO UPDATE SET
  chapter = 1, offset = 0, chapters_read = 0,
  completed_before = excluded.completed_before,
  updated_at = excluded.updated_at, opened_at = excluded.opened_at`;
