/// Every AO3 URL this app asks for, in one place.
///
/// Centralised so the crawler cannot invent an endpoint by string
/// concatenation halfway through a run, and so the politeness rules have a
/// single surface to cover. Nothing here performs a request.
library;

const String origin = 'https://archiveofourown.org';
const String downloadOrigin = 'https://download.archiveofourown.org';

/// AO3 puts 20 works on a listing page and offers no way to ask for more.
const int perPage = 20;

String _enc(Object? value) => Uri.encodeComponent('$value');

/// The whole work, all chapters, in one response — and the only place the
/// author's work skin appears. This is the fetch the archive is built on.
String workPage(Object workId, {bool comments = false}) {
  final params = <String, String>{
    'view_full_work': 'true',
    'view_adult': 'true',
    if (comments) 'show_comments': 'true',
  };
  final query = params.entries.map((e) => '${e.key}=${e.value}').join('&');
  return '$origin/works/${_id(workId)}?$query';
}

/// Lighter and cacheable, but carries no work skin. For text-only refetches.
String workDownload(Object workId, [String slug = 'work']) =>
    '$downloadOrigin/downloads/${_id(workId)}/${_enc(slug)}.html';

/// Reading history. Login required, and it is per-user, so the name matters.
String readings(String user, [int page = 1]) =>
    '$origin/users/${_enc(user)}/readings?page=$page';

final RegExp _paren = RegExp(r'^(.*?)\s*\(([^()]+)\)$');

/// Where a byline points.
///
/// The archive writes a byline as "Pseud (Username)" whenever the two differ,
/// and roughly a quarter of a library is that shape. Handing that whole string
/// over as a username asks for /users/Anna%20(pineconepickers) and is answered
/// with a 404 — which is what every one of those authors did.
///
/// The link the archive puts on its own byline is the pseud's:
///
///   <a rel="author" href="/users/pineconepickers/pseuds/Anna">Anna (pineconepickers)</a>
///
/// so that is the shape built here, and a bare name is a pseud of the same
/// name. Going by pseud rather than account is not only what the byline means,
/// it is the only safe reading of one: orphaned works are posted under
/// orphan_account, whose account page holds over a million works. An app that
/// resolved a byline to its account would answer a tap on one orphaned story
/// by trying to download the entire orphanage.
String authorPath(String? byline) {
  final name = (byline ?? '').trim();
  final match = _paren.firstMatch(name);
  final pseud = match != null ? match.group(1)!.trim() : name;
  final user = match != null ? match.group(2)!.trim() : name;
  return '/users/${_enc(user)}/pseuds/${_enc(pseud)}';
}

/// Works and bookmarks are the archive's own name for these two tabs.
String authorProfile(String? byline) => '$origin${authorPath(byline)}';
String authorWorks(String? byline, [int page = 1]) =>
    '$origin${authorPath(byline)}/works?page=$page';
String authorBookmarks(String? byline, [int page = 1]) =>
    '$origin${authorPath(byline)}/bookmarks?page=$page';

/// Orphaning is the archive's way of keeping a work and losing its author, and
/// it means what it says: the pseud page 404s even though the byline links to
/// it. There is no catalogue behind these names, so there is nothing to walk.
bool isOrphan(String? byline) {
  final name = (byline ?? '').trim();
  final match = _paren.firstMatch(name);
  return (match != null ? match.group(2)!.trim() : name) == 'orphan_account';
}

/// A person's own page, which states how much they have — Works (89),
/// Bookmarks (503) — so one request can say there is nothing to do, where
/// finding that out by walking is a page for every twenty works.
String userProfile(String user) => '$origin/users/${_enc(user)}';

String userWorks(String user, [int page = 1]) =>
    '$origin/users/${_enc(user)}/works?page=$page';

String bookmarks(String user, [int page = 1]) =>
    '$origin/users/${_enc(user)}/bookmarks?page=$page';

/// Marked-for-later lives on the readings page behind a filter.
String markedForLater(String user, [int page = 1]) =>
    '$origin/users/${_enc(user)}/readings?page=$page&show=to-read';

String workUrl(Object workId) => '$origin/works/${_id(workId)}';

/// A chapter on its own. The archive redirects it to the work that owns it.
String chapterUrl(Object chapterId) => '$origin/chapters/${_id(chapterId)}';

String seriesPage(Object seriesId, [int page = 1]) =>
    '$origin/series/${_id(seriesId)}?page=$page';

