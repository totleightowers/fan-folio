# v5.0.0-alpha.3 — restore v3 library and earlier-copy journeys

The feature baseline for v5 is **v3.14.3**. Alpha.1 retained only the incomplete v4 preview; this release starts restoring the missing v3 journeys within the new Home, Explore, Library and You navigation. It is not yet a complete v3 replacement.

- **View & filters:** sorting, Most read, OTP (exactly one relationship), independent reading state/collection/download availability, includes/excludes, warnings/categories, language, completion, crossover, word/chapter/date ranges and full/compact descriptions. Full descriptions are the default; compact descriptions can be expanded.
- **Most read:** adds imported AO3 history visit counts to local reading sessions, without counting scroll saves or chapter turns as new visits. AO3 counts that have not been synced are identified. Fresh AO3 history sync remains outstanding.
- **Bookmark safety:** partial or interrupted scans preserve unseen bookmarks; only a complete scan can remove membership. The signed-in account is checked before accepting a page.
- **Saved copies and rereading:** readable chapters determine download availability despite stale imported flags. Start again keeps previous completion while resetting the current pass. Recently added follows arrival in the library.
- **Cards and Home:** rating/relationship metadata is shown consistently, descriptions can be read in full, and fandom browsing is above the story shelves.
- **Earlier versions:** open saved chapter copies and compare them with the current chapter without moving your current reading position. Changed work skins are archived, and earlier skins can be inspected. Replacement stops if the previous copy cannot be archived.

Home uses a single compact browse row and cards sized to their actual contents, including enlarged text. The Return to the story pill and v5 archive browsing remain. Install **fanfolio-preview.apk** to update the existing preview library and session; the stable v3 app is separate. The [v3.14.3 APK](https://github.com/totleightowers/fan-folio/releases/tag/v3.14.3) remains available unchanged.

Core and Flutter tests cover combined filters, stale imported availability, rereading, visit counts, earlier copies, and large-text cards. Tests do not establish physical-device background reliability or platform WebView behavior. EPUB ingestion, complete account sync, detailed download outcomes, deep links/share handling, backup merge and remaining reader preferences/search are still required for full v3 parity. See the [migration checklist](https://github.com/totleightowers/fan-folio/blob/main/docs/flutter-migration.md).
