# v4.0.0-alpha.4 — navigation from the reader

Reading mode now has a **Go to** menu for Home, Library, Downloads, You, Search and Settings. It leaves the reading route stack directly, saves any pending reading position, and keeps the **Return to the story** pill available on the main destinations. The Library filter button now uses a funnel icon.

Download diagnostics now record how far the Android worker gets during startup. An Android emulator check exercises the real service opening its library, accepting a queue command and reconnecting to the UI, without contacting AO3. This release does **not** establish a fix for the reported download stall; a device diagnostic report is still needed to identify that failure.

Includes the blue open-book launcher icon, higher-contrast palettes and accessible work metadata from alpha.2, and the service-owned queue and consistent SQLite backup from alpha.3.

Install **fanfolio-preview.apk** as **Fan Folio Preview**, alongside the stable app. It has separate storage. Start an empty library or import a copy of a backup; sign in separately. Avoid running archive downloads in both apps simultaneously because AO3 sees their combined requests.

The preview is not feature-complete. Per-work download outcomes, durable author-listing cursors, EPUB import, OTP/Most read, deep links and the full version-history interface remain migration work. Screen-off, task dismissal and battery-management behaviour still need validation on the device. Settings → Export download diagnostics produces a bounded report without cookies, work URLs or reading content.

The stable release remains [v3.14.3](https://github.com/totleightowers/fan-folio/releases/tag/v3.14.3). Keep it for your main library during migration.
