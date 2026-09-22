import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobSource } from '../app/core/sync/job-source.js';
import { downloadIdentity, downloadFailure } from '../app/core/downloads.js';
import { createQueue } from '../app/core/sync/queue.js';
const settle = () => new Promise(r => setTimeout(r, 0));
const js = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');

test('legacy job labels recover bookmark, series and import operations', () => {
  assert.deepEqual(jobSource({ author: 'Your bookmarks', part: 'new ones' }), { kind: 'bookmarks-new' });
  assert.deepEqual(jobSource({ author: 'Your bookmarks', part: 'the whole list' }), { kind: 'bookmarks-all' });
  assert.deepEqual(jobSource({ author: 'Series 123', part: 'works' }), { kind: 'series', seriesId: '123' });
  assert.deepEqual(jobSource({ author: 'Your EPUBs' }), { kind: 'epub' });
  assert.deepEqual(jobSource({ author: 'Your library', part: 'described but not held' }), { kind: 'saved' });
});

test('an explicit source survives persistence and display-label changes', async () => {
  const q = createQueue({ runTask: async () => {} });
  q.add({ author: 'A collection', part: 'download', source: { kind: 'series', seriesId: '42' }, workIds: ['1'] });
  await settle(); const saved = q.save()[0];
  const restored = createQueue(); restored.restore({ ...saved, author: 'A renamed collection' });
  assert.deepEqual(restored.list()[0].source, { kind: 'series', seriesId: '42' });
});

test('Run again calls the original bookmark, series and EPUB operations', async () => {
  const from = js.indexOf('async function runAgain(job) {');
  const source = js.slice(from, js.indexOf('\n}\n', from) + 2);
  const calls = [];
  const args = { jobSource, isStubsJob: () => false, isNative: true, signedIn: () => true,
    syncBookmarks: async () => calls.push('new'), reconcileAllBookmarks: async () => calls.push('all'),
    addWork: async url => { calls.push(url); return { kind: 'series', seriesId: '123', workIds: ['1'] }; },
    jobs: { add: () => 1, note: () => {}, seal: () => {} },
    queueSeries: () => true, AO3: 'https://archiveofourown.org',
    $: () => ({ click: () => calls.push('picker') }), toast: message => { throw new Error(message); },
    walkAuthor: () => { throw new Error('Wrongly used an author route'); },
  };
  const runAgain = new Function(...Object.keys(args), source + '\nreturn runAgain;')(...Object.values(args));
  for (const job of [{ author: 'Your bookmarks', part: 'new ones' }, { author: 'Your bookmarks', part: 'the whole list' },
    { author: 'Series 123', part: 'works' }, { author: 'Your EPUBs' }]) await runAgain(job);
  assert.deepEqual(calls, ['new', 'all', 'https://archiveofourown.org/series/123', 'picker']);
});

test('retrying one failed work preserves other failures and successes', async () => {
  const calls = []; const q = createQueue({ runTask: async id => { calls.push(id); return { title: 'Recovered title', authors: ['A writer'] }; }, wait: async () => {}, gap: () => 0 });
  const id = q.restore({ author: 'a', part: 'works', state: 'done', historyComplete: true, total: 3,
    items: [{workId:'1',state:'downloaded'}, {workId:'2',state:'failed',error:'525'}, {workId:'3',state:'failed',error:'404'}] });
  assert.equal(q.retry(id, ['2']), true); await settle();
  assert.deepEqual(calls, ['2']);
  assert.deepEqual(q.details(id).items.map(i => i.state), ['downloaded','downloaded','failed']);
  assert.deepEqual([q.list()[0].added, q.list()[0].failed, q.list()[0].total], [2,1,3]);
  assert.equal(q.details(id).items[1].attempts, 1);
  assert.ok(q.details(id).items[1].lastAttemptAt);
  const restored = createQueue(); const again = restored.restore(q.save()[0]);
  assert.deepEqual(restored.details(again).items, q.details(id).items);
});

