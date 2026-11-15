import { nativeSource } from './native-source.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';
import { RECORD_VISIT, HISTORY_UPDATE, visitLabel, visitBreakdown } from '../app/core/store/visits.js';
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
    assert.equal(visitLabel(works[0]), '5 visits');
    assert.equal(visitBreakdown(works[0]), '3 on AO3 · 2 in Fan Folio');
    assert.equal(visitLabel(works[2]), '');
    assert.equal(visitLabel({ff_visits:1}), '1 visit');
    assert.equal(visitBreakdown({ff_visits:1}), 'AO3 not synced · 1 in Fan Folio');
    assert.equal(visitBreakdown(works[2]), '');
    assert.equal(db.prepare('SELECT count(*) n FROM reading_visits').get().n,2);
    // A sync is a replacement snapshot; repeated syncs cannot grow the total.
    for (let i=0;i<2;i++) db.prepare(HISTORY_UPDATE).run(7,'24 Sep 2026','2026-09-24T00:00:00Z','1');
    const refreshed = db.prepare(q.sql).all(...q.args)[0];
    assert.equal(refreshed.visits,7); assert.equal(refreshed.ff_visits,2);
  } finally { db.close(); }
});
test('the native visit insert has the same duplicate and orphan protection', () => {
  const java = nativeSource();
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

test('History combines local, completed and AO3 reading, with true chronological dates', () => {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
  try {
    for (let id = 1; id <= 9; id++) db.prepare('INSERT INTO works(work_id,title,chapter_count) VALUES(?,?,1)').run(String(id), `Story ${id}`);
    db.exec(`
      INSERT INTO reading(work_id,opened_at,chapters_read,updated_at) VALUES
        ('1','2026-11-15 09:00:00',1,'2026-11-15 09:00:00'),
        ('2','2026-11-15T08:00:00Z',0,'2026-11-15T08:00:00Z'),
        ('3',NULL,1,'2026-11-14 12:00:00');
      UPDATE works SET in_history=1, last_visited='14 Nov 2026', visits_synced_at='2026-11-16' WHERE work_id='4';
      UPDATE works SET in_history=1, last_visited='2026-11-13', visits=3 WHERE work_id='5';
      UPDATE works SET in_history=1 WHERE work_id='6';
      INSERT INTO reading_visits(id,work_id,started_at) VALUES('session','7','2026-11-15T10:00:00Z');
      INSERT INTO reading(work_id,marked_later,updated_at) VALUES('8',1,'2026-11-16');
      UPDATE works SET hidden=1, in_history=1, last_visited='2026-11-16' WHERE work_id='9';
    `);
    const q = buildWorksQuery({ collection: 'visited', sort: 'recent' });
    const rows = db.prepare(q.sql).all(...q.args);
    assert.deepEqual(rows.map(w => w.work_id), ['7','1','2','3','4','5','6']);
    assert.equal(rows.find(w => w.work_id === '4').last_read_at, '2026-11-14 00:00:00');
    assert.equal(rows.at(-1).last_read_at, null, 'unknown visit dates sort last without inventing a sync date');
    assert.equal(db.prepare(q.countSql).get(...q.args).n, 7);
    const ao3 = buildWorksQuery({ collection: 'history', sort: 'recent' });
    assert.deepEqual(db.prepare(ao3.sql).all(...ao3.args).map(w => w.work_id), ['4','5','6'], 'AO3-only filter stays available');
    db.exec("UPDATE works SET last_visited='16 Nov 2026', in_history=1 WHERE work_id='1'");
    assert.equal(db.prepare(q.sql).all(...q.args)[0].work_id,'1','a later AO3 visit supersedes local reading');
  } finally { db.close(); }
});

test('history parsing stores a sortable date and older single-digit AO3 dates remain readable', () => {
  const w = parseBlurb('<li id="work_1"><h4 class="viewed heading">Last visited: 4 Sep 2026 Visited once</h4></li>');
  assert.equal(w.lastVisited, '2026-09-04');
  const db = library();
  try {
    db.exec("UPDATE works SET in_history=1,last_visited='4 Sep 2026' WHERE work_id='1'");
    const q = buildWorksQuery({ collection:'history',sort:'recent' });
    assert.equal(db.prepare(q.sql).get(...q.args).last_read_at,'2026-09-04 00:00:00');
  } finally { db.close(); }
});
