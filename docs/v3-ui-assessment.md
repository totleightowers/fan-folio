# Fan Folio v3: UI and journey assessment

Assessment of **v2.10.4**, 21 September 2026. This is a design brief, not an implemented redesign. The existing UI is frozen separately; see the [version policy and v2 download](version-policy.md).

## The central problem

Fan Folio is a capable personal reading archive, but the interface does not consistently organise itself around what someone came to do. Reading, choosing a work, searching, collecting, syncing and maintaining the library overlap across screens. Someone can learn each feature and still have to stop and work out where to go next.

The same work appears as a discovery card, a library entry, a search result and a reading destination. Those presentations can sensibly differ, but their action hierarchy, state and return journey need to agree. At present they do not always agree. More colour, a tidier toolbar or another settings layout would address only part of this.

The design promise for v3 should be: **find something worth reading, get back to it easily, and trust that the app is keeping it for you.** Everything else should support that promise without disappearing.

## What should survive

- Home's coloured boxes, warm character and browsing shelves. They give the collection an identity. Keep fandoms near the top, as requested.
- The reading experience: typography control, faithful author styling, offline text and images, chapter navigation and saved position. Improve the surrounding controls carefully.
- Serious library tools: full-text search, detailed metadata, inclusion/exclusion filters, sorting and author exploration. A calmer interface must still support a large collection.
- The archive as the authoritative current source, with earlier copies retained rather than overwritten or discarded.
- Useful control over fetching: new reading requests take priority, ongoing downloads remain visible and controllable, and waiting is explained honestly.
- Full descriptions. v2.10.4 fixed clipping; v3 must not quietly bring it back under the name of tidiness.

## Evidence and limits

The review combines the current HTML/JavaScript and Android bridge with a browser walkthrough at **390 × 844** and **900 × 940**, including light and dark themes. A synthetic library includes downloaded and metadata-only works, an in-progress reading position, a later list, long titles/descriptions/tags, multiple authors and an earlier chapter version. External requests were blocked; no AO3 fetching or account operations were performed.

The walkthrough covers Home, work details, reader, contents, reading preferences, reader menu, search, Library, filters, author works/bookmarks, the block confirmation, Settings, Downloads/Activity, You and Add. [Selected screenshots and observations](ui-audit/v2.10.4/README.md) record the baseline. Fixed bars in full-page captures are capture artifacts; viewport images are used for layout evidence.

First-run setup, live download states, network recovery, authentication, Android Back/gestures, file pickers, notifications, app links and database migration were reviewed in source or identified as device-validation work. They were **not** proved end to end on a physical device. Some counters and download controls depend on the native bridge and show zero or “App only” in the browser; those are not recorded as device bugs.

This is an expert assessment informed by the user's reported friction, not a usability study with multiple participants.

## Journey assessment

| Someone's intent | Current experience | Consequence | v3 direction |
|---|---|---|---|
| Start using the app | Setup asks for a new library or database import, then points to sign-in/bookmarks or a link. EPUB entry is elsewhere. | Creating a database is a technical step before a recognisable reading goal. | Offer clear ways to bring the first work in, while preserving new-library and backup-import paths; lead into the same Add and Downloads journeys used later. |
| Carry on reading | Home's Continue Reading card opens work details; Library has a direct Continue action. A long description precedes the work-page reading action. | The shortest journey depends on where the same work was found. | An explicit Resume action goes straight to the saved place from every relevant surface; details remain separately accessible. Preserve the work-to-reader swipe. |
| Choose something to read | Home shelves, fandom browsing, Library filters and You shortcuts offer overlapping routes. | It is unclear which route is the most dependable starting point. | Home helps choose; Library helps find and organise. Each Home shortcut opens a clearly named Library view. |
| Find a remembered story or sentence | The top box changes between everything, metadata and this work, mostly through its placeholder. | The control looks unchanged while the meaning changes. A retained query can look like an applied filter when it is not. | Make search scope explicit and persistent in results. Keep global, filtered-library and within-work search distinct and switchable. |
| Explore an author | The author page combines Works/Bookmarks, sync actions and a local list. “See these in the library” creates another version of the collection. | Local holdings, remote discovery and download status require interpretation. | Show what is known, what is available offline and what is being checked. Keep both author tabs and separate/both sync operations. |
| Keep something for later | Later, archive bookmarks and finished collections occur in different places. | Similar “save” concepts can look interchangeable despite different effects. | Clearly distinguish local reading intention from a bookmark written to AO3. Give collection views a stable home in Library. |
| Add or download works | Links use the global plus; EPUBs are under Settings; bookmark sync starts under You; author sync starts on an author; queue management is under Settings → Downloads. | Starting and following a task feel like separate features. | One Add entry with source choices; a consistently reachable Downloads destination shared by every producer of work. |
| Finish, reread or catch up | Progress, completion and opening history feed several surfaces. | A work disappearing from Continue Reading can feel like lost state. | Define reading-state transitions before designing the shelves. Distinguish completed reading, rereading and caught up with an unfinished work. |
| Maintain the collection | Backup/import, blocked authors and removed works live in Settings. Some related controls appear elsewhere. | It is hard to predict where reversal or recovery lives. | A stable maintenance area with explicit effects and recovery paths. Destructive actions stay separate from sync/read actions. |
| Return after an interruption | There are top Back, system Back, tabs, reader menu destinations, work-details controls and chapter gestures. | “Back”, “up to this work” and “go to a main section” can be confused. | Specify each route and its retained state; test actual Android behaviour alongside phone/tablet layouts. |

