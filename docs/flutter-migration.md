# Flutter migration, v4–v5

Feature acceptance baseline: **v3.14.3**. Preserve its user-visible capabilities and data semantics within the new v5 navigation. Retaining only the incomplete v4 preview does not meet acceptance. Keeping the old APK available is separate from feature preservation.

## Architecture

Flutter owns navigation and library/download/settings screens. The story body remains HTML in a WebView, including work skins and saved images. The database remains SQLite. Archive requests go through one shared pacer; Android execution and queue persistence must outlive screens.

The parked Dart implementation is reusable code, not feature parity. The September Flutter spec is historical; its claim that isolates cannot be throttled is incorrect. A foreground service does not establish process recovery by itself. Do not claim background reliability from compilation or widget tests.

Preview builds use `org.fanfolio.preview` and separate storage. They are signed with the project APK key, published as prereleases, and never replace the stable APK or the latest stable release link. Commits and tags retain the owner's signatures. Stable v3 remains available; there is no automatic library migration in this stage.

## First slice: add, find, read, return

- Durable queue snapshots and pacing state, persisted before network dispatch.
- Restore all pending jobs without the old forty-job truncation. Preserve paused state and completed counts. Restore all jobs before starting the queue.
- Interrupted listing producers do not restart silently: pause with an explanation; retain discovered work IDs.
- No automatic repeated verification passes in the app; failed work remains available for explicit retry.
- Home, Library, Downloads and account access adapt between bottom navigation and a tablet rail.
- Downloads added by link offer Open work after saving.
- The entire Return to the story pill opens the most recently read locally held work, including rereads and imported works with stale availability flags.
- All chapter bodies use the HTML renderer; scroll position is saved on navigation/backgrounding as well as after scrolling. Native text remains a renderer failure fallback.
- External image requests do not carry archive cookies.

## Service ownership slice (alpha.3)

On Android, one foreground-service isolate owns the queue, archive client and shared pacer. Screens send commands and observe snapshots; disposing the UI does not stop the engine. The service opens its own SQLite connection, persists work before dispatch, restores pending work on a system restart, and stops after ten idle seconds. Android data-sync timeouts pause/checkpoint remaining jobs for explicit resumption; this does not evade system execution limits. There is no boot-triggered download start.

Private bounded diagnostics record lifecycle events and minute-by-minute numeric progress, with export from Settings. They exclude cookies, work URLs, titles and downloaded content. A report exported while a write is in progress can have an incomplete final line.

Host tests disconnect/reconnect the UI during a synthetic download and check timeout-paused recovery. They cannot establish that a particular Android device keeps the service alive. Screen-off, task removal, OEM battery restrictions and process restarts remain device gates. Long author reconciliation actions do not yet have a durable listing cursor. Backup export uses a consistent SQLite snapshot while the worker writes, with staging and integrity checks before sharing. It requires SQLite 3.27 or newer; older SQLite versions fail explicitly rather than copy an unsafe live file. Large-library device validation remains outstanding.

## Feature audit and order of migration

| Journey | Existing Dart implementation | Remaining gate |
| --- | --- | --- |
| Add a work / offline reading | Parser, database, paced client, reader | First slice regression tests; Android WebView/device validation |
| Background downloads | Service-owned Dart queue, persisted pacing, diagnostics, notification pause and timeout checkpoint | Physical-device screen-off/task dismissal/process restart and timeout validation |
| Download inspection and retries | Aggregate job rows | Per-work outcomes, failure reasons, durable listing cursor, prioritise newly opened work |
| Home / library | Shelves, filters, search, cards | Approved v3 visual layout, rating/relationship on every card, compact metadata, consistent full-card actions |
| Return to story | First slice shell pill | Extend consistently to nested author/settings/work routes |
| Filters and ranking | Basic tag/rating/state queries | OTP definition, combined AO3 + app visits, Most read surface, current continue-reading rules |
| Authors / bookmarks / history | Basic listing and reconciliation | Full parity, partial sync safety, pause/resume of producer walks, AO3 history visit counts |
| Local copies / EPUB | SQLite backup import | EPUB import, content-presence reconciliation, hidden/deleted-work offline behaviour |
| Version history | Storage tables and chapter archiving | Reachable version selection/comparison and work-skin history UI |
| Images | Stored image bytes and fetching | Current Imgur recovery, per-image status/retry, large image memory behaviour |
| Archive actions | Sign-in, kudos, comments, bookmarks | Current forms/error handling and account-session parity |
| Android integration | Generated host + service plugin | Deep links, shares, notification actions, process lifecycle, accessibility/device checks |
| Backup / migration | SQLite import/export | Validated import staging, WAL-safe replacement, current schema preservation, large-library tests |

Each subsequent slice gets a signed PR and a preview release. Promote v5 only after these gates are satisfied with a copied library and device evidence. A stored chapter is never evidence of a working backup, and a running service is never evidence of progressing downloads.

