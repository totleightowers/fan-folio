import 'dart:convert';

import 'package:folio_core/folio_core.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// The three things that leave the phone.
///
/// Kudos are permanent, a comment notifies the author, a bookmark appears on
/// a profile. None of them can be taken back by this app, so what is checked
/// here is that each sends what the archive's own form asked for and nothing
/// it did not — and that a form pointing anywhere else is refused.
void main() {
  Pacer instant() => Pacer(sleep: (_) async {}, now: () => DateTime(2026));

  http.Response page(String body, [int status = 200]) => http.Response.bytes(
        utf8.encode(body),
        status,
        headers: {'content-type': 'text/html; charset=utf-8'},
      );

  const kudosPage = '''
<html><body>
<form class="new_kudo" id="new_kudo" action="/kudos" method="post">
  <input type="hidden" name="authenticity_token" value="a+b/c=" />
  <input type="hidden" name="kudo[commentable_id]" value="58374928" />
  <input type="hidden" name="kudo[commentable_type]" value="Work" />
  <input type="submit" name="commit" value="Kudos" />
</form></body></html>''';

  const bookmarkPage = '''
<html><body>
<form id="bookmark-form" action="/works/58374928/bookmarks" method="post">
  <input type="hidden" name="authenticity_token" value="tok" />
  <textarea name="bookmark[bookmarker_notes]"></textarea>
  <input type="text" name="bookmark[tag_string]" value="" />
  <input type="checkbox" name="bookmark[private]" value="1" />
  <input type="checkbox" name="bookmark[rec]" value="1" />
  <select name="bookmark[pseud_id]">
    <option value="7" selected>mine</option>
  </select>
</form></body></html>''';

  const commentPage = '''
<html><body>
<form id="new_comment" action="/works/58374928/comments" method="post">
  <input type="hidden" name="authenticity_token" value="tok" />
  <textarea name="comment[comment_content]"></textarea>
</form></body></html>''';

  ({Acts acts, List<String> bodies, List<Uri> to}) actor(String form) {
    final bodies = <String>[];
    final to = <Uri>[];
    final acts = Acts(
      ArchiveClient(
        pacer: instant(),
        http_: MockClient((request) async {
          if (request.method == 'GET') return page(form);
          to.add(request.url);
          bodies.add(request.body);
          return page('<p>done</p>');
        }),
      ),
    );
    return (acts: acts, bodies: bodies, to: to);
  }

  group('kudos', () {
    test('sends the form the work carried', () async {
      final it = actor(kudosPage);
      final done = await it.acts.kudos('58374928');

      expect(done.already, isFalse);
      expect('${it.to.single}', 'https://archiveofourown.org/kudos');
      expect(it.bodies.single, contains('authenticity_token=a%2Bb%2Fc%3D'));
      expect(it.bodies.single, contains('kudo%5Bcommentable_id%5D=58374928'));
      expect(it.bodies.single, isNot(contains('commit')),
          reason: 'a submit button is not a field a browser sends');
    });

    test('a second go is not a failure', () async {
      /* The archive answers a duplicate with an error page rather than a
         success, and there is no way to ask afterwards whether kudos were
         ever left — so this is the one error worth reading as "it is done". */
      final acts = Acts(
        ArchiveClient(
          pacer: instant(),
          http_: MockClient((request) async {
            if (request.method == 'GET') return page(kudosPage);
            return page('<p>You have already left kudos here. :)</p>', 422);
          }),
        ),
      );

      final done = await acts.kudos('58374928');
      expect(done.already, isTrue);
    });

    test('and a real refusal is still a refusal', () async {
      final acts = Acts(
        ArchiveClient(
          pacer: instant(),
          http_: MockClient((request) async {
            if (request.method == 'GET') return page(kudosPage);
            return page('<p>no</p>', 403);
          }),
        ),
      );
      await expectLater(acts.kudos('1'), throwsA(isA<ArchiveError>()));
    });

    test('a work with no kudos form says so', () async {
      final it = actor('<p>nothing here</p>');
      await expectLater(it.acts.kudos('1'), throwsA(isA<ArchiveError>()));
      expect(it.bodies, isEmpty, reason: 'nothing was sent');
    });
  });

  group('bookmarking', () {
    test('an unticked box stays unticked', () async {
      /* Submitting one is how a private bookmark quietly becomes a public
         one, or the other way about. */
      final it = actor(bookmarkPage);
      await it.acts.bookmark('58374928');

      expect(it.bodies.single, isNot(contains('private')));
      expect(it.bodies.single, isNot(contains('rec')));
      expect(it.bodies.single, contains('bookmark%5Bpseud_id%5D=7'),
          reason: 'the reader own pseud, read off their own form');
    });

    test('and a ticked one is sent as the form would send it', () async {
      final it = actor(bookmarkPage);
      await it.acts.bookmark(
        '58374928',
        notes: 'for the long flight',
        tags: 'comfort',
        private: true,
        rec: true,
      );

      expect(it.bodies.single, contains('bookmark%5Bprivate%5D=1'));
      expect(it.bodies.single, contains('bookmark%5Brec%5D=1'));
      expect(it.bodies.single, contains('for%20the%20long%20flight'));
      expect(it.bodies.single, contains('bookmark%5Btag_string%5D=comfort'));
    });
  });

  group('commenting', () {
    test('says what was written', () async {
      final it = actor(commentPage);
      await it.acts.comment('58374928', '  this undid me  ');
      expect(it.bodies.single, contains('this%20undid%20me'));
      expect(it.bodies.single, isNot(contains('%20%20this')),
          reason: 'the spaces either side were not part of it');
    });

    test('an empty one is refused before anything is sent', () async {
      final it = actor(commentPage);
      await expectLater(
        it.acts.comment('58374928', '   '),
        throwsA(isA<ArchiveError>()),
      );
      expect(it.bodies, isEmpty);
    });
  });

  group('where a form may point', () {
    test('at the archive, and nowhere else', () {
      expect(
          '${actionOnArchive('/kudos')}', 'https://archiveofourown.org/kudos');
      expect('${actionOnArchive('https://archiveofourown.org/kudos')}',
          'https://archiveofourown.org/kudos');

      /* A form is a stranger's markup, and an action pointing at another host
         is a signed-in write sent somewhere nobody asked for. */
      expect(() => actionOnArchive('https://evil.example/kudos'),
          throwsA(isA<ArchiveError>()));
      expect(() => actionOnArchive('//evil.example/kudos'),
          throwsA(isA<ArchiveError>()));
    });
  });
}