test('requeueing a failure while another work runs does not duplicate that runner', async () => {
  const calls = []; let release; let first = true;
  const q = createQueue({ runTask: async id => {
    calls.push(id);
    if (id === '1' && first) { first = false; throw new Error('404'); }
    if (id === '2') await new Promise(r => { release = r; });
  }, wait: async () => {}, gap: () => 0 });
  const id = q.add({ author: 'a', part: 'works', workIds: ['1','2'] }); await settle();
  assert.equal(q.retry(id, ['1']), true);
  assert.equal(q.retry(id, ['1']), false, 'cannot add the same pending retry twice');
  assert.deepEqual(calls, ['1','2']); release(); await settle();
  assert.deepEqual(calls, ['1','2','1']);
  assert.deepEqual([q.list()[0].added,q.list()[0].failed,q.list()[0].total], [2,0,2]);
});

test('an automatic retry records its deadline and clears it once downloaded', async () => {
  let release, calls = 0;
  const q = createQueue({ runTask: async () => { if (++calls === 1) throw new Error('525'); },
    shouldRetry: () => true, wait: () => new Promise(r => { release = r; }), gap: () => 0, retryWait: () => 60000 });
  const id = q.add({ author: 'a', part: 'works', workIds: ['1'] }); await settle();
  const item = q.details(id).items[0]; assert.equal(item.state, 'retrying');
  assert.ok(item.nextRetryAt >= item.lastAttemptAt + 60000);
  release(); await settle();
  assert.equal(q.details(id).items[0].attempts, 2); assert.equal(q.details(id).items[0].nextRetryAt, null);
});

test('missing and literal-null metadata gets an identifiable label without inventing an author', () => {
  assert.deepEqual(downloadIdentity({ title: 'null', authors: '[]', has_text: 0 }, { workId: '42' }), { title: 'Work 42', by: 'Author unavailable' });
  assert.deepEqual(downloadIdentity({ title: 'A real anonymous story', authors: '[]' }, { workId: '42' }), { title: 'A real anonymous story', by: 'Anonymous' });
  assert.deepEqual(downloadIdentity(null, { workId: '42', title: 'A saved title', authors: ['A writer'] }), { title: 'A saved title', by: 'A writer' });
  assert.deepEqual(downloadIdentity(null, { workId: 'epub-1', title: 'A file.epub', state: 'failed' }), { title: 'A file.epub', by: 'Author unavailable' });
  assert.equal(downloadFailure('The archive answered 525'), 'Archive temporarily unavailable');
  assert.equal(downloadFailure('That work has been deleted'), 'Unavailable on the archive');
});

test('a selected retry is not lost when it arrives during save verification', async () => {
  const calls = []; let finish; let first = true;
  const q = createQueue({ runTask: async id => { calls.push(id); if (id === '1' && first) { first = false; throw new Error('404'); } },
    wait: async () => {}, gap: () => 0, verify: () => new Promise(r => { finish = r; }) });
  const id = q.add({ author: 'a', part: 'works', workIds: ['1','2'] }); await settle();
  q.retry(id, ['1']); finish([]); await settle(); finish([]); await settle();
  assert.deepEqual(calls, ['1','2','1']); assert.equal(q.list()[0].added, 2); assert.equal(q.list()[0].state, 'done');
});

test('queueing one stopped work preserves the remaining stopped outcomes', async () => {
  const calls = []; const q = createQueue({ runTask: async id => calls.push(id), wait: async () => {}, gap: () => 0 });
  const id = q.restore({ author: 'a', part: 'works', state: 'cancelled', historyComplete: true,
    workIds: ['2','3'], items: [{workId:'1',state:'downloaded'}, {workId:'2',state:'waiting'}, {workId:'3',state:'waiting'}] });
  q.retry(id, ['2']); await settle();
  assert.deepEqual(calls, ['2']);
  assert.deepEqual(q.details(id).items.map(i => i.state), ['downloaded','downloaded','stopped']);
  assert.equal(q.list()[0].stopped, 1); assert.equal(q.list()[0].waiting, 0);
});
