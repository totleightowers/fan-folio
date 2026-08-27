import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const add = readFileSync(new URL('../tools/lib/add.mjs', import.meta.url), 'utf8');
const backfill = readFileSync(new URL('../tools/backfill.mjs', import.meta.url), 'utf8');

/**
 * Several thousand works are fetched by one long run, and what keeps that
 * welcome is a single limiter shared across all of them.
 *
 * The parameter carrying it was lost while resolving a merge, and the caller
 * went on passing it to a function that ignored it — so every work built its
 * own limiter and sixty went out in forty-five seconds against a budget of two
 * a minute. Nothing failed; it simply stopped being polite.
 */
test('one work fetched among many can share the caller\'s client', () => {
  assert.match(add, /addWorkByLink\(db, input, \{ client: shared = null \} = \{\}\)/,
    'the parameter exists');
  assert.match(add, /const client = shared \?\? await createClient\(\)/,
    'and a shared client is used in preference to a new one');
});

test('the run refuses to continue if nothing is pacing it', () => {
  assert.match(backfill, /client\.limiter\.stats\.requests === before/,
    'it checks the shared client actually made the request');
  assert.match(backfill, /pacing is not in effect/,
    'and stops rather than continuing quietly');
});

test('the repair stage runs before the long tail', () => {
  const stages = backfill.match(/const STAGES = \[([^\]]+)\]/)?.[1] ?? '';
  const order = [...stages.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.equal(order[0], 'phantom', 'works we hold in the wrong shape are fixed first');
  assert.ok(order.indexOf('history') > order.indexOf('bookmarks'),
    'and the history, which is the bulk of it, comes after what was chosen deliberately');
});
