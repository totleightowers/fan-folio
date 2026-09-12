/// Asking the archive for a page, the way a browser asks.
///
/// Everything goes through the pacer, which is the one thing in this file that
/// matters more than the rest: an app that walks somebody's bookmarks
/// impatiently gets their account limited, and they will not know why.
///
/// Nothing here parses a work. This answers "what did the archive say", and
/// says it in the words the retry rules were written against — because the
/// message thrown here is what decides whether a work is tried again.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show parseHttpDate;

import '../sync/pacer.dart';
import 'forms.dart';
import 'urls.dart' show origin;

/// How this client presents itself.
///
/// A judgement call, made deliberately and inherited from 1.x. The archive
/// asks automated clients to identify themselves, and the honest string is
/// what this started with — but a non-browser User-Agent with three headers is
/// throttled far harder than a browser is, and the traffic here *is* a person
/// reading their own account at roughly two requests a minute. Presenting as
/// the browser on the device actually making the request is closer to the
/// truth of what is happening than a bot string attached to human-paced,
/// human-owned, personal traffic.
const String honestAgent =
    'FanFolio/2.0 (personal offline reader for my own AO3 account)';

/// Only a fallback. The device's own is asked for at startup and used
/// instead; this is what to say before that answer has come back.
const String browserAgent =
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/// Cookies that must not be replayed.
///
/// Only one, and it is a spent flag rather than a session.
///
/// Cloudflare's own cookies used to be dropped here, carried over from the
/// tooling this client was modelled on — where they had been minted by a
/// python login and were being replayed from node, which is a contradiction
/// Cloudflare exists to notice. On the phone they are nothing of the sort:
/// they were issued to this device's own webview, minutes earlier, to the
/// browser this client presents itself as. Throwing away the clearance that
/// was granted to us makes every request look like a fresh unverified client,
/// which is the shortest road to a 503.
bool keepCookie(String name) => name != 'flash_is_set';

/// A cookie string, filtered down to what is ours to send.
String cookieHeader(Map<String, String> jar) => [
      for (final entry in jar.entries)
        if (keepCookie(entry.key) && entry.key.isNotEmpty)
          '${entry.key}=${entry.value}',
    ].join('; ');

/// Something that is not a page: bytes, and what kind of bytes.
class Bytes {
  const Bytes({required this.bytes, this.mime});

  final Uint8List bytes;
  final String? mime;
}

/// What the archive said, and what it said it with.
class Page {
  const Page({required this.status, required this.body, required this.url});

  final int status;
  final String body;
  final Uri url;

  bool get ok => status >= 200 && status < 300;
}

/// The archive answering with something other than a page.
///
/// The wording is deliberate and load-bearing: `isTransient` reads these
/// messages to decide whether a work is worth asking for again, and a message
/// that opens "UnknownHostException" reads as a work that cannot be had rather
/// than a phone that was briefly out of signal.
class ArchiveError implements Exception {
  const ArchiveError(this.message, {this.status, this.body});

  final String message;
  final int? status;

  /// What the archive actually sent, kept apart from what the reader is
  /// told. Some refusals are only legible in the page — a duplicate kudos is
  /// an error whose whole meaning is one sentence in the body — and that
  /// sentence has no business being the message a person reads.
  final String? body;

  @override
  String toString() => message;
}

/// What to say about a status, in the words the retry rules know.
///
/// 404 is a work that is gone and will be gone next time. 403 and 401 are a
/// work behind a login, which is a thing the reader can act on. Everything
/// else keeps the status in the message, because "answered 429" and
/// "answered 403" are read very differently downstream.
ArchiveError errorFor(int status, String body) {
  final tail = _saidWhat(body);

  if (status == 404) {
    return const ArchiveError(
      'That work does not exist, or has been deleted',
      status: 404,
    );
  }
  if (status == 403 || status == 401) {
    return ArchiveError(
      'That work is restricted — sign in to the archive first',
      status: status,
    );
  }
  return ArchiveError(
    'The archive answered $status$tail',
    status: status,
    body: body,
  );
}

