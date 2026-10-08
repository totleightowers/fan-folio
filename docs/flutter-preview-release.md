# v4.0.0-alpha.3 — downloads owned by the Android service

Flutter Preview now runs its download queue and archive requests in the foreground-service isolate. Closing a screen or detaching the UI no longer disposes the download engine. Reopening the app reconnects to the same queue. Requests share one persisted archive pacing clock.

The notification reports active work and offers Pause. Android service timeouts checkpoint remaining jobs as paused for explicit resumption. Settings → Export download diagnostics produces a bounded report of worker starts/stops and numeric progress, without cookies, work URLs or reading content.

Includes alpha.2’s distinct blue open-book launcher icon, higher-contrast palettes, larger work metadata and accessible author/tag touch targets.

Install **fanfolio-preview.apk** as **Fan Folio Preview**, alongside the stable app. It has separate storage. Start an empty library or import a copy of a backup; sign in separately. Avoid running archive downloads in both apps simultaneously because AO3 sees their combined requests.

Host tests cover a download completing after UI disposal, reconnection without a duplicate queue, and paused recovery after a service timeout. Real-device screen-off, task dismissal, process death and battery-management behaviour still need validation. This alpha does not promise uninterrupted background execution on every Android device.

The preview is not feature-complete. Per-work download outcomes, durable author-listing cursors, EPUB import, OTP/Most read, deep links and the full version-history interface remain migration work. Do not export a library backup while downloads are active; concurrent-writer backup handling remains a migration gate.

The stable release remains [v3.14.3](https://github.com/totleightowers/fan-folio/releases/tag/v3.14.3). Keep it for your main library during migration.
