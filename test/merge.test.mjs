import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA } from '../app/core/store/schema.js';
import { MERGE_STEPS, REINDEX_STEPS } from '../app/core/store/merge.js';

const dir = mkdtempSync(join(tmpdir(), 'fanfolio-merge-'));
let n = 0;

function db(file) {
  const d = new DatabaseSync(file);
  d.exec(SCHEMA);
  return d;
}

const addWork = (d, id, title, extra = {}) =>
  d.prepare(`INSERT INTO works (work_id, title, words, chapter_count, kudos_given, in_bookmarks)
             VALUES (?,?,?,?,?,?)`)
    .run(id, title, extra.words ?? 100, extra.chapters ?? 1, extra.kudosGiven ?? 0, extra.bookmarked ?? 0);

const addChapter = (d, id, number, html) =>
  d.prepare('INSERT INTO chapters (work_id, number, title, html, text, words) VALUES (?,?,?,?,?,?)')
    .run(id, number, `Chapter ${number}`, html, html, 10);

/** device + incoming, merged, and the device handed back. */
function merge(build) {
  const devicePath = join(dir, `device-${++n}.db`);
  const incomingPath = join(dir, `incoming-${n}.db`);
  const device = db(devicePath);
  const incoming = db(incomingPath);
  build(device, incoming);
  incoming.close();

  device.exec(`ATTACH '${incomingPath}' AS incoming`);
  device.exec('BEGIN');
  for (const sql of MERGE_STEPS) device.exec(sql);
  for (const sql of REINDEX_STEPS) device.exec(sql);
  device.exec('COMMIT');
  device.exec('DETACH incoming');
  return device;
}

test('a work only in the incoming library arrives', () => {
  const d = merge((device, incoming) => {
    addWork(incoming, '1', 'Newcomer');
    addChapter(incoming, '1', 1, '<p>hello</p>');
    incoming.prepare('INSERT INTO tags (work_id, kind, name) VALUES (?,?,?)').run('1', 'fandom', 'BTS');
  });
  assert.equal(d.prepare('SELECT title FROM works WHERE work_id = ?').get('1').title, 'Newcomer');
  assert.equal(d.prepare('SELECT count(*) n FROM chapters WHERE work_id = ?').get('1').n, 1);
  assert.equal(d.prepare('SELECT count(*) n FROM tags WHERE work_id = ?').get('1').n, 1);
});

test('a work only on the device is left alone', () => {
  const d = merge((device) => {
    addWork(device, '9', 'Mine');
    addChapter(device, '9', 1, '<p>kept</p>');
  });
  assert.equal(d.prepare('SELECT title FROM works WHERE work_id = ?').get('9').title, 'Mine');
  assert.equal(d.prepare('SELECT html FROM chapters WHERE work_id = ?').get('9').html, '<p>kept</p>');
});

test('a changed chapter is archived before it is replaced', () => {
  const d = merge((device, incoming) => {
    addWork(device, '2', 'Revised'); addChapter(device, '2', 1, '<p>the old words</p>');
    addWork(incoming, '2', 'Revised'); addChapter(incoming, '2', 1, '<p>the new words</p>');
  });
  const kept = d.prepare('SELECT html, reason FROM chapter_versions WHERE work_id = ?').get('2');
  assert.equal(kept.html, '<p>the old words</p>', 'the copy that was replaced is still readable');
  assert.equal(kept.reason, 'content');
  assert.equal(d.prepare('SELECT html FROM chapters WHERE work_id = ?').get('2').html, '<p>the new words</p>');
});

test('an unchanged chapter archives nothing', () => {
  const d = merge((device, incoming) => {
    addWork(device, '3', 'Same'); addChapter(device, '3', 1, '<p>identical</p>');
    addWork(incoming, '3', 'Same'); addChapter(incoming, '3', 1, '<p>identical</p>');
  });
  // otherwise every import buries the real changes under untouched chapters
  assert.equal(d.prepare('SELECT count(*) n FROM chapter_versions').get().n, 0);
});

test('reflowed whitespace is not a revision', () => {
  const d = merge((device, incoming) => {
    addWork(device, '4', 'Wrapped'); addChapter(device, '4', 1, '<p>a line\nand another</p>');
    addWork(incoming, '4', 'Wrapped'); addChapter(incoming, '4', 1, '<p>a line and another</p>');
  });
  assert.equal(d.prepare('SELECT count(*) n FROM chapter_versions').get().n, 0);
});

