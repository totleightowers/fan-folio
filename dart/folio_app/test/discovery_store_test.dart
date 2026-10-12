import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/discovery_store.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/store.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'test_database.dart';

void main() {
  setUpAll(prepareTestDatabase);
  test('a saved search survives backup and import without replacing other metadata', () async {
    final scratch = await Directory.systemTemp.createTemp('folio-discovery');
    final library = await Library.create('${scratch.path}/library.db');
    Library? restored;
    try {
      await library.saveReadingPrefs(const core.ReadingPrefs(size: 23));
      const saved = SavedSearch(
        id: '1',
        name: 'Evening reading',
        search: core.ArchiveSearch(
          fields: {'relationship_names': 'A/B', 'complete': 'T'},
        ),
        seen: ['123'],
        checked: '2026-10-12',
      );
      await DiscoveryStore(library).save(saved);
      await library.backupTo('${scratch.path}/backup.db');
      restored = await Library.importFromStream(
        File('${scratch.path}/backup.db').openRead(),
        '${scratch.path}/restored.db',
      );
      expect(
        (await DiscoveryStore(restored).all()).single.toJson(),
        saved.toJson(),
      );
      expect((await restored.readingPrefs()).size, 23);
      await DiscoveryStore(restored).remove('1');
      expect(await DiscoveryStore(restored).all(), isEmpty);
      expect((await restored.readingPrefs()).size, 23);
    } finally {
      await restored?.close();
      await library.close();
      await scratch.delete(recursive: true);
    }
  });

  test('reading a discovered work keeps personal flags and versions', () async {
    final scratch = await Directory.systemTemp.createTemp('folio-discovery');
    final library = await Library.create('${scratch.path}/library.db');
    try {
      final blurb = core
          .parseListing('''
        <li id="work_123" class="work blurb"><h4 class="heading">
        <a href="/works/123">Discovery</a> by <a rel="author">Writer</a></h4>
        <blockquote class="summary">A searchable summary.</blockquote></li>
      ''')
          .works
          .single;
      expect(await saveStubs(library.db, [blurb]), 1);
      expect(await saveStubs(library.db, [blurb]), 0);
      expect((await library.searchMeta('Discovery')).single.workId, '123');
      await library.db.update(
        'works',
        {'marked_later': 1, 'in_bookmarks': 1, 'kudos_given': 1, 'hits': 456},
        where: 'work_id = ?',
        whereArgs: ['123'],
      );
      final store = LibraryStore(library.db);
      core.StoredWork work(String text) => core.StoredWork(
        workId: '123',
        title: 'Discovery',
        authors: ['Writer'],
        tags: {},
        chapters: [
          core.StoredChapter(
            number: 1,
            html: '<p>$text</p>',
            text: text,
            words: 1,
          ),
        ],
      );
      await store.save(work('Before'));
      await library.savePlace('123', 1, 40);
      await store.save(work('After'));
      final kept = (await library.work('123'))!;
      expect(kept.markedLater, isTrue);
      expect(kept.inBookmarks, isTrue);
      expect(kept.kudosGiven, isTrue);
      expect(kept.hits, 456);
      expect((await library.placeIn('123'))?.offset, 40);
      expect(await library.chapterHtml('123', 1), contains('After'));
      final versions = await library.db.query(
        'chapter_versions',
        where: 'work_id = ?',
        whereArgs: ['123'],
      );
      expect(versions.single['html'], contains('Before'));
    } finally {
      await library.close();
      await scratch.delete(recursive: true);
    }
  });
}