## Findings by part of the experience

### Home: keep its personality; clarify its priorities

Home is one of the stronger parts. The coloured spines, tinted cards and shelves are recognisably a personal collection. Keep the fandom/pairing/rating browsing area at the top. Give it a compact, stable footprint so Continue Reading is easy to reach.

The main tension is between returning to something and being offered more things. Continue Reading uses the same compact discovery card as shelves where someone has not chosen a work yet. It spends space on a summary, but does not offer a direct Resume action. Statistics then interrupt the sequence of shelves. Several shelves can contain the same works; the synthetic example makes this repetition particularly visible, without proving how often it occurs in the real library.

Recommendation: preserve the shelves, but give returning to a work a distinct treatment: recognisable title, reading position and a direct resume action. Let statistics support the collection without competing with the next reading choice. Validate shelf ordering with the actual library before removing any shelf.

### Library: a dependable collection, with deliberate density

Library is trying to be both a scanning list and a full description of every work. Complete summaries are valuable, but large descriptions make rows radically different heights and push actions far apart. A tablet grid compounds this by putting unrelated vertical rhythms beside one another.

The solution is not to truncate descriptions again. Prototype a deliberate choice between an expanded presentation and a compact presentation with an obvious, accessible way to read the **entire** description. Keep the full work page. Decide the default with the user; this assessment does not authorise changing the current behaviour.

Keep stable locations for title, author, reading/offline state and primary action. Tags should look and behave like the same type of filter wherever they occur. Author names should have a consistent route to the author. Avoid styling passive facts and interactive metadata identically.

The filter sheet is powerful. Its “Reading” section currently mixes reading progress, offline availability, archive membership and recommendation status. Those are different dimensions: a work can be downloaded, bookmarked and being reread simultaneously. Make those dimensions understandable while preserving all current filter combinations and counts.

### Work details: deciding and acting are out of balance

The work page contains the right material, but a long summary can occupy more than a screen before the reading action appears. Reading actions, archive participation, fetching, deletion and versions then follow in close succession. The page does not clearly distinguish “carry on with my story” from “manage this copy”.

Keep an immediately reachable reading action near the title and reading state. Give summary and metadata room below it. Group archive participation separately from local maintenance. Preserve chapter access, versions, tags, dates, opening AO3, re-fetching and deletion; changing hierarchy must not erase advanced features.

Opening a metadata-only work already starts foreground fetching in the native app; the Library Download action opens that work page. Preserve this convenience and the priority of the requested work. Make the transition and waiting state obvious. The browser cannot exercise this native fetch, so its disabled fetching state is not evidence that Download fails on a device.

### Reader: preserve the quiet centre

The prose presentation is already comparatively coherent. Its surrounding navigation has accumulated several escape routes. On tablets, the app rail, top search and wide bottom toolbar frame the page simultaneously. The bottom controls span a large width, so their grouping matters more than simply reducing icon count.

Keep chapter movement and contents as one stable group. Keep work details distinct from Back. Place reading appearance and secondary actions consistently on phone and tablet. Use the same symbol for the same action everywhere; for example, the work-page Comment action currently uses the chapters/list glyph while the tablet reader uses a speech bubble.

Evaluate a compact toolbar aligned with the reading area and a clear separation between chapter controls and work actions. Do not introduce hidden gestures as the only route to anything. Preserve existing chapter swipes and work-to-reader entry. Any immersive mode should be reversible and tested for accidental loss of navigation.

Reading settings already offer previews, sensible primary controls and additional options. They need consistent entry and return behaviour more than another complete redesign. Distinguish app appearance from prose settings so changes do not have surprising reach.

### Search: make the question visible

