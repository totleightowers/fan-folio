import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadStatus } from '../app/core/downloads.js';

test('download summary distinguishes cooldown, pause, retries and missing works', () => {
  const running = [{ state: 'running', total: 4, added: 1 }];
  assert.equal(downloadStatus(running, { now: 0, coolUntil: 120000 }).title, 'Waiting for the archive');
  assert.match(downloadStatus(running, { now: 0, coolUntil: 120000 }).detail, /2 minutes/);
  assert.equal(downloadStatus(running, { now: 120001, coolUntil: 120000 }).title, 'Downloads in progress');
  assert.equal(downloadStatus([{ state: 'paused' }], { now: 0, coolUntil: 9999 }).title, 'Downloads paused');
  assert.equal(downloadStatus([{ state: 'running', retrying: true }]).title, 'Retrying a request');
  assert.equal(downloadStatus([{ state: 'done', unfinished: 2, added: 4 }]).title, 'Some works still need attention');
  assert.equal(downloadStatus([]).title, 'Nothing downloading');
  assert.equal(downloadStatus([{ state: 'cancelled', added: 2 }]).title, 'Downloads stopped');
});

test('mixed jobs offer both pause and resume without describing completion as active', () => {
  const jobs = [{ state: 'queued' }, { state: 'pausing' }, { state: 'done', added: 6 }];
  const before = structuredClone(jobs);
  assert.equal(downloadStatus(jobs).active, 1);
  assert.equal(downloadStatus(jobs).paused, 1);
  assert.deepEqual(jobs, before, 'presentation never mutates scheduling state');
});
