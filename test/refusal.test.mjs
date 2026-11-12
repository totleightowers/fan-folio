import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refusal } from '../app/core/ao3/refusal.js';

test('a refusal carries what the archive said', () => {
  const body = '<div id="main"><div class="flash error">Sorry, you have <em>already</em> bookmarked this work.</div></div>';
  assert.equal(refusal({ status: 422, body }, 'The archive refused the bookmark'),
    'The archive refused the bookmark: Sorry, you have already bookmarked this work.');
});

test('with nothing said, it gives the status', () => {
  assert.equal(refusal({ status: 503, body: '<html><body>Retry later</body></html>' }, 'The archive refused the kudos'),
    'The archive refused the kudos (503)');
  assert.equal(refusal({}, 'The archive refused the comment'), 'The archive refused the comment');
  assert.equal(refusal(null, 'The archive refused the comment'), 'The archive refused the comment');
});

test('what it carries is short plain text', () => {
  const body = `<ul class="error"><li>${'Comment is too long. '.repeat(30)}</li><li><script>alert(1)</script></li></ul>`;
  const message = refusal({ status: 422, body }, 'The archive refused the comment');
  assert.ok(message.length < 200);
  assert.equal(/[<>]/.test(message), false);
});

test('every place that reports a refusal can find the function', () => {
  const api = readFileSync(new URL('../app/api.js', import.meta.url), 'utf8');
  assert.match(api, /import \{ refusal \} from '\.\/core\/ao3\/refusal\.js';/);
  assert.equal(api.match(/refusal\(res, /g).length, 3);
});
