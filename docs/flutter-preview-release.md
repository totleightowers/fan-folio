The first Flutter migration preview. Install `fanfolio-preview.apk` as **Fan Folio Preview**, alongside your existing app. It uses separate storage and does not replace v3.

This alpha establishes adding a work by link, persistent download jobs and cooldowns, library browsing, HTML reading, and returning to a saved reading position. It also adds responsive phone/tablet navigation and the Return to the story pill.

Start an empty library, or import a copy of a library backup. Signing in here is separate from signing in to the stable app. Avoid running download queues in both apps simultaneously: AO3 sees their combined requests.

This is not feature parity with v3. Background service recovery, full download outcomes, EPUB import, OTP/Most read controls, deep links and the complete version-history interface still need migration or validation. Interrupted author listings remain paused with an explanation; known work IDs are retained. Android screen-off/process-kill behaviour still needs device validation.

The stable release remains [v3.14.2](https://github.com/totleightowers/fan-folio/releases/tag/v3.14.2). Keep using it for your main library during the migration.
