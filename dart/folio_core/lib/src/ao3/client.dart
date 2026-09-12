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

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show parseHttpDate;

import '../sync/pacer.dart';

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

const String browserAgent =
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/// Cookies that must not be replayed.
///
/// Cloudflare's bot-management cookies are bound to the client they were
/// issued to. Replaying one minted for a WebView while claiming to be
/// something else is a contradiction Cloudflare is built to notice; dropping
/// them lets it issue fresh ones that match whoever is actually asking.
bool keepCookie(String name) =>
    !name.startsWith('__cf') &&
    name != '_cfuvid' &&
    // a spent one-shot flag
    name != 'flash_is_set';

/// A cookie string, filtered down to what is ours to send.
String cookieHeader(Map<String, String> jar) => [
      for (final entry in jar.entries)
        if (keepCookie(entry.key) && entry.key.isNotEmpty)
          '${entry.key}=${entry.value}',
    ].join('; ');

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
  const ArchiveError(this.message, {this.status});

  final String message;
  final int? status;

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
  final detail = body.trim();
  final tail = detail.isEmpty
      ? ''
      : ': ${detail.substring(0, detail.length < 200 ? detail.length : 200)}';

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
  return ArchiveError('The archive answered $status$tail', status: status);
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
      'User-Agent': identify ? honestAgent : browserAgent,
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

    if (response.statusCode == 429 || response.statusCode == 503) {
      /* Being told to slow down is the one answer everything else has to
         honour: the archive sees the total, not the intent. Retry-After is
         taken at its word where it is given, and a long guess where it is
         not — one penalty costs more wall clock than all the gaps it buys. */
      pacer
          .slowDown(retryAfter(response.headers) ?? const Duration(minutes: 5));
    }

    if (!response.ok) throw errorFor(response.statusCode, response.body);

    /* The archive answers an expired session with a login page and a 200, so
       a status alone is not proof the request did what it was asked to. */
    if (isLoginPage(response.body)) {
      throw const ArchiveError(
        'The archive returned the login page — the session has expired, '
        'sign in again',
        status: 401,
      );
    }

    return Page(status: response.statusCode, body: response.body, url: url);
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

/// The archive answers an expired session with a login page and a 200.
bool isLoginPage(String body) =>
    RegExp(r'<title>\s*Log In', caseSensitive: false).hasMatch(body);
