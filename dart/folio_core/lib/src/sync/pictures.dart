/// The pictures inside a work, kept with it.
///
/// A chapter with an image in it reads fine on the train and then shows a
/// broken box in a tunnel, which is the one thing an offline reader is for.
/// So the pictures a work refers to are fetched and stored beside its text.
///
/// Everything here goes through the same pacer as the rest. A work with forty
/// inline images is forty requests, and they are somebody else's bandwidth as
/// much as the archive's.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../ao3/client.dart';

/// One picture should not be able to fill the library.
const int mostBytes = 12 * 1024 * 1024;

/// What a work points at, read out of what the archive sent.
///
/// Out of the stored chapter and the stored skin rather than composed by
/// anything else: nothing chooses where a request goes except the work itself.
///
/// A skin counts. An author's stylesheet names backgrounds and webfonts, and
/// a chapter whose skin is half-fetched is a chapter that reaches out to
/// somebody else's server every time it is opened — or, if it is stopped from
/// doing that, one that renders wrongly for ever.
List<String> picturesIn(String html, {String? css}) {
  final found = <String>{};

  for (final m in RegExp(
    r'''<img\b[^>]*\bsrc=["'](https://[^"']+)["']''',
    caseSensitive: false,
  ).allMatches(html)) {
    found.add(m.group(1)!);
  }

  for (final m in RegExp(
    r'''url\(\s*["']?(https://[^"')\s]+)["']?\s*\)''',
    caseSensitive: false,
  ).allMatches(css ?? '')) {
    found.add(m.group(1)!);
  }

  return found.toList();
}

/// A picture that arrived, or the reason one did not.
class StoredPicture {
  const StoredPicture({
    required this.url,
    this.bytes,
    this.mime,
    this.sha256,
    this.trouble,
  });

  final String url;
  final Uint8List? bytes;
  final String? mime;
  final String? sha256;

  /// Why it is not here. Recorded rather than retried for ever: an image that
  /// 404s will 404 next time, and asking again on every open is rude.
  final String? trouble;

  bool get stored => bytes != null;
}

/// Where pictures go, and what is already there.
abstract interface class PictureStore {
  /// Which of these this work has already dealt with — fetched or given up
  /// on. Both count: retrying a dead link on every open is the same request
  /// for ever.
  Future<Set<String>> settled(String workId);

  Future<void> put(String workId, StoredPicture picture);
}

/// Fetch the pictures one work refers to.
class Pictures {
  const Pictures({required this.client, required this.store});

  final ArchiveClient client;
  final PictureStore store;

  /// Fetch whatever this work still needs, in its turn.
  ///
  /// Returns how many arrived. A picture that cannot be had is written down
  /// as such and stepped over: a work is worth having with one broken image
  /// in it, and a chapter is not worth failing over a hotlink that rotted
  /// five years ago.
  Future<int> fetchFor(
    String workId,
    List<String> chapterHtml, {
    String? skinCss,
    bool Function()? shouldStop,
  }) async {
    final wanted = <String>{};
    for (final html in chapterHtml) {
      wanted.addAll(picturesIn(html));
    }
    wanted.addAll(picturesIn('', css: skinCss));
    if (wanted.isEmpty) return 0;

    final done = await store.settled(workId);
    var got = 0;
    for (final url in wanted) {
      if (done.contains(url)) continue;
      if (shouldStop?.call() ?? false) break;
      final picture = await fetch(url);
      await store.put(workId, picture);
      if (picture.stored) got++;
    }
    return got;
  }

  Future<StoredPicture> fetch(String url) async {
    final target = Uri.tryParse(url);
    /* https only. A work's markup is a stranger's markup, and a plaintext
       fetch on somebody's phone is a request anyone on the network can see
       and answer. */
    if (target == null || target.scheme != 'https') {
      return StoredPicture(url: url, trouble: 'https only');
    }

    try {
      final page = await client.getBytes(target, accept: _imageAccept);
      final mime = (page.mime ?? '').split(';').first.trim().toLowerCase();

      /* Only pictures. An error page stored where an image should be renders
         as a broken one for ever, and it is stored as though it worked. */
      if (!mime.startsWith('image/')) {
        return StoredPicture(url: url, trouble: 'not an image');
      }
      if (page.bytes.isEmpty) return StoredPicture(url: url, trouble: 'empty');
      if (page.bytes.length > mostBytes) {
        return StoredPicture(url: url, trouble: 'too large');
      }

      return StoredPicture(
        url: url,
        bytes: page.bytes,
        mime: mime,
        sha256: sha256.convert(page.bytes).toString(),
      );
    } on ArchiveError catch (e) {
      return StoredPicture(url: url, trouble: e.message);
    } catch (e) {
      return StoredPicture(url: url, trouble: '$e');
    }
  }
}

const String _imageAccept = 'image/avif,image/webp,image/*,*/*;q=0.8';

/// A stored picture, as a page can refer to it.
///
/// A data URI rather than a file: the reader renders a chapter from markup
/// held in the database, and pointing at a file would mean a second thing to
/// keep in step with the first and to remember to delete.
String dataUri(String mime, Uint8List bytes) =>
    'data:$mime;base64,${base64Encode(bytes)}';
