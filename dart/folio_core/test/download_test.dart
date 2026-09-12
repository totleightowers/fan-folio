import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// Turning a work id into rows, without an archive and without a phone.
///
/// The parser is held to real chapters elsewhere. What is here is the piece
/// between the parts: that a page becomes a work, that a work the reader
/// deleted does not come back, and that a job asks the library whether the
/// text arrived rather than assuming it did because nothing threw.
class _Store implements WorkStore {
  final List<StoredWork> saved = [];
  final Set<String> have = {};
  final Set<String> gone = {};

  @override
  Future<void> save(StoredWork work) async {
    saved.add(work);
    have.add(work.workId);
  }

  @override
  Future<Set<String>> held(List<String> workIds) async =>
      workIds.where(have.contains).toSet();

  @override
  Future<Set<String>> refused(List<String> workIds) async =>
      workIds.where(gone.contains).toSet();
}

void main() {
  // the same fixture 1.x is parsed against; a second copy of it would be a
  // second thing that can drift
  final workHtml =
      File('../../test/fixtures/work-page.html').readAsStringSync();

  Pacer instant() => Pacer(sleep: (_) async {}, now: () => DateTime(2026));

  /// A page as the archive actually sends one: bytes, and a charset.
  http.Response html(String body, int status) => http.Response.bytes(
        utf8.encode(body),
        status,
        headers: {'content-type': 'text/html; charset=utf-8'},
      );

  Downloader downloaderFor(
    _Store store, {
    Future<http.Response> Function(http.Request)? answer,
  }) =>
      Downloader(
        client: ArchiveClient(
          pacer: instant(),
          http_: MockClient(answer ?? (_) async => html(workHtml, 200)),
        ),
        store: store,
      );

  test('a work page becomes a work', () async {
    final store = _Store();
    await downloaderFor(store).run('58374928');

    final work = store.saved.single;
    expect(work.workId, '58374928');
    expect(work.title, isNotEmpty);
    expect(work.authors, isNotEmpty);
    expect(work.chapters, isNotEmpty);

    for (final chapter in work.chapters) {
      expect(chapter.html, isNotEmpty);
      expect(chapter.text, isNotEmpty, reason: 'a chapter nobody can search');
      expect(chapter.words, greaterThan(0));
      expect(chapter.text, isNot(contains('<')),
          reason: 'the searchable text is words, not markup');
    }
    expect(work.chapters.map((c) => c.number), [
      for (var i = 1; i <= work.chapters.length; i++) i,
    ]);
  });

  test('and it is asked for at the address of a work', () async {
    final asked = <Uri>[];
    final store = _Store();
    await downloaderFor(store, answer: (request) async {
      asked.add(request.url);
      return html(workHtml, 200);
    }).run('58374928');

    expect('${asked.single}', contains('/works/58374928'));
    expect(asked.single.host, 'archiveofourown.org');
  });

  test('a page with no chapters says so rather than storing a stub', () async {
    /* Locked to registered users, deleted, or a draft — all three look the
       same from here, and a work stored with no text is a work the library
       claims to hold and cannot open. */
    final store = _Store();
    await expectLater(
      downloaderFor(
        store,
        answer: (_) async => html('<html><body>nothing</body>', 200),
      ).run('1'),
      throwsA(isA<ArchiveError>()),
    );
    expect(store.saved, isEmpty);
  });

  test('a work the reader deleted does not come back', () async {
    /* A listing still mentions it, and fetching it again on that basis is the
       app overruling them. The tombstone exists so that does not happen. */
    final store = _Store()..gone.add('58374928');
    await downloaderFor(store).run('58374928');
    expect(store.saved, isEmpty);
  });

  test('what is still missing is asked of the library, not counted', () async {
    /* A job that decides it has finished because nothing threw reports itself
       complete while the works it queued are still descriptions with no
       text. */
    final store = _Store()
      ..have.add('here')
      ..gone.add('deleted');
    final downloader = downloaderFor(store);

    expect(await downloader.missing(['here', 'deleted', 'wanted']), ['wanted']);
    expect(await downloader.missing(const []), isEmpty);
  });

  test('a failure keeps the words the retry rules read', () async {
    final store = _Store();
    try {
      await downloaderFor(
        store,
        answer: (_) async => html('slow down', 429),
      ).run('1');
      fail('a 429 is not a work');
    } on ArchiveError catch (e) {
      expect(isTransient(e.message), isTrue);
    }

    try {
      await downloaderFor(
        store,
        answer: (_) async => html('gone', 404),
      ).run('1');
      fail('a 404 is not a work');
    } on ArchiveError catch (e) {
      expect(isTransient(e.message), isFalse);
    }
  });
}
