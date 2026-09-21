/** Storage is established by the chapters, independently of where they came from. */
export const REPAIR_AVAILABILITY = `UPDATE works SET has_text =
  EXISTS (SELECT 1 FROM chapters c WHERE c.work_id = works.work_id)
  WHERE has_text IS NOT
  (EXISTS (SELECT 1 FROM chapters c WHERE c.work_id = works.work_id))`;
