/// An archive search, kept separately from local-library filters.
library;

import 'urls.dart';
import 'parse.dart';

/// Only AO3's documented work-search fields are accepted. URLs are always
/// constructed here, never supplied by the UI or a saved search.
class ArchiveSearch {
  const ArchiveSearch({this.fields = const {}, this.author});
  final Map<String, String> fields;
  final String? author;

  static const allowed = {
    'query',
    'title',
    'creators',
    'fandom_names',
    'relationship_names',
    'character_names',
    'freeform_names',
    'complete',
    'crossover',
    'word_count',
    'language_id',
    'rating_ids',
    'sort_column',
    'sort_direction',
  };

  factory ArchiveSearch.fromJson(Map<String, dynamic> data) => ArchiveSearch(
        author: data['author'] as String?,
        fields: {
          for (final e in (data['fields'] as Map? ?? {}).entries)
            if (allowed.contains(e.key) && e.value is String)
              e.key as String: e.value as String,
        },
      );

  Map<String, Object?> toJson() => {'fields': fields, 'author': author};

  Uri page(int page) {
    if (page < 1) throw ArgumentError.value(page, 'page');
    if (author != null) return Uri.parse(authorWorks(author, page));
    return Uri.parse('$origin/works/search').replace(queryParameters: {
      'commit': 'Search',
      'page': '$page',
      for (final e in fields.entries)
        if (allowed.contains(e.key) && e.value.trim().isNotEmpty)
          'work_search[${e.key}]': e.value.trim(),
    });
  }

  String get label => author != null
      ? 'Works by $author'
      : fields.entries
          .where((e) => !e.key.startsWith('sort_') && e.value.trim().isNotEmpty)
          .map((e) => e.value)
          .take(3)
          .join(' · ');
}

Map<String, Object?> blurbToJson(Blurb b) => {
      'workId': b.workId,
      'title': b.title,
      'authors': b.authors,
      'anonymous': b.anonymous,
      'fandoms': b.fandoms,
      'rating': b.rating,
      'warnings': b.warnings,
      'relationships': b.relationships,
      'characters': b.characters,
      'freeform': b.freeform,
      'categories': b.categories,
      'complete': b.complete,
      'summary': b.summary,
      'language': b.language,
      'words': b.words,
      'chapters': b.chapters,
      'chaptersPlanned': b.chaptersPlanned,
      'kudos': b.kudos,
      'hits': b.hits,
      'bookmarkCount': b.bookmarkCount,
      'datetime': b.datetime,
      'updatedAt': b.updatedAt,
      'bookmarkId': b.bookmarkId,
    };

Blurb blurbFromJson(Map<String, dynamic> b) {
  List<String> list(String key) => (b[key] as List? ?? []).cast<String>();
  return Blurb(
    workId: b['workId'] as String,
    title: b['title'] as String?,
    authors: list('authors'),
    anonymous: b['anonymous'] == true,
    fandoms: list('fandoms'),
    rating: b['rating'] as String?,
    warnings: list('warnings'),
    relationships: list('relationships'),
    characters: list('characters'),
    freeform: list('freeform'),
    categories: list('categories'),
    complete: b['complete'] == true,
    summary: b['summary'] as String?,
    language: b['language'] as String?,
    words: b['words'] as int?,
    chapters: b['chapters'] as int?,
    chaptersPlanned: b['chaptersPlanned'] as int?,
    kudos: b['kudos'] as int?,
    hits: b['hits'] as int?,
    bookmarkCount: b['bookmarkCount'] as int?,
    datetime: b['datetime'] as String?,
    updatedAt: b['updatedAt'] as int?,
    bookmarkId: b['bookmarkId'] as String?,
  );
}

Map<String, Object?> listingToJson(Listing l) => {
      'current': l.current,
      'total': l.total,
      'works': l.works.map(blurbToJson).toList(),
    };
Listing listingFromJson(Map<String, dynamic> l) => Listing(
      current: l['current'] as int,
      total: l['total'] as int,
      works: [
        for (final b in l['works'] as List)
          blurbFromJson(Map<String, dynamic>.from(b as Map))
      ],
    );
