import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageName } from '../app/core/ao3/markup.js';

/**
 * What is left of this module.
 *
 * It used to build the work page as a string of HTML in the archive's own
 * shape — labels floated in a left-hand column, values beside them — which is
 * a layout for a wide page and piled up on a phone. The app lays the page out
 * itself now, as elements with textContent, which also retires the escaping
 * tests that used to live here: there is no longer any HTML being assembled
 * for a value to break out of.
 */
test('a language code is shown as a language', () => {
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('ko'), '한국어');
  assert.equal(languageName('FR'), 'Français');
});

test('a code nobody has a name for is shown as it came', () => {
  assert.equal(languageName('xyz'), 'xyz');
  assert.equal(languageName('en-GB'), 'English', 'a region is still that language');
});

test('no language at all is nothing, not an empty label', () => {
  // the caller leaves the row out entirely rather than printing a blank one
  assert.equal(languageName(null), null);
  assert.equal(languageName(''), null);
});
