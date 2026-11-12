import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snippetParts } from '../app/core/snippet.js';

test('a snippet is text and marks, in order', () => {
  assert.deepEqual(snippetParts('…the <mark>rain</mark> came in off the <mark>sea</mark>…'), [
    { text: '…the ', mark: false }, { text: 'rain', mark: true },
    { text: ' came in off the ', mark: false }, { text: 'sea', mark: true },
    { text: '…', mark: false },
  ]);
});

test('markup inside the indexed text stays text', () => {
  const parts = snippetParts('<img src=x onerror=alert(1)> and <mark>rain</mark><script>x</script>');
  assert.deepEqual(parts.map(p => p.mark), [false, true, false]);
  assert.equal(parts[0].text, '<img src=x onerror=alert(1)> and ');
  assert.equal(parts[2].text, '<script>x</script>');
});

test('nothing in, nothing out', () => {
  assert.deepEqual(snippetParts(null), []);
  assert.deepEqual(snippetParts(''), []);
});