/// An id is a number in the URL, so it is made into one before it goes in.
int _id(Object? value) =>
    value is int ? value : (int.tryParse('$value'.trim()) ?? 0);

/// Every host the archive answers on.
///
/// All of these were checked and every one redirects to archiveofourown.org,
/// so a link in any of these shapes is a link to the same work — and people
/// paste all of them. ao3.org in particular is what gets typed by hand and
/// what fits in a message. download.* is the host the archive's own download
/// links use, so a shared EPUB or HTML link arrives on it.
const Set<String> ao3Hosts = {
  'archiveofourown.org',
  'www.archiveofourown.org',
  'ao3.org',
  'www.ao3.org',
  'archiveofourown.com',
  'www.archiveofourown.com',
  'download.archiveofourown.org',
};

/// Is this a link the archive would answer? Bare ids count: people paste those.
bool isAo3Link(Object? input) {
  final text = '${input ?? ''}'.trim();
  if (text.isEmpty) return false;
  if (RegExp(r'^\d+$').hasMatch(text)) return true;
  final uri = Uri.tryParse(text.startsWith('http') ? text : 'https://$text');
  if (uri == null) return false;
  return ao3Hosts.contains(uri.host.toLowerCase());
}

/// What kind of thing a link points at.
enum LinkKind { work, chapter, series, external, unknown }

/// What a link actually points at.
///
/// The archive names works in more shapes than one: inside a collection, as a
/// chapter deep-link, as a chapter on its own, as a download, as a series, as
/// a stub pointing somewhere off-site entirely. They are not interchangeable —
/// a chapter id is not a work id, and fetching /works/<chapter id> would
/// quietly return the wrong story rather than fail.
class LinkTarget {
  const LinkTarget(this.kind,
      {this.workId, this.chapterId, this.seriesId, this.externalId});

  final LinkKind kind;

  /// Known and fetchable now.
  final String? workId;

  /// Only a chapter id; the archive must resolve which work owns it.
  final String? chapterId;
  final String? seriesId;

  /// A stub for a work hosted somewhere else entirely: the archive holds the
  /// metadata but not the text, so there is nothing here to fetch. Recognised
  /// so it can be refused clearly rather than looking like a broken link.
  final String? externalId;
}

LinkTarget linkTarget(Object? input) {
  final text = '${input ?? ''}'.trim();
  if (text.isEmpty) return const LinkTarget(LinkKind.unknown);
  if (RegExp(r'^\d+$').hasMatch(text))
    return LinkTarget(LinkKind.work, workId: text);

  final path = _pathOf(text);

  // /works/123, /works/123/chapters/456, /collections/x/works/123
  final work = RegExp(r'/works/(\d+)(?:[/?#]|$)').firstMatch(path);
  if (work != null) return LinkTarget(LinkKind.work, workId: work.group(1));

  // the archive's own download links: /downloads/123/title.epub
  final download = RegExp(r'/downloads/(\d+)/').firstMatch(path);
  if (download != null)
    return LinkTarget(LinkKind.work, workId: download.group(1));

  // a chapter with no work in the path; only the archive knows which work
  final chapter = RegExp(r'/chapters/(\d+)(?:[/?#]|$)').firstMatch(path);
  if (chapter != null)
    return LinkTarget(LinkKind.chapter, chapterId: chapter.group(1));

  final series = RegExp(r'/series/(\d+)(?:[/?#]|$)').firstMatch(path);
  if (series != null)
    return LinkTarget(LinkKind.series, seriesId: series.group(1));

  final external = RegExp(r'/external_works/(\d+)').firstMatch(path);
  if (external != null)
    return LinkTarget(LinkKind.external, externalId: external.group(1));

  return const LinkTarget(LinkKind.unknown);
}

/// The work id out of anything a person is likely to paste, or null rather
/// than a guess: a chapter id is not a work id, and fetching
/// /works/<chapter id> would quietly return a different story.
String? workIdFrom(Object? input) {
  final target = linkTarget(input);
  return target.kind == LinkKind.work ? target.workId : null;
}

/// The path part, whether or not the caller included a scheme or a host.
String _pathOf(String text) {
  final uri = Uri.tryParse(text.startsWith('http') ? text : 'https://$text');
  // a fragment of a path is still worth matching against
  return uri?.path.isNotEmpty == true ? uri!.path : text;
}
