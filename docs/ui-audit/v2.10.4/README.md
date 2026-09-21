# v2.10.4 walkthrough evidence

Baseline: `7561274c93b37483d15e2f35604db57543a27904`, 21 September 2026.

Read the [assessment](../../v3-ui-assessment.md) for findings and the proposed v3 direction. These are **current UI screenshots**, not v3 mockups.

A local Chromium walkthrough used synthetic data and blocked external requests. It visited 26 screen/dialog/theme states, with no browser JavaScript errors in the completed run. This is an observational walkthrough, not a native acceptance test. Phone viewport: 390 × 844; tablet: 900 × 940.

| Screen | Evidence |
|---|---|
| Home, phone | [Screenshot](01-home-phone.png): top browsing, Continue Reading card, statistics and shelves |
| Details from Continue Reading | [Screenshot](02-work-from-continue.png): long summary before the reading action |
| Home search | [Screenshot](08-search-from-home.png): works and passage results |
| Library after that search | [Screenshot](09-library.png): “Afternoon” remains in the input while the unfiltered library is displayed |
| Filters | [Screenshot](10-filters.png): reading, offline and membership states in the same section |
| Author works | [Screenshot](11-author-works.png): works/bookmarks tabs, acquisition controls and local list |
| Settings | [Screenshot](14-settings.png): preferences, imports, Downloads and maintenance |
| Activity reached through Downloads | [Screenshot](15-downloads-empty.png): explanatory text and native-only status |
| You | [Screenshot](16-you.png): account, library shortcuts and bookmark sync |
| Reader, dark tablet | [Screenshot](22-reader-tablet-dark.png): rail, search, reading area and bottom controls |
| Home, dark tablet | [Screenshot](23-home-tablet-dark.png): shelf layout and visual character |
| Library, dark tablet | [Screenshot](24-library-tablet-dark.png): card grid and metadata hierarchy |

The [observation log](observations.json) records all 26 captured states, including earlier versions, contents, reading settings, reader menu, author bookmarks, block confirmation, Add and expanded settings. The observed route for You → Blocked authors is `activity`; the source handler independently confirms that destination.

The fixture deliberately contains long descriptions/titles/tags, downloaded and metadata-only works, a reading position, a later entry and an earlier version. It is not representative usage analytics. Counts on You/author and live download controls depend on Android and do not operate fully in this browser. “App only”, zero native counts and the development version footer must not be interpreted as release defects.

Account login, actual downloads, file import/export, OS links, notifications, system Back, TalkBack and installation/data compatibility remain device-validation work. No real library, account cookie or network fetch was used for these screenshots.