## Verification boundary

Core tests use fake clocks and synthetic HTTP. App tests use temporary SQLite files. No test contacts AO3 or uses the user's session. CI analyzes and tests Dart/Flutter and builds Android. Real platform WebView scrolling, notification permissions, Doze, task dismissal and process death require an Android device; they are not covered by host widget tests.

## v5 discovery: retained functionality and journey map

The v5 redesign must preserve v3.14.3 functionality. Alpha.1 only retained the v4 preview subset and is incomplete against that requirement. The gates above remain required; an available storage table is not a usable feature.

| Existing capability | v5 location / preservation |
| --- | --- |
| Home shelves, fandom browsing, random work, Continue reading | Home; existing handlers retained |
| Local work/tag/rating/state filters and full-text search | Library funnel and Search library; tab changes retain filters and loaded results |
| Work details, chapters, swipe to read, metadata navigation | Work route within the current section; local tag lookup retained alongside Explore AO3 |
| Reader HTML, skins, images, fallback text, chapter navigation, search and appearance | Existing full-screen ReaderScreen; Go to also includes Explore AO3 |
| Saved reading position and Return to story | Same storage and return logic, pill extends to nested browsing routes |
| Add by link, series, job inspection/pause/resume/retry, open saved work | Add action and Downloads icon; reader Go to → Downloads; Settings → Activity |
| Sign-in/out, bookmark sync, kudos/comments/bookmarks | Existing You, author and work actions; AO3 history/Later sync still require restoration |
| Author works/bookmarks, sync, block/unblock | Existing author page, with Explore author on AO3 added |
| Backup/import, reader defaults, diagnostics, blocked-item recovery | Existing Settings and You destinations |
| Current chapters, archived chapters/skins, pictures, reading history and flags | Same schema and database; download updates preserve personal fields |

New: service-owned AO3 searches with explicit submit/pagination; saved searches stored in backup metadata; manual first-page update checks; ephemeral results; read-now and save-for-later from a discovered work; foreground priority within the single pacing queue. Search parameter names follow AO3's [work search form](https://github.com/otwcode/otwarchive/blob/master/app/views/works/_search_form.html.erb).

Navigation acceptance: independent tab route stacks; global destinations remain visible on work/author/settings/download routes; full-screen reading returns to its originating session; local filters/results/scroll survive tab switches; AO3 results survive opening/closing details and switching tabs without another request. Re-selecting the current destination returns to its root. Reader Go to → Library/Home explicitly returns to that section's root.

Tests cover phone and tablet journeys, saved-search backup, service RPC search/read, duplicate foreground fetch coalescing, offline reopening, personal-state/version preservation and priority without bypassing rate limits. Existing core/Flutter, stable-app and Android service checks remain required. Physical-device gestures, WebView text rendering and lifecycle reliability remain device gates.


## v3 restoration acceptance

The source baseline is `v3.14.3`, particularly `app/core/query.js`, `app/core/store/reading.js`, `app/core/store/visits.js`, `app/core/versions.js`, `app/core/epub.js`, `app/core/sync/history.js` and the routes in `app/app.js`.

First restoration slice:

- Reachable local sort controls including Most read, with AO3 snapshot visits plus recorded local reading sessions. Scrolling and saving progress do not add visits. Unsynced AO3 counts are labelled explicitly.
- OTP (exactly one relationship), independent saved-copy availability, includes/excludes, warnings/categories, language, completion, crossover, word/chapter/date ranges, and full/compact descriptions.
- Actual readable chapters establish availability even when imported flags are stale. New acquisitions order by the library arrival time.
- Restart reading atomically retains earlier completion; Home, Library and counts share that meaning.
- Rating and relationship remain visible on shelf cards and are fetched for search/author/library rows. Fandom browsing returns to the top of Home. Full descriptions are the list default.
- Earlier chapter versions can be read and compared without changing the current bookmark or adding a visit. Changed work skins are archived transactionally, and earlier skin records remain reachable. An archive-write failure must stop replacement instead of losing the previous copy.

Still required before v3 parity can be declared:

- EPUB ingestion (including packaged images, provenance, existing-copy reconciliation) and backup merge rather than replacement only.
- AO3 history/Later sync, durable listing cursors and safe partial bookmark/author reconciliation.
- Detailed per-work download outcomes/requeue, complete current image recovery, and physical-device background execution evidence.
- Deep links/share intents, source-opening flows and session/account checks.
- Reader in-work search/transient navigation and full v3 preference/font/haptic parity.
- Whole-journey checks against v3 for every entry point, phone/tablet, large text, imported data and hidden works.

These are requirements, not optional follow-ups. Each restored slice must have tests and a signed PR/release; no preview is described as preserving all v3 features until the list is complete.
