import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 2.x opens the database 1.x wrote.
 *
 * The Flutter version is a different program in a different language, and the
 * one thing it must not have is a different idea of the shape of the library.
 * The schema is written once, in JavaScript, and emitted for Dart; this runs
 * the emitter and fails if what is committed has drifted from what it writes.
 */
test('the Dart schema is the schema, not a copy of it', () => {
  const generated = fileURLToPath(new URL('../dart/folio_core/lib/src/store/schema.g.dart', import.meta.url));
  const onDisk = readFileSync(generated, 'utf8');

  execFileSync(process.execPath, [fileURLToPath(new URL('../tools/emit-dart-schema.mjs', import.meta.url))]);
  const fresh = readFileSync(generated, 'utf8');

  assert.equal(onDisk, fresh,
    'run `node tools/emit-dart-schema.mjs` — the schema changed and Dart was not told');
});

/**
 * The Dart port is held to what this implementation actually answers.
 *
 * Two ports passing two suites written by the same hand proves the hand was
 * consistent. The fixture records what 1.x says about a body of links and
 * bylines; if the rules here change and the fixture is not regenerated, the
 * two versions have quietly begun disagreeing about where a byline points.
 */
test('the conformance fixture still says what 1.x says', () => {
  const fixture = fileURLToPath(
    new URL('../dart/folio_core/test/conformance/urls.json', import.meta.url));
  const before = readFileSync(fixture, 'utf8');
  execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/emit-conformance.mjs', import.meta.url))]);
  assert.equal(before, readFileSync(fixture, 'utf8'),
    'run `node tools/emit-conformance.mjs` — the rules moved and Dart was not told');
});

/**
 * What the app decides about a failure, and the order it decides it in.
 *
 * isTransient is a stack of regular expressions whose order is the whole
 * answer: a 429 has to be read as "slow down" before the blanket 4xx rule
 * reads it as "no". Getting that wrong during a long download writes off every
 * work in flight the moment the archive starts throttling, and reports them to
 * the reader as unavailable — which is neither true nor actionable.
 */
test('the sync fixture still says what 1.x says', () => {
  const fixture = fileURLToPath(
    new URL('../dart/folio_core/test/conformance/sync.json', import.meta.url));
  const before = readFileSync(fixture, 'utf8');
  execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/emit-sync-conformance.mjs', import.meta.url))]);
  assert.equal(before, readFileSync(fixture, 'utf8'),
    'run `node tools/emit-sync-conformance.mjs` — a retry rule moved and Dart was not told');
});

/**
 * A delete is a list and an order, and three implementations now run it.
 *
 * The shell in Java, the dev server in JavaScript and the Flutter app in Dart
 * each let go of a work by hand, and none can import another's code. A table
 * added to the library and left off one of those lists is a row still sitting
 * there after somebody tidies; a blocking rule that drifts is a work that
 * quietly stops being shown. The fixture records what 1.x does with both.
 */
test('the tidying fixture still says what 1.x says', () => {
  const fixture = fileURLToPath(
    new URL('../dart/folio_core/test/conformance/tidy.json', import.meta.url));
  const before = readFileSync(fixture, 'utf8');
  execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/emit-tidy-conformance.mjs', import.meta.url))]);
  assert.equal(before, readFileSync(fixture, 'utf8'),
    'run `node tools/emit-tidy-conformance.mjs` — a delete or a block moved and Dart was not told');
});

/**
 * The native reader must not lose a word the WebView showed.
 *
 * A reader who finds out a scene is missing finds out by reaching the next
 * one. The fixture records the words of real chapters, from the implementation
 * that has been showing them for weeks; the Dart document model is required to
 * produce the same ones.
 */
test('the chapter fixture still says what 1.x says', () => {
  const fixture = fileURLToPath(
    new URL('../dart/folio_core/test/conformance/chapters.json', import.meta.url));
  const before = readFileSync(fixture, 'utf8');
  execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/emit-chapter-conformance.mjs', import.meta.url))]);
  assert.equal(before, readFileSync(fixture, 'utf8'),
    'run `node tools/emit-chapter-conformance.mjs` — the text changed and Dart was not told');
});

/**
 * Ranking is the part of search nobody can eyeball.
 *
 * A wrong order looks like a plausible order, so the two versions cannot be
 * left to agree by inspection. The fixture holds the blobs SQLite actually
 * produced for real queries and the scores 1.x computed from them.
 */
test('the search fixture still says what 1.x says', () => {
  const fixture = fileURLToPath(
    new URL('../dart/folio_core/test/conformance/search.json', import.meta.url));
  const before = readFileSync(fixture, 'utf8');
  execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/emit-search-conformance.mjs', import.meta.url))]);
  assert.equal(before, readFileSync(fixture, 'utf8'),
    'run `node tools/emit-search-conformance.mjs` — the ranking moved and Dart was not told');
});

/**
 * A parser is the one place where being subtly wrong is invisible.
 *
 * A work with the wrong tags, a chapter count off by one, an author dropped
 * from a byline — none of it announces itself. It sits in the library looking
 * like data, and is found months later by somebody wondering where a fic went.
 */
test('the parse fixture still says what 1.x says', () => {
  const fixture = fileURLToPath(
    new URL('../dart/folio_core/test/conformance/parse.json', import.meta.url));
  const before = readFileSync(fixture, 'utf8');
  execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/emit-parse-conformance.mjs', import.meta.url))]);
  assert.equal(before, readFileSync(fixture, 'utf8'),
    'run `node tools/emit-parse-conformance.mjs` — the parser moved and Dart was not told');
});

test('the emitted statements carry no comment that could cut one in half', () => {
  const dart = readFileSync(
    new URL('../dart/folio_core/lib/src/store/schema.g.dart', import.meta.url), 'utf8');
  const statements = dart.slice(dart.indexOf('schemaStatements = ['));
  /* The schema's own comments contain semicolons — "JSON array; a work can
     have several" — and splitting on those cuts CREATE TABLE in two. The
     splitter that strips them is shared with the shell rather than written
     twice, and this is the assertion that it ran. */
  assert.ok(!statements.includes('--'), 'comments are stripped before splitting');
  assert.ok(statements.includes('CREATE TABLE IF NOT EXISTS works'));
  assert.ok(statements.includes('CREATE TABLE IF NOT EXISTS bookmarked_by'));
});
