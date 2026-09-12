import 'dart:async';
import 'dart:convert';

import 'package:folio_core/folio_core.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// Asking the archive for a page, without an archive.
///
/// What is being checked here is the part a phone cannot be trusted to show:
/// that everything waits on the one clock, that a 429 is read as "slow down"
/// rather than "no", and that the words thrown are the words the retry rules
/// were written against.
void main() {
  /// A pacer that keeps its order and its rules but does not actually wait.
  Pacer instant({List<Duration>? slept}) => Pacer(
        sleep: (d) async => slept?.add(d),
        now: () => DateTime(2026),
      );

  test('everything goes through the one clock, in order', () async {
    final asked = <String>[];
    final client = ArchiveClient(
      pacer: instant(),
      http_: MockClient((request) async {
        asked.add(request.url.path);
        // a slow first request must not let the second overtake it
        if (asked.length == 1) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
        return http.Response('<p>fine</p>', 200);
      }),
    );

    await Future.wait([
      client.get(Uri.https('archiveofourown.org', '/works/1')),
      client.get(Uri.https('archiveofourown.org', '/works/2')),
    ]);
    expect(asked, ['/works/1', '/works/2']);
  });

  test('presents as the browser it is inside, or says it is a tool', () {
    final asBrowser = ArchiveClient(pacer: instant()).headers();
    expect(asBrowser['User-Agent'], browserAgent);
    /* Partial headers are their own signature: a request claiming to be
       Chrome and sending three headers is not what Chrome looks like. */
    expect(asBrowser, contains('Sec-Fetch-Dest'));
    expect(asBrowser, contains('Accept-Language'));
    expect(asBrowser['Sec-Fetch-Site'], 'none', reason: 'nothing before it');

    expect(
      ArchiveClient(pacer: instant(), identify: true).headers()['User-Agent'],
      honestAgent,
    );
  });

  test('and arrives from the page it was on', () async {
    final seen = <String?>[];
    final client = ArchiveClient(
      pacer: instant(),
      http_: MockClient((request) async {
        seen.add(request.headers['Referer']);
        return http.Response('ok', 200);
      }),
    );
    await client.get(Uri.https('archiveofourown.org', '/works', {'page': '1'}));
    await client.get(Uri.https('archiveofourown.org', '/works', {'page': '2'}));

    expect(seen.first, isNull, reason: 'the first page came from nowhere');
    expect(
      seen.last,
      'https://archiveofourown.org/works?page=1',
      reason: 'someone on page two got there from page one',
    );
  });

  group('cookies', () {
    test('the ones bound to another client are not replayed', () {
      /* Cloudflare's bot-management cookies are issued to whoever asked.
         Replaying one minted for a WebView while claiming to be something
         else is the contradiction Cloudflare exists to notice. */
      expect(keepCookie('__cf_bm'), isFalse);
      expect(keepCookie('_cfuvid'), isFalse);
      expect(keepCookie('flash_is_set'), isFalse);
      expect(keepCookie('_otwarchive_session'), isTrue);

      expect(
        cookieHeader({
          '_otwarchive_session': 'abc',
          '__cf_bm': 'nope',
          'user_credentials': '1',
        }),
        '_otwarchive_session=abc; user_credentials=1',
      );
    });

    test('and whatever the archive sets is kept for the next request',
        () async {
      final sent = <String?>[];
      final client = ArchiveClient(
        pacer: instant(),
        http_: MockClient((request) async {
          sent.add(request.headers['Cookie']);
          return http.Response(
            'ok',
            200,
            headers: {
              'set-cookie': '_otwarchive_session=new; path=/; HttpOnly, '
                  'user_credentials=1; expires=Thu, 01 Jan 2099 00:00:00 GMT',
            },
          );
        }),
      );

      await client.get(Uri.https('archiveofourown.org', '/'));
      await client.get(Uri.https('archiveofourown.org', '/works/1'));

      expect(sent.first, isNull);
      expect(sent.last, contains('_otwarchive_session=new'));
      expect(sent.last, contains('user_credentials=1'),
          reason: 'a comma inside an Expires date is not a second cookie');
    });
  });

  group('what the archive said', () {
    test('a 429 slows everything down rather than failing the work', () async {
      final pacer = instant();
      final client = ArchiveClient(
        pacer: pacer,
        http_: MockClient(
          (_) async =>
              http.Response('slow down', 429, headers: {'retry-after': '600'}),
        ),
      );

      await expectLater(
        client.get(Uri.https('archiveofourown.org', '/works/1')),
        throwsA(
          isA<ArchiveError>().having(
            (e) => isTransient(e.message),
            'is worth trying again',
            isTrue,
          ),
        ),
      );

      /* And the whole app waits, not only whoever was told. The archive sees
         the total, not the intent, so there is no such thing here as a
         request that steps around the cool-off. */
      expect(
        pacer.coolingUntil,
        DateTime(2026).add(const Duration(seconds: 600)),
        reason: 'Retry-After is taken at its word',
      );
    });

    test('a 404 is not worth asking for again', () async {
      final client = ArchiveClient(
        pacer: instant(),
        http_: MockClient((_) async => http.Response('gone', 404)),
      );
      await expectLater(
        client.get(Uri.https('archiveofourown.org', '/works/1')),
        throwsA(
          isA<ArchiveError>().having(
            (e) => isTransient(e.message),
            'is worth trying again',
            isFalse,
          ),
        ),
      );
    });

    test('a phone out of signal is a moment, not a verdict', () async {
      final client = ArchiveClient(
        pacer: instant(),
        http_: MockClient(
          (_) async => throw const SocketLike('Unable to resolve host'),
        ),
      );
      await expectLater(
        client.get(Uri.https('archiveofourown.org', '/works/1')),
        throwsA(
          isA<ArchiveError>().having(
            (e) => isTransient(e.message),
            'is worth trying again',
            isTrue,
          ),
        ),
      );
    });

    test('a login page with a 200 on it is not a page', () async {
      /* The archive answers an expired session this way, so a status alone
         is not proof the request did what it was asked to. */
      final client = ArchiveClient(
        pacer: instant(),
        http_: MockClient(
          (_) async => http.Response('<html><title>Log In</title>', 200),
        ),
      );
      await expectLater(
        client.get(Uri.https('archiveofourown.org', '/works/1')),
        throwsA(
          isA<ArchiveError>().having(
            (e) => e.message,
            'says what to do about it',
            contains('sign in again'),
          ),
        ),
      );
    });

    test('and the wording keeps the status, because that is what is read', () {
      expect(errorFor(500, 'oops').message,
          startsWith('The archive answered 500'));
      expect(isTransient(errorFor(500, '').message), isTrue);
      expect(isTransient(errorFor(403, '').message), isFalse);
      expect(isTransient(errorFor(429, '').message), isTrue);
    });
  });

  group('a body is text, and the header does not always say which', () {
    Future<String> bodyOf(http.Response Function() answer) async {
      final client = ArchiveClient(
        pacer: instant(),
        http_: MockClient((_) async => answer()),
      );
      final page = await client.get(Uri.https('archiveofourown.org', '/x'));
      return page.body;
    }

    test('UTF-8 when the header says so', () async {
      expect(
        await bodyOf(
          () => http.Response.bytes(
            utf8.encode('“Écoute,” she said — 「ね」'),
            200,
            headers: {'content-type': 'text/html; charset=utf-8'},
          ),
        ),
        '“Écoute,” she said — 「ね」',
      );
    });

    test('and UTF-8 when it says nothing at all', () async {
      /* HTTP says a text body with no charset is Latin-1, and package:http
         obeys. The archive is UTF-8 and says so — but a proxy or a cached
         error page need not, and Latin-1 turns every accented name and every
         curly quote in a chapter into mojibake that is then stored and
         indexed that way. */
      expect(
        await bodyOf(() => http.Response.bytes(utf8.encode('Éowyn'), 200)),
        'Éowyn',
      );
    });
  });

  group('how long to be left alone', () {
    test('a count of seconds', () {
      expect(retryAfter({'retry-after': '516'}), const Duration(seconds: 516));
      expect(retryAfter({'retry-after': '0'}), Duration.zero);
      expect(retryAfter({}), isNull);
      expect(retryAfter({'retry-after': ''}), isNull);
    });

    test('or a date, which may already have passed', () {
      final now = DateTime.utc(2026, 1, 1, 12);
      expect(
        retryAfter(
          {'retry-after': 'Thu, 01 Jan 2026 12:05:00 GMT'},
          now: now,
        ),
        const Duration(minutes: 5),
      );
      expect(
        retryAfter({'retry-after': 'Thu, 01 Jan 2026 11:00:00 GMT'}, now: now),
        Duration.zero,
        reason: 'a date in the past is no wait, not a negative one',
      );
      expect(retryAfter({'retry-after': 'sometime'}), isNull);
    });
  });

  group('who the archive thinks we are', () {
    const dashboard = '<html><body>'
        '<a href="/users/somebody" class="dashboard">My Dashboard</a>'
        '</body></html>';

    test('is read off any page it serves', () {
      /* The dashboard link carries the pseud and is only there when there is
         a session behind it, which makes it the honest answer to "am I
         signed in" — rather than the presence of a cookie the archive may
         have forgotten. */
      expect(signedInAs(dashboard), 'somebody');
      expect(signedInAs('<p>signed out</p>'), isNull);
    });

    test('and asking costs one page', () async {
      final client = ArchiveClient(
        pacer: instant(),
        http_: MockClient(
          (_) async => http.Response.bytes(
            utf8.encode(dashboard),
            200,
            headers: {'content-type': 'text/html; charset=utf-8'},
          ),
        ),
      );
      expect(await client.whoAmI(), 'somebody');
    });

    test('forgetting here is not logging out there', () async {
      /* Dropping the cookies ends the session as far as this app is
         concerned. The archive still holds it until it expires or the reader
         logs out on the site. */
      final client = ArchiveClient(
        pacer: instant(),
        cookies: {'_otwarchive_session': 'live'},
      )..forget();
      expect(client.cookies, isEmpty);
    });

    test('and a session handed in from a webview is taken on', () {
      /* Which is the only way one arrives: the archive has no endpoint for
         other people's apps, and a password box would be the wrong shape
         even where it worked. */
      final client = ArchiveClient(pacer: instant())
        ..setCookies({'_otwarchive_session': 'from the webview'});
      expect(client.cookies['_otwarchive_session'], 'from the webview');
    });
  });

  group('a body is text, and the header does not always say which', () {
    Future<String> bodyOf(http.Response Function() answer) async {
      final client = ArchiveClient(
        pacer: instant(),
        http_: MockClient((_) async => answer()),
      );
      final page = await client.get(Uri.https('archiveofourown.org', '/x'));
      return page.body;
    }

    test('UTF-8 when the header says so', () async {
      expect(
        await bodyOf(
          () => http.Response.bytes(
            utf8.encode('“Écoute,” she said — 「ね」'),
            200,
            headers: {'content-type': 'text/html; charset=utf-8'},
          ),
        ),
        '“Écoute,” she said — 「ね」',
      );
    });

    test('and UTF-8 when it says nothing at all', () async {
      /* HTTP says a text body with no charset is Latin-1, and package:http
         obeys. The archive is UTF-8 and says so — but a proxy or a cached
         error page need not, and Latin-1 turns every accented name and every
         curly quote in a chapter into mojibake that is then stored and
         indexed that way. */
      expect(
        await bodyOf(() => http.Response.bytes(utf8.encode('Éowyn'), 200)),
        'Éowyn',
      );
    });
  });

  group('how long to be left alone', () {
    test('a count of seconds', () {
      expect(retryAfter({'retry-after': '516'}), const Duration(seconds: 516));
      expect(retryAfter({'retry-after': '0'}), Duration.zero);
      expect(retryAfter({}), isNull);
      expect(retryAfter({'retry-after': ''}), isNull);
    });

    test('or a date, which may already have passed', () {
      final now = DateTime.utc(2026, 1, 1, 12);
      expect(
        retryAfter(
          {'retry-after': 'Thu, 01 Jan 2026 12:05:00 GMT'},
          now: now,
        ),
        const Duration(minutes: 5),
      );
      expect(
        retryAfter({'retry-after': 'Thu, 01 Jan 2026 11:00:00 GMT'}, now: now),
        Duration.zero,
        reason: 'a date in the past is no wait, not a negative one',
      );
      expect(retryAfter({'retry-after': 'sometime'}), isNull);
    });
  });

  test('a redirect sets cookies on the hop it redirects from', () async {
    /* Which is why redirects are followed by hand. A client that follows
       them itself hands back only the last response's headers, and every hop
       of a signed-in write can set one. */
    final client = ArchiveClient(
      pacer: instant(),
      http_: MockClient((request) async {
        if (request.method == 'POST') {
          return http.Response('', 302, headers: {
            'location': '/landed',
            'set-cookie': '_otwarchive_session=live; path=/',
          });
        }
        return http.Response('<p>landed</p>', 200);
      }),
    );

    final page = await client.post(
      Uri.https('archiveofourown.org', '/somewhere'),
      {'a': 'b'},
    );
    expect(page.url.path, '/landed');
    expect(client.cookies['_otwarchive_session'], 'live');
  });
}

/// Something thrown from underneath, the way a phone throws it.
class SocketLike implements Exception {
  const SocketLike(this.message);
  final String message;
  @override
  String toString() => message;
}