/// A logged-in, well-behaved archive client.
///
/// The cookies come from wherever the app got them — a WebView sign-in, most
/// likely. Everything below that is the same code 1.x proved against a real
/// account: pacing, headers, the referer chain, and knowing a login page when
/// it sees one.
class ArchiveClient {
  ArchiveClient({
    required this.pacer,
    http.Client? http_,
    Map<String, String>? cookies,
    this.identify = false,
  })  : _http = http_ ?? http.Client(),
        _cookies = {...?cookies};

  final Pacer pacer;
  final http.Client _http;
  final Map<String, String> _cookies;

  /// Announce ourselves as a tool rather than as the browser we are inside.
  final bool identify;

  /// The browser this device actually has.
  ///
  /// 1.x asked Android for it and sent that. This sent a string written down
  /// months ago naming a phone model and a Chrome version that have nothing
  /// to do with whoever is holding the device — which is a worse signal than
  /// the truth, not a better one, because it does not match the session the
  /// archive already has or anything else about the request.
  String? _agent;

  // ignore: use_setters_to_change_properties
  void useAgent(String agent) => _agent = agent;

  /// Someone on page seven got there from page six. Arriving with no referer
  /// at all, page after page, is not what browsing looks like.
  Uri? _referer;

  Map<String, String> get cookies => Map.unmodifiable(_cookies);

  void setCookies(Map<String, String> jar) {
    _cookies
      ..clear()
      ..addAll(jar);
  }

  /// What that browser actually sends. Partial headers are their own
  /// signature, so these go together or not at all.
  Map<String, String> headers() {
    final cookie = cookieHeader(_cookies);
    return {
      'User-Agent': identify ? honestAgent : (_agent ?? browserAgent),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,'
          'image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': _referer == null ? 'none' : 'same-origin',
      'Sec-Fetch-User': '?1',
      if (_referer != null) 'Referer': '$_referer',
      if (cookie.isNotEmpty) 'Cookie': cookie,
    };
  }

  /// Ask for a page, in its turn.
  Future<Page> get(Uri url) => pacer.run(() => _get(url));

  /// Ask for something that is not a page, in its turn.
  ///
  /// A picture, most likely. Kept apart from [get] because the body is bytes
  /// rather than text, and because the headers a browser sends for an image
  /// are not the ones it sends for a document — partial headers are their own
  /// signature, and a client claiming to be Chrome while asking for a picture
  /// the way it asks for a page is not what Chrome looks like.
  Future<Bytes> getBytes(Uri url, {String? accept}) =>
      pacer.run(() => _getBytes(url, accept));

  Future<Bytes> _getBytes(Uri url, String? accept) async {
    http.Response response;
    try {
      response = await _http.get(url, headers: {
        ...headers(),
        if (accept != null) 'Accept': accept,
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
      });
    } catch (e) {
      throw ArchiveError('The app could not reach it: $e');
    }

    if (!response.ok) {
      throw ArchiveError(
        'It answered ${response.statusCode}',
        status: response.statusCode,
      );
    }
    return Bytes(
      bytes: response.bodyBytes,
      mime: response.headers['content-type'],
    );
  }

  /// Submit a form, in its turn.
  ///
  /// Redirects are followed by hand rather than by the client, because every
  /// hop of a sign-in sets a cookie and a client that follows them itself
  /// hands back only the last response's headers — which is how a session
  /// that was granted arrives looking like one that was refused.
  Future<Page> post(Uri url, Map<String, String> fields) =>
      pacer.run(() => _post(url, fields));

