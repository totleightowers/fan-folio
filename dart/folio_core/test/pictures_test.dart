import 'dart:convert';
import 'dart:typed_data';

import 'package:folio_core/folio_core.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// The pictures inside a work, kept with it.
///
/// A chapter with an image reads fine on the train and shows a broken box in
/// a tunnel, which is the one thing an offline reader is for. What is checked
/// here is that only pictures are stored, that a rotted hotlink is written
/// down rather than retried for ever, and that nothing decides where a
/// request goes except the work itself.
void main() {
  Pacer instant() => Pacer(sleep: (_) async {}, now: () => DateTime(2026));

  /// A one-pixel GIF, which is a real image and small enough to write down.
  final aPicture = base64Decode(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  );

  http.Response bytes(List<int> body, String mime, [int status = 200]) =>
      http.Response.bytes(
        Uint8List.fromList(body),
        status,
        headers: {'content-type': mime},
      );

  group('what a work points at', () {
    test('is read out of its own markup', () {
      /* Out of the stored chapter rather than composed by anything else:
         nothing chooses where a request goes except the work itself. */
      const html = '''
<p>before</p>
<img src="https://i.example/one.png" alt="a">
<img src='https://i.example/two.jpg'>
<img src="https://i.example/one.png">
<img src="http://i.example/insecure.png">
<img src="/relative.png">''';

      expect(
          picturesIn(html),
          [
            'https://i.example/one.png',
            'https://i.example/two.jpg',
          ],
          reason: 'the same picture twice is one picture');
    });

    test('and nothing at all is nothing', () {
      expect(picturesIn('<p>words</p>'), isEmpty);
      expect(picturesIn(''), isEmpty);
    });
  });

  group('fetching one', () {
    Pictures picturesWith(http.Response Function(http.Request) answer) =>
        Pictures(
          client: ArchiveClient(
            pacer: instant(),
            http_: MockClient((r) async => answer(r)),
          ),
          store: _Fake(),
        );

    test('a picture is stored under the hash of its bytes', () async {
      final got = await picturesWith(
        (_) => bytes(aPicture, 'image/gif'),
      ).fetch('https://i.example/a.gif');

      expect(got.stored, isTrue);
      expect(got.mime, 'image/gif');
      expect(got.sha256, hasLength(64));
      expect(got.trouble, isNull);
    });

    test('an error page where an image should be is not an image', () async {
      /* Stored as though it worked, it renders as a broken picture for ever
         and nothing ever tries again. */
      final got = await picturesWith(
        (_) => bytes(utf8.encode('<html>not found</html>'), 'text/html'),
      ).fetch('https://i.example/a.gif');

      expect(got.stored, isFalse);
      expect(got.trouble, 'not an image');
    });

    test('plaintext is refused before it is asked for', () async {
      var asked = false;
      final got = await picturesWith((_) {
        asked = true;
        return bytes(aPicture, 'image/gif');
      }).fetch('http://i.example/a.gif');

      expect(got.trouble, 'https only');
      expect(asked, isFalse, reason: 'nothing left the phone');
    });

    test('an empty body is not a picture', () async {
      final got = await picturesWith(
        (_) => bytes(const [], 'image/png'),
      ).fetch('https://i.example/a.png');
      expect(got.trouble, 'empty');
    });

    test('and one picture cannot fill the library', () async {
      final huge = Uint8List(mostBytes + 1);
      final got = await picturesWith(
        (_) => bytes(huge, 'image/png'),
      ).fetch('https://i.example/big.png');
      expect(got.trouble, 'too large');
    });

    test('a hotlink that rotted is written down, not thrown', () async {
      final got = await picturesWith(
        (_) => bytes(const [], 'text/html', 404),
      ).fetch('https://i.example/gone.png');
      expect(got.stored, isFalse);
      expect(got.trouble, contains('404'));
    });
  });

  group('fetching a work’s worth', () {
    test('skips what has been settled either way', () async {
      /* Fetched or given up on, both count. Retrying a dead link on every
         open is the same request for ever. */
      final store = _Fake()
        ..already['1'] = {
          'https://i.example/have.png',
          'https://i.example/dead.png',
        };
      final asked = <String>[];
      final pictures = Pictures(
        client: ArchiveClient(
          pacer: instant(),
          http_: MockClient((r) async {
            asked.add('${r.url}');
            return bytes(aPicture, 'image/gif');
          }),
        ),
        store: store,
      );

      final got = await pictures.fetchFor('1', const [
        '<img src="https://i.example/have.png">'
            '<img src="https://i.example/dead.png">',
        '<img src="https://i.example/new.png">',
      ]);

      expect(asked, ['https://i.example/new.png']);
      expect(got, 1);
      expect(store.written.single.url, 'https://i.example/new.png');
    });

    test('and a work with no pictures asks for nothing', () async {
      var asked = false;
      final pictures = Pictures(
        client: ArchiveClient(
          pacer: instant(),
          http_: MockClient((_) async {
            asked = true;
            return bytes(aPicture, 'image/gif');
          }),
        ),
        store: _Fake(),
      );

      expect(await pictures.fetchFor('1', const ['<p>words</p>']), 0);
      expect(asked, isFalse);
    });
  });

  test('a stored picture is a thing a page can point at', () {
    final uri = dataUri('image/gif', aPicture);
    expect(uri, startsWith('data:image/gif;base64,'));
    expect(base64Decode(uri.split(',').last), aPicture);
  });
}

class _Fake implements PictureStore {
  final Map<String, Set<String>> already = {};
  final List<StoredPicture> written = [];

  @override
  Future<Set<String>> settled(String workId) async => already[workId] ?? {};

  @override
  Future<void> put(String workId, StoredPicture picture) async {
    written.add(picture);
  }
}
