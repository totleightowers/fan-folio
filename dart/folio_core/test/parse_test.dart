import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// The Dart parser, held to what 1.x reads out of the same saved pages.
///
/// A parser is the one place where being subtly wrong is invisible: a work
/// with the wrong tags, a chapter count off by one, an author dropped from a
/// byline — none of it announces itself. It sits in the library looking like
/// data, and is found months later by somebody wondering where a fic went.
void main() {
  final fixture =
      jsonDecode(File('test/conformance/parse.json').readAsStringSync())
          as Map<String, Object?>;

  /// The saved pages themselves, not copies of them.
  ///
  /// A second set of fixtures is a second set that can drift, and the whole
  /// point of this file is that the two implementations read the same bytes.
  /// These are the ones the JavaScript tests read.
  String page(String name) =>
      File('../../test/fixtures/$name').readAsStringSync();

  group('a listing says what 1.x says it says', () {
    for (final entry
        in (fixture['listings'] as List).cast<Map<String, Object?>>()) {
      final name = entry['fixture'] as String;
      test(name, () {
        final expected = (entry['works'] as List).cast<Map<String, Object?>>();
        final actual = parseListing(page(name));

        expect(actual.works.length, expected.length,
            reason:
                'a work missed here is a work the library never learns about');

        for (var i = 0; i < expected.length; i++) {
          final want = expected[i];
          final got = actual.works[i];
          expect(got.workId, want['workId'], reason: 'work $i');
          expect(got.title, want['title'], reason: 'title of ${got.workId}');
          expect(got.authors, want['authors'],
              reason: 'authors of ${got.workId}');
          expect(got.words, want['words'], reason: 'words of ${got.workId}');
          expect(got.chapters, want['chapters'],
              reason: 'chapters of ${got.workId}');
          expect(got.complete, want['complete'],
              reason: 'complete of ${got.workId}');
          expect(got.rating, want['rating'], reason: 'rating of ${got.workId}');
          expect(got.fandoms, want['fandoms'],
              reason: 'fandoms of ${got.workId}');
          expect(got.relationships, want['relationships'],
              reason: 'relationships of ${got.workId}');
          expect(got.characters, want['characters'],
              reason: 'characters of ${got.workId}');
          expect(got.freeform, want['freeform'],
              reason: 'freeform of ${got.workId}');
          expect(got.warnings, want['warnings'],
              reason: 'warnings of ${got.workId}');
          expect(got.summary, want['summary'],
              reason: 'summary of ${got.workId}');
          expect(got.language, want['language'],
              reason: 'language of ${got.workId}');
          expect(got.updatedAt, want['updatedAt'],
              reason: 'the epoch is the authority on whether a work changed');
        }

        final pagination = entry['pagination'] as Map<String, Object?>;
        expect(actual.total, pagination['total'],
            reason: 'a walk that thinks there is one page reads one page');
      });
    }
  });

  test('a work page says what 1.x says it says', () {
    final want = fixture['work'] as Map<String, Object?>;
    final meta = want['meta'] as Map<String, Object?>;
    final got = parseWorkPage(page('work-page.html'));

    expect(got.workId, want['workId']);
    expect(got.title, want['title']);
    expect(got.authors, want['authors']);
    expect(got.summary, want['summary']);
    expect(got.chapters.length, want['chapterCount'],
        reason: 'a chapter missed is a chapter nobody can read');
    expect(got.skinCss != null, want['hasSkin'],
        reason: 'a skin missed means the work is read in the wrong hand');

    expect(got.words, meta['words']);
    expect(got.language, meta['language']);
    expect(got.rating, meta['rating']);
    expect(got.complete, meta['complete']);
    expect(got.fandoms, meta['fandoms']);
    expect(got.tags['relationship'], meta['relationships']);
    expect(got.tags['character'], meta['characters']);
    expect(got.tags['freeform'], meta['freeform']);
    expect(got.tags['warning'], meta['warnings']);
    expect(got.tags['category'], meta['categories']);
  });

  test('every chapter comes back with something in it', () {
    final work = parseWorkPage(page('work-page.html'));
    for (final chapter in work.chapters) {
      expect(chapter.html.trim(), isNotEmpty,
          reason: 'chapter ${chapter.number} parsed to nothing');
    }
  });

  test('markup nobody closed is still read', () {
    /* The archive's templates and twenty years of hand-written fic are not
       always well-formed. A parser that gives up on the first unclosed tag
       loses the rest of the page. */
    final listing = parseListing(
      '<li class="work blurb" id="work_7"><h4 class="heading">'
      '<a href="/works/7">Half a tag<a rel="author">ann</h4></li>',
    );
    expect(listing.works.single.workId, '7');
    expect(listing.works.single.title, 'Half a tag');
  });

  test('nothing at all is nothing, not a crash', () {
    expect(parseListing('').works, isEmpty);
    expect(parseListing(null).works, isEmpty);
    expect(parseWorkPage(null).chapters, isEmpty);
  });
}
