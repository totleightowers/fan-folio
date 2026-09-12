/// Fetching one work, and knowing whether it arrived.
///
/// The three halves that were already here — a client that asks, a parser that
/// reads, a queue that decides when — with the piece between them that turns a
/// work id into rows in a library.
///
/// Nothing here decides how often. That is the pacer's, and the client goes
/// through it.
library;

import '../ao3/client.dart';
import '../ao3/parse.dart';
import '../ao3/text.dart';
import '../ao3/urls.dart';
import '../read/document.dart' show needsWebView;

/// One chapter, as the library stores it.
class StoredChapter {
  const StoredChapter({
    required this.number,
    required this.html,
    required this.text,
    required this.words,
    this.title,
  });

  final int number;
  final String? title;
  final String html;

  /// The words, flattened, which is what a search of the library reads.
  final String text;
  final int words;
}

/// A fetched work, on its way into storage.
///
/// Built here rather than by whoever is writing it, so the shape is decided
/// once, in the same place that parsed it: the store writes what it is given
/// and makes no decisions of its own about what a work is.
class StoredWork {
  const StoredWork({
    required this.workId,
    required this.authors,
    required this.chapters,
    required this.tags,
    this.title,
    this.summary,
    this.rating,
    this.language,
    this.words,
    this.complete = false,
    this.skinCss,
  });

  final String workId;
  final String? title;
  final List<String> authors;
  final String? summary;
  final String? rating;
  final String? language;
  final int? words;
  final bool complete;

  /// The author's own CSS, which is the work as much as the text is.
  final String? skinCss;
  final Map<String, List<String>> tags;
  final List<StoredChapter> chapters;

  /// Whether this one has to be read in a WebView rather than as native text.
  bool get skinned => needsWebView(skinCss: skinCss);
}

/// Where a fetched work goes.
///
/// An interface rather than a class, because the only implementation that can
/// exist lives in the Flutter half next to sqflite — and the point of this
/// package is that the deciding can be tested without it.
abstract interface class WorkStore {
  /// Write it, replacing whatever was held of it before.
  Future<void> save(StoredWork work);

  /// Which of these the library holds the text of.
  ///
  /// Asked rather than assumed, because a job that decides it has finished by
  /// counting — the task did not throw, so the work arrived — reports itself
  /// complete while the works it queued are still descriptions with no text.
  Future<Set<String>> held(List<String> workIds);

  /// Works the reader deleted, which are not to come back on their own.
  Future<Set<String>> refused(List<String> workIds);
}

/// Fetch one work, parse it, hand it over.
class Downloader {
  const Downloader({required this.client, required this.store});

  final ArchiveClient client;
  final WorkStore store;

  /// The whole of one work: its page, its chapters, its skin.
  Future<StoredWork> fetch(String workId) async {
    final page = await client.get(Uri.parse(workPage(workId)));
    final parsed = parseWorkPage(page.body, workId: workId);

    if (parsed.chapters.isEmpty) {
      /* Locked to registered users, deleted, or a draft — all of them look
         the same from here, and none of them is worth asking about again on
         the strength of this alone. */
      throw const ArchiveError(
        'No chapters found. The work may be restricted, deleted, '
        'or need a login.',
      );
    }

    return StoredWork(
      workId: workId,
      title: parsed.title,
      authors: parsed.authors,
      summary: parsed.summary,
      rating: parsed.rating,
      language: parsed.language,
      words: parsed.words,
      complete: parsed.complete,
      skinCss: parsed.skinCss,
      tags: parsed.tags,
      chapters: [
        for (final part in parsed.chapters) _chapterOf(part, part.number),
      ],
    );
  }

  /// Fetch it and write it, which is what the queue asks a job to do.
  Future<void> run(String workId) async {
    final refused = await store.refused([workId]);
    if (refused.contains(workId)) {
      /* The reader deleted it. Fetching it again because a listing still
         mentions it is the app overruling them, and the tombstone exists
         precisely so that does not happen. */
      return;
    }
    await store.save(await fetch(workId));
  }

  /// Which of a batch still are not here, for a job to judge itself by.
  Future<List<String>> missing(List<String> workIds) async {
    if (workIds.isEmpty) return const [];
    final have = await store.held(workIds);
    final gone = await store.refused(workIds);
    return [
      for (final workId in workIds)
        if (!have.contains(workId) && !gone.contains(workId)) workId,
    ];
  }
}

StoredChapter _chapterOf(ChapterPart part, int number) {
  /* The markup is kept as the archive sent it, because the author's own CSS
     was written against exactly that. The flattened words are stored beside
     it rather than derived at search time: a search over a million words
     cannot afford to strip tags on the way past. */
  final text = htmlToText(part.html);
  return StoredChapter(
    number: number,
    title: part.title,
    html: part.html,
    text: text,
    words: countWords(text),
  );
}
