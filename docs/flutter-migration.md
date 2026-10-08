# Flutter migration, v4

Baseline: signed v3.14.2 (`a53807a8085ca841d9d45130c7b6859c156052f1`).

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

Each subsequent slice gets a signed PR and a preview release. Promote v4 only after these gates are satisfied with a copied library and device evidence. A stored chapter is never evidence of a working backup, and a running service is never evidence of progressing downloads.

## Verification boundary

Core tests use fake clocks and synthetic HTTP. App tests use temporary SQLite files. No test contacts AO3 or uses the user's session. CI analyzes and tests Dart/Flutter and builds Android. Real platform WebView scrolling, notification permissions, Doze, task dismissal and process death require an Android device; they are not covered by host widget tests.
