import 'dart:convert';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

void main() {
  test('search fields round trip and cannot change the archive origin', () {
    const search = ArchiveSearch(fields: {
      'query': 'a & b -"unwanted"',
      'relationship_names': 'A/B',
      'complete': 'T',
      'sort_column': 'kudos_count',
      'sort_direction': 'desc',
      'url': 'https://example.com',
    });
    final saved =
        ArchiveSearch.fromJson(jsonDecode(jsonEncode(search.toJson())));
    final url = saved.page(2);
    expect(url.origin, origin);
    expect(url.path, '/works/search');
    expect(url.queryParameters['page'], '2');
    expect(url.queryParameters['work_search[query]'], 'a & b -"unwanted"');
    expect(url.queryParameters['work_search[relationship_names]'], 'A/B');
    expect(url.queryParameters.keys.any((key) => key.contains('url')), isFalse);
    expect(() => search.page(0), throwsArgumentError);
  });

  test('author discovery uses the same pseud as the archive byline', () {
    final url = const ArchiveSearch(author: 'Anna (pineconepickers)').page(3);
    expect(url.path, '/users/pineconepickers/pseuds/Anna/works');
    expect(url.queryParameters['page'], '3');
  });

  test('worker listing transport preserves metadata and pagination', () {
    final listing = Listing(current: 2, total: 7, works: [
      const Blurb(
          workId: '123',
          title: 'Story',
          anonymous: false,
          characters: [],
          freeform: [],
          categories: [],
          complete: false,
          authors: ['Author'],
          relationships: ['A/B'],
          fandoms: ['Fandom'],
          rating: 'Teen And Up Audiences',
          warnings: ['No Archive Warnings Apply'],
          chapters: 2,
          chaptersPlanned: 4,
          updatedAt: 12345678,
          bookmarkId: '42'),
    ]);
    final transported =
        listingFromJson(jsonDecode(jsonEncode(listingToJson(listing))));
    expect(transported.current, 2);
    expect(transported.total, 7);
    expect(blurbToJson(transported.works.single),
        blurbToJson(listing.works.single));
  });
}
