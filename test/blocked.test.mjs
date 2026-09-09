import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHidden, authorsOf, worksByPattern } from '../app/core/store/blocked.js';

test('a work solely by a blocked author is hidden', () => {
  assert.equal(isHidden('["ann"]', ['ann']), true);
});

test('a collaboration with somebody you have not blocked is kept', () => {
  /* Blocking a person should not cost you a work you like that they happened
     to write half of. */
  assert.equal(isHidden('["ann","bee"]', ['ann']), false);
  assert.equal(isHidden('["ann","bee"]', ['ann', 'bee']), true, 'both of them, though');
});

test('nobody blocked hides nothing', () => {
  assert.equal(isHidden('["ann"]', []), false);
  assert.equal(isHidden('["ann"]', new Set()), false);
});

test('a work whose authors cannot be read is never hidden', () => {
  /* Hiding on the strength of a field that failed to parse is how a library
     loses things silently. */
  assert.equal(isHidden('not json at all', ['ann']), false);
  assert.equal(isHidden('[]', ['ann']), false);
  assert.equal(isHidden(null, ['ann']), false);
  assert.equal(isHidden(undefined, ['ann']), false);
});

test('authors are read out of whatever the column holds', () => {
  assert.deepEqual(authorsOf('["ann","bee"]'), ['ann', 'bee']);
  assert.deepEqual(authorsOf(['ann']), ['ann']);
  assert.deepEqual(authorsOf('{"not":"an array"}'), []);
});

test('a name matches itself and not a longer name containing it', () => {
  /* The same trap the author filter has: a bare LIKE on the name would match
     "Anna" inside "Annabel", and the quotes are what stop it. */
  assert.ok(worksByPattern('Anna').includes('"Anna"'));
  assert.ok(!'["Annabel"]'.includes('"Anna"'));
});
