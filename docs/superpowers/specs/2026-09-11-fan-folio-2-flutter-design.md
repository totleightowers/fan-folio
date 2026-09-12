# Fan Folio 2 — Flutter, with the reader still a WebView

Fan Folio 1.x is a WebView shell around a web app. 2.x is a Flutter app that
renders chapters in a WebView and does everything else natively.

## Why, honestly

The 1.x architecture was chosen for one reason and it was the right one: an
AO3 work is an HTML document with the author's own CSS attached, and rendering
that faithfully means having a CSS cascade. That has not changed, which is why
the chapter body stays in a WebView here.

What has changed is the accumulated cost of everything that is *not* reading:

- a WebView throttles the page's timers once nobody is looking at it, so
  downloading needed a foreground service ticking the page from outside;
- the queue lives in the page, so process death loses it unless it is written
  to the database and rebuilt on restart;
- gestures are hand-written — swipe, back preview, sheet dragging — and one of
  them broke in a way that took a release to find;
- the bridge between Java and JavaScript cannot share code, so every shared
  rule needs a drift test holding two languages to one predicate.

A Dart isolate does not get throttled. Flutter has gestures. And most of the
bridge stops existing rather than being ported.

## What this deletes

Roughly 2,000 lines of `MainActivity.java`: the read-only SQL bridge, the
narrow `@JavascriptInterface` write methods, `window.__tick` and the service
that drives it, the wake lock, and every drift guard that exists only because
Java and JavaScript could not share a function.

## Shape

    dart/folio_core/    pure Dart, no flutter import
    dart/folio_app/     the Flutter app

`folio_core` is everything that is logic: SQL building, migrations, AO3 URLs
and parsing, the pacer, the job queue, the walks, the reading rules, bm25
ranking. It takes a database interface rather than a database: tests supply
`package:sqlite3`, the app supplies `sqflite`.

This division is not tidiness. Flutter does not publish a Linux arm64 SDK, so
the Flutter half cannot be built or tested on the machine this is written on,
while pure Dart can. Putting the risky logic where it can be tested is the
difference between porting it and guessing at it.

## The reader: native by default, WebView where there is a skin

Two surfaces, chosen per work by `works.skin_css`.

The reason for one reader was faithfulness: an AO3 work is an HTML document
with the author's CSS attached, and a chat fic must look like a chat. The
reason for the other is that native text is what a reading app is made of —
real pagination, no WebView scroll jank, type that behaves. Archive Reader
does the second and it is what made this rewrite worth starting.

Most works have no skin at all. So: a work with a skin opens in a WebView and
renders exactly as its author wrote it; every other work is laid out as native
text. `skin_css` is already stored and already tells us which is which.

The cost, stated plainly: **a work can change character depending on whether
it happens to carry a skin.** That is mitigated rather than solved — the
native renderer matches the WebView's default AO3 typography closely enough
that the two agree except where a skin is actually doing something — and a
control in the reader switches one work to the other surface, so a mangled
render or an unreadable skin is one tap from the other answer.

The document model is pure Dart and therefore testable here: chapter HTML in,
a tree of spans and blocks out. Only the painting of it is Flutter. That puts
the part most likely to be wrong on the side of the line that has tests.

`webview_flutter` is the same Android WebView, so a work skin renders exactly
as it does now — which is the whole reason it stays.

Dart builds the document: chapter HTML, AO3's stylesheet, the author's skin,
and the reader's typography as CSS custom properties. Images are served from a
loopback server, keeping the `/img/<sha256>` scheme, rather than data: URIs
that would exhaust memory on an image-heavy chapter.

What crosses the remaining seam: Dart sets typography and scroll position; the
page reports its scroll offset and when a chapter has been read to its end.

## The database

The same file, the same schema, the same migrations.

2.x ships with the same `applicationId` and the same signing key as 1.x, so
installing it replaces 1.x and inherits `getFilesDir()/archive.db` in place.
No export, no import, no second copy, and no chance of two libraries drifting
apart.

Development builds use `org.fanfolio.next` so that testing an unfinished 2.x
never touches a working 1.x. They start empty and are fed a copy through the
backup and import that already exist.

**2.x may add to the schema. It may not change what 1.x relies on.** Both
versions only ever add columns and tables, so a reinstall of 1.x after a
disappointing 2.0 still opens the library and still works.

## What the first installable build does

Reading and downloading both. A reader that cannot feed itself is a demo, and
the download engine is the half that most needs to stop living in a page.

## Order of work

Stages 1 to 3 are provable on this machine. Nothing is installable until 7.

1. **Store** — schema, migrations, the query builder, delete, blocked.
   Tested against real SQLite, on the fixtures the JavaScript tests use.
2. **Archive** — URLs, `linkTarget`, listing and work-page parsing, forms,
   and the chapter document model. Tested on the saved fixtures in
   `test/fixtures`; all of it is HTML handling and belongs in one frame.
3. **Sync** — the pacer, the job queue, the walks, bookmark reconciliation.
   Porting the behavioural tests, which is where the found bugs live.
4. **Shell** — navigation, library, work page.
5. **Reader** — the native document, the WebView for skinned works, the
   switch between them, and the reading settings driving both.
6. **Activity** — the queue screen, the notification, the background isolate.
7. **Release** — `flutter test` and `flutter build apk` in CI, tagged `v2.x`.

1.x keeps working and keeps getting fixes throughout.

## The test suite is the asset

553 tests encode the bugs this app has already had: two predicates that
disagreed about what "reading" meant, `count(*)` over no rows making every
undownloaded work finished, opening a chapter marking it read, four clocks
pacing the same requests, a half-read bookmark list deciding what to unbookmark.

A rewrite that does not carry them re-earns every one. So each stage ports the
tests with the code, and where a JavaScript test asserts a rule, the Dart test
asserts the same rule against the same fixture.

## The weak point

The Flutter half cannot be run on this machine at all. Core logic is tested
here; every screen is verified by a CI build and by somebody looking at it on
a phone. That is a much worse loop than 1.x has, and UI faults will reach the
reader that logic faults will not.
