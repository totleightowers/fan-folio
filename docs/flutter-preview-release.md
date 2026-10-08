# v4.0.0-alpha.2 — clearer work details and a distinct preview icon

Flutter Preview now has its own blue open-book launcher icon, including Android adaptive and themed-icon variants. The stable app retains its existing artwork. Regenerate preview assets with `node tools/make-icon.mjs --preview`.

The preview now uses higher-contrast text across its light, dark, sepia and black palettes. Work-page labels are larger, tag and author buttons have visible outlines and 48-point minimum tap targets, and the reading action uses explicit foreground/background colours. Meaningful text colours are checked against 4.5:1 and control outlines against 3:1 on each shared surface. Widget tests exercise the work page at normal and 200% text size, including button labels and tap targets.

This is a targeted accessibility improvement, not a full WCAG conformance claim. Physical-device TalkBack, keyboard and WebView checks remain necessary. The download-worker migration continues separately; this release still has the alpha.1 background limitations below.

The first Flutter migration preview. Install `fanfolio-preview.apk` as **Fan Folio Preview**, alongside your existing app. It uses separate storage and does not replace v3.

This alpha establishes adding a work by link, persistent download jobs and cooldowns, library browsing, HTML reading, and returning to a saved reading position. It also adds responsive phone/tablet navigation and the Return to the story pill.

Start an empty library, or import a copy of a library backup. Signing in here is separate from signing in to the stable app. Avoid running download queues in both apps simultaneously: AO3 sees their combined requests.

This is not feature parity with v3. Background service recovery, full download outcomes, EPUB import, OTP/Most read controls, deep links and the complete version-history interface still need migration or validation. Interrupted author listings remain paused with an explanation; known work IDs are retained. Android screen-off/process-kill behaviour still needs device validation.

The stable release remains [v3.14.2](https://github.com/totleightowers/fan-folio/releases/tag/v3.14.2). Keep using it for your main library during the migration.
