# v5.0.0-alpha.1 — explore the archive, keep your place

The new major preview adds **Home, Explore, Library and You** with independent browsing histories. Switch sections while a work or author page is open, then return to the same page. Library filters and loaded results survive tab changes. The **Return to the story** pill stays above navigation on work, author, search, settings and download pages; the reader remains full screen.

**Explore** searches AO3 directly, separately from local-library search. Search by keywords, title, author, fandom, relationship, character, tags, rating, completion, crossover, word count and language, with sorting and pagination. Save a search and explicitly check its first page for new results. Searches are not run while typing and do not automatically import their results.

Open a discovered work, keep it for later, download it, or choose **Read now**. Existing local text opens without contacting AO3. Authors and common tags connect to archive browsing while retaining local-library navigation. Downloads remains available through the download icon and the reader's Go to menu, including its existing job controls and work-opening actions.

Foreground searches and read requests get the next paced turn ahead of background requests; they never bypass a cooldown. Saving downloaded text now preserves personal flags such as bookmarks, kudos and Later, along with reading progress and archived chapters.

Install **fanfolio-preview.apk** to update Fan Folio Preview, retaining its v4 library and session. The stable v3 app remains separate. Existing [v4.0.0-alpha.4](https://github.com/totleightowers/fan-folio/releases/tag/v4.0.0-alpha.4) and [v3.14.3](https://github.com/totleightowers/fan-folio/releases/tag/v3.14.3) downloads remain available. Keep a backup before switching back to an older installation; Android does not support an ordinary in-place downgrade.

This remains a Flutter preview. It retains the v4 capabilities; inherited gaps such as EPUB import, OTP/Most read surfaces, per-work job outcomes, full version-history UI, deep links and complete account-sync parity are still migration work. The reported physical-device download stall is not established as fixed. Diagnostics, existing reader settings, skins, saved images, archive actions, author sync, backup/import and blocked-item recovery remain available. See the [migration inventory](https://github.com/totleightowers/fan-folio/blob/main/docs/flutter-migration.md).

Saved-search checks are manual and inspect the first page, with up to 1,000 previously seen work IDs retained per search. They are not background update notifications. Phone/tablet widget journeys and synthetic service tests do not establish Android screen-off or process-death reliability.
