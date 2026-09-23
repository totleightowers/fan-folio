# Personal reading visits

Library → Sort → **Most read · your visits** adds the saved AO3 History count to Fan Folio reading visits. **Most AO3 hits · everyone** keeps the existing public-popularity sort. Cards show the total and source breakdown. Unknown AO3 counts are labelled “AO3 not synced”, and works without either count have no count label.

Fan Folio starts counting with this release; earlier reading activity cannot be reconstructed reliably. A successful, deliberate opening of the reader creates a visit. Chapter changes and Back from Settings preserve the visit ID. Opening work details does not count. Search passage previews only count if the user continues reading past the preview threshold. Historical version previews do not count. A new reader entry from a collection starts a new visit. This is an opening count, not a completion count or a measure of time spent reading.

Each local visit has a random ID stored in SQLite. Backup imports combine these IDs without counting shared visits again. They also preserve AO3 counts separately: a newer timestamped snapshot supersedes the old one; a legacy snapshot can fill missing data without replacing newer synced data. Deleting a work deletes its local visit records.

**Downloads → Your reading history → Sync AO3 history** reads the signed-in user's history listing pages through the existing shared pacer. It records metadata and counts without downloading work text. It respects queue Pause/Stop and checkpoints completed pages for process restart. Re-running a sync replaces AO3 snapshots rather than adding the reported totals again. Partial syncs retain completed pages, so unsynced entries can remain older. Deleted/blocked works stay excluded. Sync is bound to the account that started it and requires that account to resume.

AO3 counts are the Archive's personal history visit counts, as documented in its [History FAQ](https://archive.transformativeworks.org/faq/history-and-mark-for-later?language_id=en). Adding sources is deliberate; no claim is made that the result measures complete rereads.

Validation uses local SQLite, real Android Java compilation, synthetic AO3 history HTML and browser journeys with external requests blocked. No live AO3 account history was fetched. Physical-device/background-service behavior was not retested for this change.
