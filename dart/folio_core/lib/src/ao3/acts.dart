/// The things that leave the phone.
///
/// Everything else in this app reads. These three write to somebody's account
/// on a public site: kudos are permanent, a comment notifies the author, a
/// bookmark appears on a profile. So each one reads the archive's own form
/// first and submits what that form asks for, rather than what this app
/// happens to believe the field names are.
///
/// Nothing here is done twice by accident, and nothing is sent anywhere but
/// the archive: a form action that points elsewhere is refused rather than
/// followed.
library;

import 'client.dart';
import 'forms.dart';
import 'urls.dart' show origin, workPage;

/// What came of an act on the archive.
class Acted {
  const Acted({required this.workId, this.already = false});

  final String workId;

  /// It was already done, which the archive reports as an error and which is
  /// the one error worth treating as a success.
  final bool already;
}

/// The path a form action names, refusing anything that leaves the archive.
///
/// A form is a stranger's markup. An action pointing at another host is a
/// signed-in write sent somewhere nobody asked for, and there is no reading of
/// that which is worth following.
Uri actionOnArchive(String action) {
  final url = Uri.parse(origin).resolve(action);
  if (url.origin != Uri.parse(origin).origin) {
    throw const ArchiveError(
      'That form points somewhere other than the archive.',
    );
  }
  return url;
}

/// The first of several shapes a form might be identified by.
ArchiveForm? findForm(String html, List<String> matchers) {
  for (final matcher in matchers) {
    final form = parseForm(html, matcher);
    if (form != null) return form;
  }
  return null;
}

/// Leaving kudos, commenting, and bookmarking, as the signed-in reader.
class Acts {
  const Acts(this.client);

  final ArchiveClient client;

  /// Leave kudos.
  ///
  /// The archive accepts them once per work per person and answers a second
  /// attempt with an error rather than a success — which is why a work
  /// records that they were left. There is no way to ask afterwards.
  Future<Acted> kudos(String workId) async {
    final page = await client.get(Uri.parse(workPage(workId)));
    final form = findForm(page.body, [
      'id="new_kudo"',
      'action="/kudos"',
      'id="kudo_submit"',
    ]);
    if (form == null) {
      throw const ArchiveError(
        'The archive did not offer a kudos form on that work. It may not '
        'take them, or the session may have lapsed.',
      );
    }

    try {
      final answer = await client.post(
        actionOnArchive(form.action),
        form.fields,
      );
      return Acted(workId: workId, already: _alreadyKudosed(answer.body));
    } on ArchiveError catch (e) {
      /* The archive says so in the page it returns rather than in the status:
         a duplicate is an error, and an error saying "already left kudos" is
         the one outcome worth treating as having worked. */
      if (_alreadyKudosed(e.body ?? '') || _alreadyKudosed(e.message)) {
        return Acted(workId: workId, already: true);
      }
      rethrow;
    }
  }

  /// Bookmark a work.
  ///
  /// The form lives on its own page rather than on the work, and carries the
  /// reader's pseud and their defaults — which is exactly why it is read
  /// rather than reconstructed. An unticked box is left out, because
  /// submitting one is how a private bookmark quietly becomes a public one.
  Future<Acted> bookmark(
    String workId, {
    String notes = '',
    String tags = '',
    bool private = false,
    bool rec = false,
  }) async {
    /* view_adult, for the same reason a work page sends it: without it a
       Mature work answers with the consent interstitial instead of the page
       asked for, and that interstitial carries a form of its own. */
    final page = await client.get(
      Uri.parse('$origin/works/$workId/bookmarks/new?view_adult=true'),
    );
    final form = findForm(page.body, [
      'id="bookmark-form"',
      'id="new_bookmark"',
      'action="/works/$workId/bookmarks"',
    ]);
    if (form == null) {
      throw const ArchiveError(
        'The archive did not offer a bookmark form for that work.',
      );
    }

    final fields = {...form.fields};
    void set(String suffix, Object value) {
      final key = fields.keys.firstWhere(
        (k) => k.endsWith(suffix),
        orElse: () => 'bookmark${suffix}',
      );
      if (value == false) {
        // a browser does not send an unticked box, and neither do we
        fields.remove(key);
      } else {
        fields[key] = value == true ? '1' : '$value';
      }
    }

    if (notes.isNotEmpty) set('[bookmarker_notes]', notes);
    if (tags.isNotEmpty) set('[tag_string]', tags);
    set('[private]', private);
    set('[rec]', rec);

    await client.post(actionOnArchive(form.action), fields);
    return Acted(workId: workId);
  }

  /// Leave a comment.
  ///
  /// An empty one is refused before anything is sent: it is a form-error
  /// round trip that tells the reader nothing they did not already know.
  Future<Acted> comment(String workId, String text) async {
    final said = text.trim();
    if (said.isEmpty) {
      throw const ArchiveError('There is nothing to say yet.');
    }

    final page = await client.get(Uri.parse(workPage(workId)));
    final form = findForm(page.body, [
      'id="new_comment"',
      'action="/works/$workId/comments"',
    ]);
    if (form == null) {
      throw const ArchiveError('That work does not take comments.');
    }

    final fields = {...form.fields};
    final key = fields.keys.firstWhere(
      (k) => k.endsWith('[comment_content]'),
      orElse: () => 'comment[comment_content]',
    );
    fields[key] = said;

    await client.post(actionOnArchive(form.action), fields);
    return Acted(workId: workId);
  }
}

bool _alreadyKudosed(String text) =>
    RegExp('already left kudos', caseSensitive: false).hasMatch(text);
