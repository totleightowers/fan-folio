# Fan Folio: rethink the reading journey

The 3.0–3.5 rollout improved individual screens but retained the existing product structure. It should not be treated as completion of the requested redesign. The user’s feedback is that the change was too small, despite useful functionality.

## The experience we are designing

Fan Folio is a place to keep and read stories, including stories no longer available on AO3. It should feel like returning to a personal collection, not operating an archive synchronisation client. The existing Home boxes, fandom browsing and reading typography are useful starting points. The task is to connect them into a comprehensible experience.

Three questions should organise the app: **What do I want to read? Where is the story I remember? Has the collection I brought in arrived?** These correspond to Home, Library and Downloads, but those labels alone do not make a coherent product. Each destination needs a different, intentional composition and an obvious path to reading.

## The proposed departure

**Home becomes a reading desk.** Keep the coloured character and fandom controls at the top. Give the current reading choices a clear visual lead, with title, place and one Resume action. Other shelves support choosing what to read next. Queue administration and library statistics should not compete with that first decision. Downloads remains reachable through navigation and a concise status when work is in progress.

**Library becomes a collection browser with a work preview.** Stop applying the same search-and-buttons header to every destination. Give Library its own title, search entry and collection/filter controls. Selecting a story should open a deliberate preview, not feel like abandoning the collection. On a tablet, keep the list and selected preview side by side; on a phone, use the same preview as a full-height destination with an explicit return to the preserved collection. Present title, byline, full summary and Read/Resume first. Keep detailed metadata, earlier copies and archive participation available in clearly named sections. Compact presentation remains optional; full descriptions remain accessible.

**Reading becomes a distinct mode.** The page gets the whole screen on tablets as well as phones. Tapping reveals a small set of reading controls and an obvious return to the story’s preview. Search and appearance are contextual to the story. Away from the page, a persistent current-story entry offers an immediate return, so the reader does not need to reconstruct a navigation path to continue. Existing swipes remain shortcuts, never the only route.

**Downloads becomes a collection arriving.** A job opens its actual stories, with individual outcomes and actions. Ready stories can be read immediately; waiting and failed stories explain their state. The result survives restart. Job controls sit with the job rather than dominating each story. Starting from an author, a series or an import should lead to the same result view and back to its origin. This is the first concrete journey change following the feedback.

**Settings becomes a short set of choices.** Appearance, reading defaults, account, and library safety/recovery each have a clear entry and focused destination. Backup/import and blocked/removed items remain available. Work-specific actions belong with the work; acquisition belongs with Add and its resulting job.

## Facts the design must distinguish

- A local copy and the archive’s availability are independent. Saved chapters remain readable when AO3 hides or removes a work. Import provenance is a fact about the copy, not a reason to call it undownloaded.
- Partial text, an earlier version, and a current complete copy must not be conflated. The immediate repair makes the current has_text flag agree with chapter storage; richer presentation should report the saved chapter range without promising a complete offline copy.
- A job having fetched a work historically is different from the copy still being present today. Job results must report both honestly, including when the reader later removes the work.
- Reading progress, rereading, bookmarks, Later and local availability are separate dimensions. None should erase the others.
- A missing historical job list cannot be reconstructed from an author's current catalogue. Older jobs must say when individual records were not retained.

## Implementation and acceptance

Correct the imported-copy flag first, then deliver persisted per-work job results as a separately reviewed release. Those are concrete reported problems, not a substitute for the redesign above.

The larger layout work should be assessed as three complete loops: choose → preview → read → return; search/filter → preview → return to the same results; add/sync → job → arrived story → read. Phone and tablet should share the same meanings while using space differently. A collection of restyled screens is insufficient evidence.

Before calling the wider redesign complete, demonstrate those loops with full summaries, a large filtered list, multiple in-progress works, an imported copy whose archive source is unavailable, a partly failed job, and an earlier version. Preserve all advanced filtering, source styling, offline images, polite fetching, foreground reading priority and recovery features. Validate Android-specific Back, link handoff and screen-size changes on a device rather than claiming browser coverage proves them.
