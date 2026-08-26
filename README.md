# Fanfolio

Your AO3 bookmarks and history, kept on your own phone — full text, images,
work skins and all — and searchable in a way AO3 itself is not.

## Why

AO3 has no full-text search over fic text, no offline reading, and no memory of
what a work said before its author revised it. Fanfolio keeps a local copy of
everything you have bookmarked or read, indexes every word of it, and preserves
earlier versions when a work changes.

It renders works **as AO3 renders them** — using AO3's own stylesheets and the
author's own work skin — rather than approximating them. A chat fic looks like
a chat, not like stacked paragraphs.

## What it does

- **Full-text search** across the whole archive, with ranked results and
  highlighted snippets. Phrases, prefixes, `NEAR()`, boolean operators.
- **Faithful rendering**: AO3's stylesheets plus each work's own skin, with
  embedded images captured locally so nothing rots or phones home.
- **Version history**: when a work's text or its skin changes, the previous
  version is kept and can be read.
- **Reading state**: where you were in every work, what you have finished, what
  you marked for later.
- **Polite syncing**: a single-connection crawler with human-shaped pacing,
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

The app reads one SQLite file. Build it from a folder of AO3 EPUBs:

```sh
node tools/ingest-epubs.mjs /path/to/epubs
node tools/export-db.mjs            # a single consistent file to import
```

## Licence

MIT. AO3's stylesheets under `app/vendor/ao3/` come from
[otwarchive](https://github.com/otwcode/otwarchive) and remain under its licence.