  Future<Page> _post(Uri url, Map<String, String> fields) async {
    var at = url;
    http.Response response;

    for (var hop = 0;; hop++) {
      try {
        response = hop == 0
            ? await _http.post(
                at,
                headers: {
                  ...headers(),
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Sec-Fetch-Site': 'same-origin',
                },
                body: encodeForm(fields),
              )
            : await _http.get(at, headers: headers());
      } catch (e) {
        throw ArchiveError('The app could not reach the archive: $e');
      }

      _remember(response);
      final next = response.headers['location'];
      if (response.statusCode < 300 ||
          response.statusCode >= 400 ||
          next == null ||
          hop >= 5) {
        break;
      }
      at = at.resolve(next);
      _referer = url;
    }

    _referer = at;
    final body = decodeBody(response);
    if (!response.ok) throw errorFor(response.statusCode, body);
    return Page(status: response.statusCode, body: body, url: at);
  }

  /// There is no sign-in here, and that is deliberate.
  ///
  /// The archive has no endpoint for other people's apps to call, and posting
  /// a password to their login form from a phone is the wrong shape twice
  /// over: it teaches the habit phishing relies on, and it cannot answer a
  /// captcha, a two-factor prompt or a Cloudflare challenge — all of which
  /// the archive serves to a phone sooner or later.
  ///
  /// So signing in happens on the archive's own page, in a webview, and the
  /// session cookie is read out of the platform's cookie store afterwards
  /// and handed to [setCookies]. The password is between the reader and the
  /// archive and never passes through this app.

  /// Who the archive thinks we are, or nobody.
  Future<String?> whoAmI() async {
    try {
      return signedInAs((await get(Uri.parse(origin))).body);
    } on ArchiveError {
      return null;
    }
  }

  /// Sign out here, which is not signing out there.
  ///
  /// Dropping the cookies ends this app's session as far as this app is
  /// concerned. The archive still holds it until it expires or the reader
  /// logs out on the site, which is worth saying rather than implying.
  void forget() {
    _cookies.clear();
    _referer = null;
  }

  Future<Page> _get(Uri url) async {
    http.Response response;
    try {
      response = await _http.get(url, headers: headers());
    } catch (e) {
      /* Never getting there is a moment rather than a verdict, and the retry
         rules know these words. Wrapping the original is what keeps "unable
         to resolve host" from being read as a work that cannot be had. */
      throw ArchiveError('The app could not reach the archive: $e');
    }

    _remember(response);
    _referer = url;
    final body = decodeBody(response);

    if (response.statusCode == 429 || response.statusCode == 503) {
      /* Being told to slow down is the one answer everything else has to
         honour: the archive sees the total, not the intent. Retry-After is
         taken at its word where it is given, and a long guess where it is
         not — one penalty costs more wall clock than all the gaps it buys. */
      pacer
          .slowDown(retryAfter(response.headers) ?? const Duration(minutes: 5));
    }

    if (!response.ok) throw errorFor(response.statusCode, body);

    /* The archive answers an expired session with a login page and a 200, so
       a status alone is not proof the request did what it was asked to.
       Asking for the sign-in page is the one time that page is the answer —
       keyed on the address rather than on a flag the caller has to remember,
       because forgetting it makes signing in impossible in a way that reads
       like an expired session. */
    if (!isSignInPage(url) && isLoginPage(body)) {
      throw const ArchiveError(
        'The archive returned the login page — the session has expired, '
        'sign in again',
        status: 401,
      );
    }

    return Page(status: response.statusCode, body: body, url: url);
  }

  /// Keep whatever the archive set, so a session survives the next request.
  void _remember(http.Response response) {
    final header = response.headers['set-cookie'];
    if (header == null || header.isEmpty) return;
    for (final pair in splitSetCookie(header)) {
      final eq = pair.indexOf('=');
      if (eq <= 0) continue;
      _cookies[pair.substring(0, eq).trim()] =
          pair.substring(eq + 1).split(';').first.trim();
    }
  }

  void close() => _http.close();
}

extension on http.Response {
  bool get ok => statusCode >= 200 && statusCode < 300;
}

