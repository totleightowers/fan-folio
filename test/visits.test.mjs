import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';
import { RECORD_VISIT, HISTORY_UPDATE, visitLabel } from '../app/core/store/visits.js';
import { buildWorksQuery } from '../app/core/query.js';
import { walkHistory } from '../app/core/sync/history.js';
import { parseBlurb } from '../app/core/ao3/parse.js';

const library = () => {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
  for (const [id, visits, hits] of [['1', 3, 1000], ['2', 4, 1], ['3', null, 99999]]) {
    db.prepare('INSERT INTO works(work_id,title,visits,hits) VALUES(?,?,?,?)').run(id, id, visits, hits);
  }
  return db;
};
test('Most read adds AO3 snapshots and deduplicated FF visits, not public hits', () => {
  const db = library();
  try {
    for (const id of ['a','b','b']) db.prepare(RECORD_VISIT).run(id, '1');
    db.prepare(RECORD_VISIT).run('orphan', 'missing');
    const q = buildWorksQuery({ sort: 'visits' });
    const works = db.prepare(q.sql).all(...q.args);
    assert.deepEqual(works.map(w=>w.work_id), ['1','2','3']);
    assert.equal(works[0].ff_visits, 2);
    assert.equal(visitLabel(works[0]), '5 visits · 3 AO3 + 2 Fan Folio');
    assert.equal(visitLabel(works[2]), '');
    assert.equal(visitLabel({ff_visits:1}), '1 visit · AO3 not synced + 1 Fan Folio');
    assert.equal(db.prepare('SELECT count(*) n FROM reading_visits').get().n,2);
    // A sync is a replacement snapshot; repeated syncs cannot grow the total.
    for (let i=0;i<2;i++) db.prepare(HISTORY_UPDATE).run(7,'24 Sep 2026','2026-09-24T00:00:00Z','1');
    const refreshed = db.prepare(q.sql).all(...q.args)[0];
    assert.equal(refreshed.visits,7); assert.equal(refreshed.ff_visits,2);
  } finally { db.close(); }
});
test('the native visit insert has the same duplicate and orphan protection', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java',import.meta.url),'utf8');
  const body = java.slice(java.indexOf('public String recordVisit('),java.indexOf('public String saveHistory('));
  const sql = JSON.parse(body.match(/db.execSQL\(("[^"\n]+")/)[1]);
  const db=library();
  try {
    db.prepare(sql).run('one','1'); db.prepare(sql).run('one','1'); db.prepare(sql).run('gone','missing');
    assert.equal(db.prepare('SELECT count(*) n FROM reading_visits').get().n,1);
  } finally { db.close(); }
});
test('AO3 history parses grouped counts and once without inventing an unknown count', () => {
  for (const [text,expected] of [['Visited 1,234 times',1234],['Visited once',1],['Visited 1 time',1],['Last visited: 24 Sep 2026',null]]) {
    const w=parseBlurb(`<li id="work_1"><h4 class="viewed heading">${text}</h4></li>`);
    assert.equal(w.visits,expected);
  }
});
test('history walk saves snapshots before checkpointing, resumes, and respects Stop', async () => {
  const calls=[], saved=[], progress=[];
  const options={fetchPage:async page=>{calls.push(page);return {works:[{workId:String(page),visits:page}],pagination:{total:3}};},
    savePage:async works=>{saved.push(...works);return works.length;},waitUntilRunnable:async()=>true,onProgress:p=>progress.push(p)};
  assert.deepEqual(await walkHistory({...options,fromPage:2}),{complete:true,checked:2});
  assert.deepEqual(calls,[2,3]); assert.deepEqual(saved.map(w=>w.workId),['2','3']);
  assert.equal(progress.at(-1).page,3);
  calls.length=0;
  assert.deepEqual(await walkHistory({...options,waitUntilRunnable:async()=>false}),{complete:false,checked:0});
  assert.deepEqual(calls,[]);
  await assert.rejects(walkHistory({...options,savePage:async()=>{throw new Error('storage failed');}}),/storage failed/);
  assert.equal(progress.length,2,'failed storage does not advance checkpoint');
});
