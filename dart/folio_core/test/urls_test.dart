import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// The same links as `test/ao3-links.test.mjs`, asked of the Dart port.
///
/// A link gets shared in every shape there is: a chapter deep-link, a
/// collection's copy, a download on another host, a URL with tracking junk, a
/// bare id. All of them name the same work, and the two versions of this app
/// have to agree about which.
const String work = '58374928';

const List<String> namesAWork = [
  'https://archiveofourown.org/works/$work',
  'https://www.archiveofourown.org/works/$work',
  'https://ao3.org/works/$work',
  'https://www.ao3.org/works/$work',
  'https://archiveofourown.com/works/$work',
  // a chapter deep-link still names its work
  'https://archiveofourown.org/works/$work/chapters/58374929',
  // the full-work view, and the adult interstitial already accepted
  'https://archiveofourown.org/works/$work?view_full_work=true',
  'https://archiveofourown.org/works/$work?view_adult=true&view_full_work=true',
  // inside a collection
  'https://archiveofourown.org/collections/somefest2024/works/$work',
  // the chapter index
  'https://archiveofourown.org/works/$work/navigate',
  // the archive's own download links, on their own host
  'https://download.archiveofourown.org/downloads/$work/Some%20Title.epub',
  'https://download.archiveofourown.org/downloads/$work/Some%20Title.html',
  // shared with tracking junk, or a fragment
  'https://archiveofourown.org/works/$work?utm_source=tumblr',
  'https://archiveofourown.org/works/$work#workskin',
  // and the bare id, which people paste too
  work,
];

void main() {
  for (final url in namesAWork) {
    test('names a work: $url', () {
      final target = linkTarget(url);
      expect(target.kind, LinkKind.work);
      expect(target.workId, work);
      expect(workIdFrom(url), work);
    });
  }

  test('a chapter on its own is not a work id', () {
    // fetching /works/58374929 would quietly return a different story
    final target = linkTarget('https://archiveofourown.org/chapters/58374929');
    expect(target.kind, LinkKind.chapter);
    expect(target.chapterId, '58374929');
    expect(workIdFrom('https://archiveofourown.org/chapters/58374929'), isNull);
  });

  test('a series names many works, not one', () {
    final target = linkTarget('https://archiveofourown.org/series/1234567');
    expect(target.kind, LinkKind.series);
    expect(target.seriesId, '1234567');
  });

  test('an external work is a stub with nothing to fetch', () {
    expect(linkTarget('https://archiveofourown.org/external_works/98765').kind,
        LinkKind.external);
  });

  test('listings name no particular work', () {
    for (final url in [
      'https://archiveofourown.org/users/someone/works',
      'https://archiveofourown.org/users/someone/bookmarks',
      'https://archiveofourown.org/tags/Fluff/works',
      'https://archiveofourown.org/collections/somefest2024',
      'https://archiveofourown.org/',
    ]) {
      expect(linkTarget(url).kind, LinkKind.unknown, reason: url);
    }
  });

  test('a link that is not the archive is refused rather than guessed at', () {
    for (final url in [
      'https://example.com/works/123',
      'https://ao3.org.evil.example/works/123',
      'not a link at all',
      '',
    ]) {
      expect(isAo3Link(url), isFalse, reason: url);
    }
    expect(isAo3Link('archiveofourown.org/works/$work'), isTrue,
        reason: 'people paste links without the scheme');
    expect(isAo3Link(work), isTrue, reason: 'and bare ids');
  });

  test('a byline names a pseud, and that is where its works are', () {
    expect(authorWorks('Anna (pineconepickers)'),
        'https://archiveofourown.org/users/pineconepickers/pseuds/Anna/works?page=1',
        reason: 'the whole byline as a username is the 404 this fixes');
    expect(authorWorks('beebalm'),
        'https://archiveofourown.org/users/beebalm/pseuds/beebalm/works?page=1',
        reason: 'a bare name is a pseud of the same name');
    expect(authorProfile('Mother of Pearl (notnacre)'),
        'https://archiveofourown.org/users/notnacre/pseuds/Mother%20of%20Pearl',
        reason:
            'a pseud with a space still has to survive being put in a path');
  });

  test('a tap on an orphaned work does not download the orphanage', () {
    expect(isOrphan('x______o (orphan_account)'), isTrue);
    expect(isOrphan('orphan_account'), isTrue);
    expect(isOrphan('beebalm'), isFalse);
    // Resolving a byline to its account instead of its pseud would send this
    // one to /users/orphan_account, which holds over a million works.
    expect(authorWorks('x______o (orphan_account)'),
        contains('/users/orphan_account/pseuds/x______o/works'));
  });

  test('the work page asks for the whole work and gets past the interstitial',
      () {
    final url = workPage(work);
    expect(url, contains('view_full_work=true'));
    expect(url, contains('view_adult=true'),
        reason: 'or an explicit work answers with a warning page and no text');
  });
}