Search is a defining capability, but its scope is too implicit. The phone header gives it little room beside Back, Add, Aa and Settings. Its placeholder is truncated; once a query is entered, even that hint disappears.

In the walkthrough, a Home search for “Afternoon” correctly returned works and passages. Tapping Library afterwards retained “Afternoon” in the box while showing the unfiltered 20-work library. The query was also still visible later in the reader. This is a concrete mismatch between visible state and results, not just a preference about layout.

The work-details placeholder also initially said “Search every word held…” even though the loaded work makes subsequent searching work-scoped. Results should identify their scope, applied filters and result types independently of the input placeholder. Removing a query should return to a predictable place. Looking at a found passage must not silently overwrite the main reading position.

### Authors, You, Settings and Downloads: establish clear homes

The author page is useful, and separating destructive management from Sync was the right direction. However, placing management after the entire work list makes it hard to locate for prolific authors. A clearly labelled management entry can remain away from primary actions without requiring a trip to the bottom of a long catalogue.

You currently combines an archive account, shortcuts to Library collections and bookmark acquisition. Settings combines preferences, collection maintenance and the entrance to Downloads. These screens do not have distinct purposes. The issue is not that any one row looks insufficiently polished.

There is also a confirmed route error: **You → Blocked authors opens Activity**, while the actual blocked-author manager is in Settings. Record it for v3; no fix is included in this assessment.

Downloads should answer: what is happening, what can I read now, what is waiting, why, and what can I do? The current Activity screen instead starts with several paragraphs explaining scheduling. Keep necessary explanations available, but make status and next actions primary. Distinguish a user pause, a server cooldown, a sign-in problem and a failed item; they require different responses.

## Proposed information architecture

This is a recommendation to prototype, not a final navigation decision.

| Destination | Its job | Contents |
|---|---|---|
| **Home** | Help me choose or continue | Top fandom browsing, resume, useful shelves, collection character |
| **Library** | Help me find and organise | All known works; reading/later/finished/bookmarked views; full filters, sort and search; author routes |
| **Downloads** | Show and control ongoing work | Shared queue, progress, waiting reasons, priorities, pause/resume/cancel/retry and completion routes |
| **Settings** | Manage preferences, account and data | Appearance, reading defaults, haptics, archive account, backup/import, blocked authors and removed works |
| **Add** | Bring something in | Link and EPUB entry; routes to relevant acquisition/sync operations |
| **Work / Author / Reader** | Complete the current task | Contextual destinations with stable return paths, not competing main sections |

For this user's substantial syncing needs, **Home / Library / Downloads** is the strongest initial candidate for primary navigation. You's collection shortcuts move into Library and its account controls into Settings. Bookmark checking remains directly accessible from the Bookmarked collection and Downloads; it must not become buried account administration.

Compare this with a two-section Home/Library model plus a persistent labelled download-status entry. The tradeoff is a permanent third tab versus visibility only when needed. Do not keep You simply because it already occupies the third slot, or replace it without testing how the relocated tasks are found.

Settings stays consistently reachable from main sections. Reader chrome can be quieter, but the route out must remain obvious. Tablet navigation should express the same destinations and actions as phone navigation, with layout adapted to available space.

## State and navigation contract

Before wireframes, settle these rules and use them across every surface:

1. **Known is not downloaded.** A catalogue record and an offline-readable copy have visibly different states. Partial availability, queued work and errors must be representable.
2. **Reading progress is not collection membership.** Later, an AO3 bookmark, finished reading and offline storage are independent concepts.
3. **Rereading is a real journey.** Starting again must have an agreed effect on Continue Reading and progress without pretending earlier reading never happened. Current completion queries and monotonic chapter counts need investigation against this contract; no native reread bug is claimed as reproduced here.
4. **Caught up is not author-complete.** A new chapter can create a new reading opportunity while a work remains unfinished on AO3.
5. **A visit is not always a new reading position.** Search peeks and earlier versions must preserve the intended current reading position unless someone deliberately resumes there.
6. **Back returns; work details goes up; a tab changes section.** Preserve query, filters, sorting and scroll when returning. The current deliberate history of tab visits must be considered, not silently removed while simplifying navigation.
7. **One action has one meaning.** Resume reads, Download requests the work and exposes its progress, a tag refines or starts a stated collection, and AO3 Bookmark writes to the archive.
8. **Background work has one visible lifecycle.** Starting it anywhere creates an identifiable queue item. Its origin offers a route to progress; completing it offers a route to the result. Newly requested reading takes priority within the existing polite fetch policy.

## Capability preservation checklist