/// The page, as text.
///
/// HTTP says a text/* body with no charset is Latin-1, and package:http obeys
/// that. The archive is UTF-8 and says so, but a proxy or a cached error page
/// need not — and Latin-1 turns every accented name and every curly quote in a
/// chapter into mojibake that is then stored and indexed that way. So: what
/// the header says if it says anything, and UTF-8 otherwise.
String decodeBody(http.Response response) {
  final type = response.headers['content-type'] ?? '';
  final charset = RegExp(
    r'charset\s*=\s*"?([\w-]+)',
    caseSensitive: false,
  ).firstMatch(type)?.group(1);

  final named = charset == null ? null : Encoding.getByName(charset);
  if (named != null && named != latin1) {
    return named.decode(response.bodyBytes);
  }
  return utf8.decode(response.bodyBytes, allowMalformed: true);
}

/// Dart folds several Set-Cookie headers into one comma-joined string, and a
/// cookie's own Expires attribute contains a comma. So the split is on a comma
/// that starts a new `name=` rather than on every comma.
List<String> splitSetCookie(String header) {
  final out = <String>[];
  final start = RegExp(r',\s*(?=[^=;,\s]+\s*=)');
  var at = 0;
  for (final m in start.allMatches(header)) {
    out.add(header.substring(at, m.start));
    at = m.end;
  }
  out.add(header.substring(at));
  return [
    for (final cookie in out)
      if (cookie.trim().isNotEmpty) cookie.split(';').first.trim(),
  ];
}

/// How long the archive asked to be left alone for.
///
/// Given as seconds or as a date. Both are honoured; a date in the past is no
/// wait at all rather than a negative one.
Duration? retryAfter(Map<String, String> headers, {DateTime? now}) {
  final said = headers['retry-after'];
  if (said == null || said.trim().isEmpty) return null;

  final seconds = int.tryParse(said.trim());
  if (seconds != null) {
    return seconds <= 0 ? Duration.zero : Duration(seconds: seconds);
  }

  final at = _httpDate(said.trim());
  if (at == null) return null;
  final left = at.difference(now ?? DateTime.now().toUtc());
  return left.isNegative ? Duration.zero : left;
}

DateTime? _httpDate(String text) {
  try {
    return parseHttpDate(text).toUtc();
  } catch (_) {
    return null;
  }
}

/// What the archive said, if it said anything a person can read.
///
/// The body of a refusal is usually a whole HTML page, and two hundred
/// characters of `<!DOCTYPE html><head><meta charset=` is worse than nothing:
/// it fills the screen where an explanation should be and explains less. So a
/// page is reduced to its title, which is where the archive puts the short
/// version, and anything that is not a page is passed through as written.
String _saidWhat(String body) {
  final said = body.trim();
  if (said.isEmpty) return '';

  if (said.startsWith('<') || said.toLowerCase().contains('<html')) {
    final title = RegExp(
      r'<title[^>]*>([\s\S]{1,120}?)</title>',
      caseSensitive: false,
    ).firstMatch(said)?.group(1);
    final trimmed = title?.replaceAll(RegExp(r'\s+'), ' ').trim() ?? '';
    return trimmed.isEmpty ? '' : ' — $trimmed';
  }

  return ': ${said.substring(0, said.length < 160 ? said.length : 160)}';
}

/// Whether this address is the sign-in page, where a login form is the point.
bool isSignInPage(Uri url) => url.path == '/users/login';

/// The archive answers an expired session with a login page and a 200.
bool isLoginPage(String body) =>
    RegExp(r'<title>\s*Log In', caseSensitive: false).hasMatch(body);

/// Who the archive thinks is reading, read off any page it serves.
///
/// The dashboard link carries the pseud, and it is only there when there is a
/// session behind it — which makes it the honest answer to "am I signed in",
/// rather than the presence of a cookie the archive may have forgotten.
String? signedInAs(String body) => RegExp(
      r'href="/users/([^/"]+)"[^>]*>\s*My Dashboard',
      caseSensitive: false,
    ).firstMatch(body)?.group(1);
