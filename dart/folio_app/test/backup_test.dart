import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/library.dart';
import 'package:folio_core/folio_core.dart' as core;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// Backing a library up, and getting it back.
///
/// The one thing in this app that, if it is wrong, loses everything else — so
/// it is exercised rather than believed. A backup is made, the library is
/// changed underneath it, the backup is brought back, and what comes back is
/// checked against what went in.
void main() {
  late Directory scratch;

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('folio-backup');
  });

  tearDown(() async {
    if (scratch.existsSync()) await scratch.delete(recursive: true);
  });

  String at(String name) => '${scratch.path}/$name';

  Future<Library> aLibraryWith({required String title}) async {
    final library = await Library.create(at('archive.db'));
    await library.db.insert('works', {
      'work_id': '58374928',
      'title': title,
      'authors': '["cendrillon"]',
      'summary': 'A summary that must survive the trip.',
      'words': 4200,
      'chapter_count': 2,
      'has_text': 1,
    });
    await library.db.insert('chapters', {
      'work_id': '58374928',
      'number': 1,
      'title': 'The first',
      'html': '<p>Words that must survive the trip.</p>',
      'text': 'Words that must survive the trip.',
      'words': 6,
    });
    await library.db.insert('tags', {
      'work_id': '58374928',
      'kind': 'fandom',
      'name': 'BTS',
    });
    await library.db.insert('reading', {
      'work_id': '58374928',
      'chapter': 2,
      'offset': 1400,
      'chapters_read': 1,
    });
    /* A picture, with its bytes. This is the part of a library that is
       measured in megabytes rather than rows, and the part a backup is most
       likely to quietly leave behind. */
    await library.db.insert('images', {
      'work_id': '58374928',
      'url': 'https://i.example/one.png',
      'sha256': 'a' * 64,
      'mime': 'image/png',
      'bytes': Uint8List.fromList([137, 80, 78, 71, 13, 10, 26, 10]),
      'status': 'stored',
      'fetched_at': '2026-01-01 00:00:00',
    });

    /* What a chapter used to say. An author who rewrites a scene takes the
       old one with them; the copy on the device is the only record of it. */
    await library.db.insert('chapter_versions', {
      'work_id': '58374928',
      'number': 1,
      'html': '<p>What it used to say.</p>',
      'text': 'What it used to say.',
      'words': 5,
      'reason': 'content',
      'archived_at': '2026-01-01 00:00:00',
    });
    await library.db.insert('skin_versions', {
      'work_id': '58374928',
      'skin_css': '#workskin p { color: red }',
      'archived_at': '2026-01-01 00:00:00',
    });

    // and the small facts that are nobody's data but decide what is shown
    await library.db.insert('deleted', {
      'work_id': 'let-it-stay-gone',
      'title': 'Deleted on purpose',
      'at': '2026-01-01',
    });
    await library.db.insert('blocked', {
      'name': 'somebody',
      'at': '2026-01-01',
    });
    await library.db.insert('bookmarked_by', {
      'person': 'cendrillon',
      'work_id': '58374928',
      'at': '2026-01-01',
    });

    await library.saveReadingPrefs(const core.ReadingPrefs(size: 22));
    return library;
  }

  test('everything goes out and everything comes back', () async {
    final library = await aLibraryWith(title: 'The Long Way Down');
    final bytes = await library.backupTo(at('backup.db'));
    expect(bytes, greaterThan(0));
    await library.close();

    /* Changed underneath, so what comes back is provably the backup rather
       than the library that happened to be sitting there. */
    final since = await Library.openExisting(at('archive.db'));
    await since!.db.delete('works');
    await since.close();

    final back = await Library.importFromStream(
      File(at('backup.db')).openRead(),
      at('archive.db'),
    );

    final work = await back.work('58374928');
    expect(work, isNotNull);
    expect(work!.title, 'The Long Way Down');
    expect(work.authors, ['cendrillon']);
    expect(work.summary, 'A summary that must survive the trip.');

    expect(await back.chapterHtml('58374928', 1), contains('must survive'));
    expect(await back.tagsFor('58374928'), {
      'fandom': ['BTS'],
    });

    // where the reader had got to, which is the half nobody notices missing
    final place = await back.placeIn('58374928');
    expect(place?.chapter, 2);
    expect(place?.offset, 1400);

    // and how they read, which travels with the library rather than the app
    expect((await back.readingPrefs()).size, 22);

    /* The megabytes. A picture that does not come back is a chapter that
       reads differently on the new phone, and nothing says so. */
    final pictures = await back.picturesFor('58374928');
    expect(pictures.keys, ['https://i.example/one.png']);
    expect(pictures.values.single.bytes, hasLength(8));
    expect(pictures.values.single.mime, 'image/png');

    // what a chapter used to say, and what a skin used to be
    final versions = await back.db.query('chapter_versions');
    expect(versions.single['text'], 'What it used to say.');
    expect(
      (await back.db.query('skin_versions')).single['skin_css'],
      contains('color: red'),
    );

    // and the small facts that decide what is shown
    expect(await back.refusedIds(), contains('let-it-stay-gone'));
    expect(await back.blockedNames(), ['somebody']);
    expect((await back.bookmarkedBy('cendrillon')).map((w) => w.workId), [
      '58374928',
    ]);
    await back.close();
  });

  test('the library that was there is set aside, not deleted', () async {
    /* Being wrong about which file to import should cost a rename rather
       than a library. */
    final library = await aLibraryWith(title: 'The one already here');
    await library.backupTo(at('backup.db'));
    await library.close();

    await Library.importFromStream(
      File(at('backup.db')).openRead(),
      at('archive.db'),
    ).then((it) => it.close());

    final aside = scratch
        .listSync()
        .whereType<File>()
        .where((f) => f.path.contains('.replaced-'))
        .toList();
    expect(aside, hasLength(1), reason: 'the old library is still on disk');
    expect(aside.single.lengthSync(), greaterThan(0));
  });

  test('a backup taken with unwritten reading in it is not short', () async {
    /* The database runs in WAL mode, so it is really several files. Copying
       archive.db alone drops whatever the log still holds — which is the most
       recent reading of all, and a backup missing the last hour is worse than
       none because it is trusted. */
    final library = await aLibraryWith(title: 'Checkpointed');
    await library.db.insert('reading', {
      'work_id': 'latest',
      'chapter': 9,
      'offset': 99,
    });

    await library.backupTo(at('backup.db'));
    await library.close();

    final back = await Library.importFromStream(
      File(at('backup.db')).openRead(),
      at('restored.db'),
    );
    final place = await back.placeIn('latest');
    expect(place?.chapter, 9, reason: 'the write-ahead log was folded in');
    await back.close();
  });

  test('the stale log beside a library is not carried over', () async {
    /* A -wal and a -shm belong to the file they were written beside. Left in
       place they describe a database that is no longer there. */
    final library = await aLibraryWith(title: 'Stale');
    await library.backupTo(at('backup.db'));
    await library.close();

    const stale = 'not a real log';
    File(at('archive.db-wal')).writeAsStringSync(stale);
    File(at('archive.db-shm')).writeAsStringSync('nor this');

    final back = await Library.importFromStream(
      File(at('backup.db')).openRead(),
      at('archive.db'),
    );

    /* Not that there is no log — opening the restored library writes one of
       its own, which is the database working. What must not survive is the
       one that belonged to the file that was replaced. */
    final now = File(at('archive.db-wal'));
    if (now.existsSync()) {
      expect(now.readAsStringSync(), isNot(contains(stale)));
    }
    expect(File(at('archive.db-shm')).existsSync(), isTrue);
    expect((await back.work('58374928'))?.title, 'Stale');
    await back.close();
  });
}