Every implemented journey needs an explicit v2-to-v3 mapping. The following is the initial inventory, to be checked against source and device behaviour during implementation.

| Capability family | Must remain reachable and understandable |
|---|---|
| Reading | Offline prose/images, source and author styling, saved chapter/offset, contents, previous/next, swipes, end-of-work actions, current-copy return from older versions |
| Personalisation | System/light/sepia/dark/black/custom colours; supplied and custom fonts; size, spacing, weight, alignment, side/top margins, preview/reset; page-turn haptics |
| Finding | Whole-library prose search, scoped metadata and within-work search, ranked snippets, phrases/prefixes/boolean/NEAR queries; passage peeking |
| Filtering | Include/exclude tags, author selection, fandom/relationship/rating/language, completion, length, chapters, dates, crossovers, only-this-pairing, reading/offline/bookmark/recommendation states, contextual counts and all existing sort modes |
| Collection | Resume, later, finished/unread, rereading, newly available chapters, recency and statistics; full descriptions and metadata |
| Authors and bookmarks | Author works and bookmarks, separate/both sync, own new-bookmark checks and full reconciliation, known versus downloaded holdings |
| Archive participation | Sign-in and protected works, kudos, comments, bookmark notes/tags/private/recommendation fields, opening the source; honest recovery from missing forms or expired sessions |
| Acquisition | Supported incoming work/chapter/series links and sharing, link addition, EPUB import, database import/merge and backup; existing-copy/version policy |
| Download control | Foreground priority, queue progress, pause/resume/cancel/prioritise/retry, cooldown/error information, pending metadata-only works, persistence and native notification controls |
| Preservation | Earlier text and styling versions, imported alternatives, archive authority over the current copy, local images |
| Removal and recovery | Work deletion, author blocking including coauthor effects, unblocking, removal records and allowing downloads again; explicit scope and confirmations |

This checklist protects functions, not their current placement. Native-only flows need device checks before anything can be considered preserved.

## Visual and interaction direction

Keep the warm palette, coloured collection accents and readable typography. Make colour mean something consistently across cards, filters and states. Establish a small set of shared patterns for navigation rows, work presentations, primary/secondary actions, chips, status and destructive controls.

Reserve the strongest treatment for the task someone came to perform. Reduce repeated uppercase microheadings and low-emphasis explanatory text where they flatten hierarchy. Use short labels for actions and adjacent explanations for consequences. Downloads should communicate “waiting until …” or “sign in to continue” before describing the scheduler.

Accessibility is part of coherence: explicit names for icons, visible focus, large-text wrapping, touch targets, readable dark-theme contrast, state conveyed beyond colour, logical sheet focus/return and reduced-motion behaviour. These need measurement and native assistive-technology testing; the screenshots alone cannot establish compliance.

## Order of work and acceptance

1. **Approve the journey model.** Resolve navigation, search scope, reading states and download visibility using low-fidelity phone/tablet flows. No reskin first.
2. **Prototype the core loops.** Resume → read → return; browse/filter → choose → read → return; add/sync → waiting → available → read. Include long summaries, large libraries, offline/error states and rereading.
3. **Define shared components and visual hierarchy.** Apply them to the same journeys, preserving Home's character and the reader's strengths.
4. **Implement complete journeys in v3.** Keep the frozen v2 baseline and avoid a release made of individually polished but inconsistent screens.
5. **Validate the capability inventory and upgrade path on devices.** Only then publish a v3 build.

Acceptance should be concrete: one explicit Resume action from Home reaches the saved place; returning restores the original list and scroll; a visible query always describes the displayed results; a queued download is reachable from wherever it was started; every full description remains accessible; blocking cannot be mistaken for syncing; rereading/new chapters behave consistently across Home, Library and reader; phone and tablet use the same action meanings.

Before v3 distribution, decide whether it updates the existing Android app or installs alongside v2, and test backup/import and schema compatibility accordingly. Keeping the old APK downloadable does not by itself provide a safe downgrade of a newer database.

## Source anchors

- [Screen structure and labels](../app/index.html): Home, You, Activity, Settings, author, Library, reader and sheets.
- [Interaction implementation](../app/app.js): `workCard`, `workRow`, `buildYou`, `buildHome`, `searchScope`, `runSearch`, `openWork`, `openChapter`, `goToTab`, `paintChrome`.
- [Navigation history](../app/core/nav.js), [reading-state/filter queries](../app/core/query.js).
- [Android persistence and bridge](../android/src/org/fanfolio/MainActivity.java): `markOpened`, `markFinished`, `saveProgress` and native-only operations.

No runtime files were changed for this assessment.
