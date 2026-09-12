import 'dart:io';

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

    File(at('archive.db-wal')).writeAsStringSync('not a real log');
    File(at('archive.db-shm')).writeAsStringSync('nor this');

    final back = await Library.importFromStream(
      File(at('backup.db')).openRead(),
      at('archive.db'),
    );
    expect(File(at('archive.db-wal')).existsSync(), isFalse);
    expect((await back.work('58374928'))?.title, 'Stale');
    await back.close();
  });
}
