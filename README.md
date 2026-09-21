# Fan Folio

Your saved fiction, kept on your own phone — full text, images, styling and
all — and searchable in a way the sites it came from are not.

## Versions

The existing UI is preserved as **v2.10.4**: [download the APK](https://github.com/totleightowers/fan-folio/releases/download/v2.10.4/fanfolio.apk). The frozen source is on `frozen/v2`.

This `v3` branch starts the next major version with a [UI and journey assessment](docs/v3-ui-assessment.md). No redesigned build has been released. See the [version policy](docs/version-policy.md) for both tracks.

## Why

The places fiction is published rarely search their own prose, rarely read
offline, and never remember what a story said before its author revised it.
Fan Folio keeps a local copy of everything you have saved, indexes every word,
and preserves earlier versions when a work changes.

It renders a work **as its source renders it**, using the source's own
stylesheets and the author's own custom styling, rather than approximating
them. A story told in chat messages looks like a chat, not like stacked
paragraphs.

## What it does

- **Full-text search** across the whole library, with ranked results and
  highlighted snippets. Phrases, prefixes, `NEAR()`, boolean operators.
- **Metadata filters** over everything stored: include or exclude any tag,
  rating, completion, length, reading state — with counts computed against the
  filters already applied, so narrowing never lands on nothing.
- **Faithful rendering**, with embedded images captured locally so nothing
  rots or phones home.
- **Version history**: when a work's text or its styling changes, the previous
  version is kept and can be read.
- **Reading state**: where you were in every work, what you have finished, what
  you marked for later.
- **Polite syncing**: a single-connection fetcher with human-shaped pacing,
  exponential backoff, and penalties that survive a restart.

## Layout

| | |
|---|---|
| `app/` | the reader — plain ES modules, no framework |
| `app/core/` | logic shared by the app and the tooling |
| `android/` | the WebView shell and an on-device APK build |
| `tools/` | ingest, sync, export and development server |
| `test/` | node's built-in test runner |

## Running it

```sh
npm test                 # the whole suite
npm run check            # every file parses
node tools/serve.mjs     # the reader at http://localhost:8080
cd android && ./build.sh # an APK, built on the phone if you like
```

The app reads one SQLite file. Build it from a folder of EPUBs:

```sh
node tools/ingest-epubs.mjs /path/to/epubs
node tools/export-db.mjs            # a single consistent file to import
```

Add a single work from a link:

```sh
node tools/add-work.mjs <link>
```

## Licence

MIT.

The stylesheets under `app/vendor/` come from
[otwarchive](https://github.com/otwcode/otwarchive) and remain under its
licence. That attribution is a condition of using them and stays regardless of
how the rest of this is described.

The typefaces under `app/fonts/` and `dart/folio_app/fonts/` —
[Literata](https://github.com/googlefonts/literata) and
[Atkinson Hyperlegible](https://www.brailleinstitute.org/freefont/) — are used
under the SIL Open Font License 1.1. Its text sits beside them in both
directories, which is the condition of shipping them, and applies to those
files rather than to this app. The two copies are the same faces in the formats
their apps need: woff2 for the 1.x WebView, TrueType for the Flutter bundle.
