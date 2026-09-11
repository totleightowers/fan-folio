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
