/**
 * Write the schema out for the shell to run.
 *
 * A new library has to be made somewhere, and the shape of one lives in
 * app/core/store/schema.js because that is where it can be tested against a
 * real database. The shell cannot import JavaScript, and a second copy in Java
 * would drift from the tested one — so the build emits it as an asset and the
 * shell reads it back, the same way the merge steps already travel.
 */
import { SCHEMA } from '../app/core/store/schema.js';

/*
 * Comments are stripped on the way out.
 *
 * The shell runs this a statement at a time, split on semicolons, and the
 * comments in the schema contain semicolons of their own — "JSON array; a work
 * can have several" — so leaving them in cuts statements in half. They are
 * worth having where the schema is read by people and worth nothing to
 * SQLite, so they stay in the source and do not travel.
 */
export function executable(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/* Only when run as a script. The tests import `executable` to check the shell
   can make a library out of what this writes, and a stray write from an import
   lands in the middle of their output. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.stdout.write(executable(SCHEMA));
}
