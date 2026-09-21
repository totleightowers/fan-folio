# v3 journey validation

The initial six slices improved individual screens. The subsequent reading-first pass changes the larger journeys: a reading desk, collection preview, immersive reader with a persistent return, per-work download results, focused Settings and a new app identity. See the [release record](v3-rollout.md). The [v2.10.4 baseline](version-policy.md) remains available unchanged.

## What goes where

| Intent | v3 route | Coverage |
|---|---|---|
| Choose or resume | Home keeps compact fandom/category browsing above equal reading cards and quieter story lists. Resume opens the saved chapter; the title opens details. | Browser phone/tablet journeys; shared reading-state queries. |
| Find and organise | Library has reading and collection shortcuts, independent availability, detailed filters and density in View & filters, sorting and explicit search scope in the app bar. Full descriptions remain the default; Compact offers a full-description disclosure. Tablet previews retain the loaded collection alongside the story, and phone previews return explicitly to the list. | 320–900px long-title/tag/summary checks, combined-query tests, saved density, delayed-response regression, and a 56-work filtered list with preserved scroll and loaded range. |
| Read and return | Work actions precede the full summary. Saved chapters and EPUB provenance are stated explicitly. Reading fills the screen at every size; other destinations offer a persistent return to the saved chapter. Reader offers work details, previous/contents/next, appearance, comments and More; a labelled search button exposes within-work search. | Phone/tablet controls through 1280px, chapter/end actions, search and Back. Existing gesture tests remain in place. |
| Finish or reread | Starting again resets the current pass while retaining earlier completion. A new chapter creates a resume opportunity; caught-up unfinished works remain distinct from author-complete works. | Reading-state, atomic restart, older-database migration and backup merge tests. |
| Add and follow progress | Add accepts work/chapter/series links and offers EPUBs or bookmark acquisition. Downloads opens each job into its individual waiting, successful, failed and earlier-version outcomes, preserving them across restart. Jobs retain pause/resume, retries and a direct route to readable works. | Browser entry routes and restored job records; queue-state unit fixtures. Network requests blocked. |
| Explore an author | Works and Bookmarks remain separate. Each can be synced, or both together. Known/downloaded counts use the local library. View downloads follows progress. | Browser counts, author return and account route; existing sync and queue tests. |
| Manage or recover | Settings is a short directory leading to separate appearance, reading, account, library/backup and blocked/removed destinations. Author deletion/blocking is a separate disclosure with the existing confirmation. | Browser navigation/management placement; existing store deletion, blocking and merge tests. Native file operations remain device-validation work. |
| Keep earlier copies | Earlier versions remain on work details. Back restores the same earlier chapter version, and viewing it does not change the current reading position. | Version and render tests; browser earlier-version → Settings → Back → current-copy journey. |
| Participate on AO3 | Kudos, comments, bookmark notes/tags/private/recommendation and opening the source remain reachable through work details and reader actions. | Forms, routing and sanitisation tests; browser reachability. No live posts or account transactions. |
| Personalise | All themes, supplied/custom fonts, text size, spacing, weight, margins, alignment, preview/reset and page-turn vibration remain. Appearance and reading defaults have independent destinations; all advanced options remain in the shared reader sheet. | Browser preference persistence, preview, system theme, font and reset checks; existing styling tests. |
| Start fresh or import | First run explains AO3/EPUB acquisition and library backup import. Creating a library leads into Add. | Source and bridge/build checks. Android creation and pickers were not run on a physical device. |

## Accessibility and presentation

Dialogs have accessible names. Closing a sheet returns focus to its opener when the journey has not changed; navigation does not drag focus back to a previous screen. Selected tabs, author tabs, filters and expanded filter sections expose state. Recommendation/later symbols have accessible labels. Focus outlines and reduced-motion behaviour remain available.

Browser checks cover narrow phones, larger phones, tablet portrait/landscape, light/dark/system themes and reduced motion. They check card bounds, complete descriptions, toolbar alignment and overlap, and dialog focus return. These checks do not establish TalkBack compliance or replace testing with Android accessibility services and device font scaling.

## Data and release integrity

Database changes are the additive `reading.completed_before` column and repairing the cached `has_text` flag from saved current chapters. Imports and backup merges use the same repair, including older databases that lacked that column. Existing positions are preserved; explicit rereading resets current progress atomically. Incoming older backups are migrated before merging. The Android package and APK certificate remain the same.

Each slice runs the logic suite, JavaScript parsing, browser journeys, native APK build and required security checks. Published APKs are downloaded and compared with their signed tag, generated schema/merge/restart/availability SQL and the preserved v2 signing certificate. Commits and tags use the owner's signing key; integration preserves the checked commit.

## Physical-device follow-up

The browser fixtures never contact AO3. Physical Android Back/edge gestures, TalkBack, device font scaling, app links, file pickers, installing an upgrade, sign-in, live archive forms, notification controls and long background downloads still need device checks. Fetch pacing, retry policy, archive authority and image/source rendering were retained. Their existing logic/build tests passed; this rollout does not claim new live-network validation.


## 3.10 visual reset checks

The existing browser journey now uses the compact search button on phones, the Settings rail entry on tablets and View & filters for availability and density. It checks alternate Home browse categories, bounds on the Home header, the phone reading shelf, and all previous full-description and preserved-collection journeys.

A specific return-pill check leaves a transient search passage, opens Settings, verifies the pill clears phone navigation, and resumes the saved second chapter at its original scroll offset. The reader hides the pill while the chapter is open. The implementation does not alter fetch pacing, saved text, database layout or import state.
