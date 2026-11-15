import { nativeSource } from './native-source.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';
import { buildWorksQuery } from '../app/core/query.js';
import { createReadRoutes } from '../app/core/routes.js';
import { createQueue } from '../app/core/sync/queue.js';

const placeholder = 'This is part of an ongoing challenge and will be revealed soon!';
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
  const add = db.prepare('INSERT INTO works(work_id,title,authors,summary,words,in_history) VALUES(?,?,?, ?,0,1)');
  add.run('1', null, '[]', placeholder);
  add.run('2', 'Anonymous story', '[]', 'An actual story.');
  add.run('3', 'Saved before hiding', '[]', placeholder);
  add.run('epub-demo', 'Imported book', '["Rowan"]', 'An imported story.');
  add.run('4', 'Mystery Work', '[]', null);
  add.run('5', null, '[ "Anonymous" ]', null); // empty listing with leftover tags and a default chapter count
  db.exec("UPDATE works SET chapter_count=1 WHERE work_id='5'");
  add.run('6', 'Blocked', '["Blocked"]', '');
  db.exec("UPDATE works SET hidden=1 WHERE work_id='6'; INSERT INTO chapters(work_id,number,html,text) VALUES('3',1,'<p>saved</p>','saved');");
  db.exec("INSERT INTO reading(work_id,marked_later) SELECT work_id,1 FROM works");
  db.exec("INSERT INTO tags(work_id,kind,name) SELECT work_id,'fandom','Common fandom' FROM works");
  const routes = createReadRoutes((sql,args=[]) => db.prepare(sql).all(...args));
  const works = filters => { const q=buildWorksQuery(filters); return db.prepare(q.sql).all(...q.args).map(w=>w.work_id).sort(); };
  return {db,routes,works};
}

test('unrevealed works are hidden consistently, without hiding anonymous or saved works', () => {
  const {db,routes,works}=fixture();
  try {
    assert.deepEqual(works({}), ['2','3','epub-demo']);
    assert.deepEqual(works({showUnrevealed:'1'}), ['1','2','3','4','5','epub-demo']);
    const home=routes.read('/api/home');
    assert.equal(home.stats.works,3); assert.equal(home.stats.later,3);
    assert.ok(!home.shelves.some(s => s.key === 'later'), 'Marked for later is not a permanent Home shelf');
    assert.deepEqual(routes.read('/api/works?collection=later').works.map(w=>w.work_id).sort(), ['2','3','epub-demo'],
      'the existing For later collection remains accessible');
    for (const shelf of home.shelves) {
      assert.ok(!shelf.works.some(w=>['1','4','5','6'].includes(w.work_id)));
      assert.ok(shelf.total <= 3);
    }
    assert.equal(home.browse.fandom[0].n,3);
    assert.equal(routes.read('/api/works?collection=visited').total,3);
    // The records still exist; current metadata makes a revealed work reappear.
    db.prepare('UPDATE works SET title=?, summary=? WHERE work_id=?').run('Revealed story','A new story.','1');
    assert.ok(works({}).includes('1'));
  } finally {db.close();}
});

test('job collections intersect ordinary filters and search, including empty and large imports', () => {
  const {db,works}=fixture();
  try {
    assert.deepEqual(works({jobIds:[]}),[]);
    assert.deepEqual(works({jobIds:''}),[]);
    assert.deepEqual(works({jobIds:['2','epub-demo','missing']}),['2','epub-demo']);
    assert.deepEqual(works({jobIds:['2','epub-demo'], ids:['2','3']}),['2']);
    assert.deepEqual(works({jobIds:['2','epub-demo'],author:['Rowan']}),['epub-demo']);
    const many=Array.from({length:20000},(_,i)=>`unused-${i}`).concat('2','epub-demo',"' OR 1=1 --");
    const q=buildWorksQuery({jobIds:many});
    assert.ok(q.args.length < 999,'large import stays within old Android bind limits');
    assert.deepEqual(works({jobIds:many}),['2','epub-demo']);
    assert.deepEqual(works({jobIds:['1','4']}),[]);
    assert.deepEqual(works({jobIds:['1','4'],showUnrevealed:'1'}),['1','4']);
  } finally {db.close();}
});

test('a job keeps a stable collection key across restarts and changed numeric IDs', () => {
  const q=createQueue();
  q.restore({author:'Imported',part:'EPUBs',state:'done',historyComplete:true,items:[{workId:'epub-demo',state:'version'}]});
  q.restore({author:'Download',part:'works',state:'paused',workIds:['2'],historyComplete:true});
  const original=q.list(), saved=q.save();
  const next=createQueue();
  for (const record of saved.reverse()) next.restore(record);
  assert.notEqual(original[0].id,next.list().find(j=>j.key===original[0].key).id);
  assert.equal(new Set(next.list().map(j=>j.key)).size,2);
  const imported=next.list().find(j=>j.key===original[0].key);
  assert.deepEqual(next.details(imported.id).items.map(i=>i.workId),['epub-demo']);
});

test('native listing refresh updates only unrevealed placeholders and preserves reading and saved copies', () => {
  const {db,works}=fixture();
  const sql=JSON.parse(nativeSource().match(/String refreshUnrevealed = ("(?:[^"\\]|\\.)*");/)[1]);
  try {
    const update=db.prepare(`UPDATE works SET title=?,summary=? WHERE ${sql}`);
    for (const id of ['1','2','3','4','5']) update.run('Revealed title','A story.',id);
    const title=id=>db.prepare('SELECT title FROM works WHERE work_id=?').get(id).title;
    assert.equal(title('1'),'Revealed title');
    assert.equal(title('4'),'Revealed title');
    assert.equal(title('5'),'Revealed title');
    assert.equal(title('2'),'Anonymous story');
    assert.equal(title('3'),'Saved before hiding');
    assert.equal(db.prepare('SELECT count(*) n FROM chapters').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM reading WHERE marked_later=1').get().n,7);
    assert.ok(works({}).includes('1'));
  } finally {db.close();}
});

test('empty untitled metadata can be hidden without confusing named anonymous works or untagged books', () => {
  const {db,works}=fixture();
  try {
    assert.ok(!works({}).includes('5'));
    assert.ok(works({showUnrevealed:'1'}).includes('5'));
    for (const authors of [null, '', '[]', '[ ]', '["Anonymous"]', '[\n "anonymous"\n]', '[""]', 'null']) {
      db.prepare('UPDATE works SET authors=? WHERE work_id=?').run(authors, '5');
      assert.ok(!works({}).includes('5'), `empty authors: ${authors}`);
    }
    db.exec("UPDATE works SET authors='[]', title='(Untitled)' WHERE work_id='5'");
    assert.ok(!works({}).includes('5'));
    // Even one substantive field is enough to keep an anonymous work visible.
    for (const [column,value] of [['title','A title'],['summary','A summary'],['words',5],['authors','["Rowan"]']]) {
      db.prepare(`UPDATE works SET ${column}=? WHERE work_id='5'`).run(value);
      assert.ok(works({}).includes('5'),column);
      db.exec("UPDATE works SET title=NULL,summary=NULL,words=0,authors='[]' WHERE work_id='5'");
    }
    db.exec("INSERT INTO chapters(work_id,number,html,text) VALUES('5',1,'saved','saved')");
    assert.ok(works({}).includes('5'));
  } finally {db.close();}
});