test('a chapter the incoming copy no longer has is kept as removed', () => {
  const d = merge((device, incoming) => {
    addWork(device, '5', 'Shrunk');
    addChapter(device, '5', 1, '<p>one</p>'); addChapter(device, '5', 2, '<p>two</p>');
    addWork(incoming, '5', 'Shrunk'); addChapter(incoming, '5', 1, '<p>one</p>');
  });
  const gone = d.prepare("SELECT number, html FROM chapter_versions WHERE reason = 'removed'").all();
  assert.deepEqual(gone.map((r) => r.number), [2]);
  assert.equal(gone[0].html, '<p>two</p>', 'the text of a chapter that vanished is still there');
});

test('kudos left from the app survive an import', () => {
  const d = merge((device, incoming) => {
    addWork(device, '6', 'Liked', { kudosGiven: 1 });
    addWork(incoming, '6', 'Liked', { kudosGiven: 0 });
  });
  /* The archive offers no way to ask afterwards whether kudos were left, so
     overwriting the flag would offer to leave them a second time. */
  assert.equal(d.prepare('SELECT kudos_given FROM works WHERE work_id = ?').get('6').kudos_given, 1);
});

test('a reading position on the device is not overwritten', () => {
  const d = merge((device, incoming) => {
    addWork(device, '7', 'Underway'); addWork(incoming, '7', 'Underway');
    device.prepare('INSERT INTO reading (work_id, chapter, chapters_read) VALUES (?,?,?)').run('7', 9, 9);
    incoming.prepare('INSERT INTO reading (work_id, chapter, chapters_read) VALUES (?,?,?)').run('7', 2, 2);
  });
  assert.equal(d.prepare('SELECT chapter FROM reading WHERE work_id = ?').get('7').chapter, 9,
    'the device is where the reading happened');
});

test('a reading position only in the incoming copy is taken', () => {
  const d = merge((device, incoming) => {
    addWork(device, '8', 'Elsewhere'); addWork(incoming, '8', 'Elsewhere');
    incoming.prepare('INSERT INTO reading (work_id, chapter, chapters_read) VALUES (?,?,?)').run('8', 4, 4);
  });
  assert.equal(d.prepare('SELECT chapter FROM reading WHERE work_id = ?').get('8').chapter, 4);
});

test('what each library kept of the past is pooled, not duplicated', () => {
  const d = merge((device, incoming) => {
    addWork(device, '10', 'Watched'); addWork(incoming, '10', 'Watched');
    const v = (dbh, when, html) => dbh.prepare(
      `INSERT INTO chapter_versions (work_id, number, title, html, text, words, reason, archived_at)
       VALUES (?,1,'c',?,?,3,'content',?)`).run('10', html, html, when);
    v(device, '2026-01-01', '<p>a</p>');
    v(incoming, '2026-01-01', '<p>a</p>');       // both saw this one
    v(incoming, '2026-02-02', '<p>b</p>');       // only the incoming copy saw this
  });
  const all = d.prepare('SELECT archived_at FROM chapter_versions ORDER BY archived_at').all();
  assert.deepEqual(all.map((r) => r.archived_at), ['2026-01-01', '2026-02-02']);
});

test('the search index covers what arrived', () => {
  const d = merge((device, incoming) => {
    addWork(incoming, '11', 'Findable');
    addChapter(incoming, '11', 1, '<p>petrichor after the rain</p>');
  });
  const hit = d.prepare('SELECT count(*) n FROM chapter_fts WHERE chapter_fts MATCH ?').get('petrichor');
  assert.equal(hit.n, 1, 'a work that arrived is searchable');
});

test('the shell runs the same statements these tests do', async () => {
  const { readFileSync } = await import('node:fs');
  const build = readFileSync(new URL('../android/build.sh', import.meta.url), 'utf8');
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');

  /* A second copy of this SQL written in Java would drift from the one under
     test, and a merge that drifts silently loses reading positions. The build
     emits the tested statements; the shell reads them back. */
  assert.match(build, /emit-merge-sql\.mjs > assets\/web\/merge\.sql/,
    'the build emits the tested statements');
  assert.match(java, /readAsset\("web\/merge\.sql"\)/, 'and the shell reads them');
  assert.ok(!/INSERT INTO chapter_versions/.test(java),
    'the shell must not carry its own copy of the merge');
});

test('a merge that cannot finish changes nothing', async () => {
  const { readFileSync } = await import('node:fs');
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const fn = java.slice(java.indexOf('private void importFrom('));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  assert.match(body, /beginTransaction\(\)/, 'it runs in a transaction');
  assert.match(body, /setTransactionSuccessful\(\)/, 'committed only when every step ran');
  assert.ok(!/new FileOutputStream\(databaseFile\(\)\)/.test(body),
    'and never writes over the library directly, which is what lost everything before');
});
