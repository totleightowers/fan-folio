/// Reading a form off a page, so the app submits what the archive asked for.
///
/// Kudos, bookmarks, comments and signing in are all ordinary Rails forms. The
/// alternative to this is hardcoding their field names — `kudo[commentable_id]`,
/// `bookmark[pseud_id]` — which means guessing at a private API and being
/// silently wrong the day any of them changes. A form already carries its own
/// action, method, CSRF token and defaults; reading them is both more honest
/// and more durable than knowing them.
///
/// Nothing here performs a request.
library;

/// Attributes of a single tag.
///
/// Valueless attributes count. `selected` and `checked` are usually written
/// bare, and they are the two that decide what a form actually submits — a
/// parser that only sees name="value" pairs reads every option as unselected
/// and every box as unticked, then submits the wrong ones.
Map<String, String> _attrsOf(String tag) {
  final out = <String, String>{};
  // the tag name itself is not an attribute
  final body = tag.replaceFirst(RegExp(r'^<\s*[a-zA-Z][-\w:.]*'), '');
  final attr = RegExp(
    '''([a-zA-Z_:][-\\w:.]*)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?''',
  );
  for (final m in attr.allMatches(body)) {
    final value = m[2] ?? m[3] ?? m[4];
    out[m[1]!.toLowerCase()] = value == null ? '' : decodeFormEntities(value);
  }
  return out;
}

/// The entities Rails escapes into attribute values.
///
/// A CSRF token is base64 and routinely contains `+` and `/`; it is the `&`
/// that matters here, since a token submitted with a literal `&amp;` in it is
/// simply the wrong token and the archive rejects the whole request.
String decodeFormEntities(String text) => text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll(RegExp(r'&#0?39;'), "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/// The whole of one form element, counting nested forms out of caution.
String? _formHtml(String html, String match) {
  final open = RegExp('<form\\b[^>]*$match[^>]*>', caseSensitive: false);
  final found = open.firstMatch(html);
  if (found == null) return null;
  final end = html.indexOf('</form>', found.start);
  return end == -1
      ? html.substring(found.start)
      : html.substring(found.start, end);
}

/// A form, as the thing a browser would send.
class ArchiveForm {
  const ArchiveForm({
    required this.action,
    required this.method,
    required this.fields,
  });

  final String action;
  final String method;
  final Map<String, String> fields;
}

/// A form's action, method and every value it would submit untouched.
///
/// [match] is a fragment matched inside the opening tag — an id or an action —
/// because the forms wanted here are identified differently on the page.
///
/// Unchecked boxes and unselected options are left out, exactly as a browser
/// would leave them out. Submitting them is how a private bookmark quietly
/// becomes a public one.
ArchiveForm? parseForm(String? html, String match) {
  final body = _formHtml(html ?? '', match);
  if (body == null) return null;

  final open =
      RegExp(r'<form\b[^>]*>', caseSensitive: false).firstMatch(body)?[0] ?? '';
  final form = _attrsOf(open);
  final fields = <String, String>{};

  for (final tag
      in RegExp(r'<input\b[^>]*>', caseSensitive: false).allMatches(body)) {
    final a = _attrsOf(tag[0]!);
    final name = a['name'];
    if (name == null || name.isEmpty) continue;
    final type = (a['type'] ?? 'text').toLowerCase();
    if (const {'submit', 'button', 'file', 'image'}.contains(type)) continue;
    // a browser sends a checkbox only when it is ticked, and so do we
    if ((type == 'checkbox' || type == 'radio') && !a.containsKey('checked')) {
      continue;
    }
    fields[name] = a['value'] ?? (type == 'checkbox' ? 'on' : '');
  }

  for (final tag in RegExp(
    r'<textarea\b[^>]*>([\s\S]*?)</textarea>',
    caseSensitive: false,
  ).allMatches(body)) {
    final open = RegExp(
      r'<textarea\b[^>]*>',
      caseSensitive: false,
    ).firstMatch(tag[0]!)![0]!;
    final name = _attrsOf(open)['name'];
    if (name != null && name.isNotEmpty) {
      fields[name] = decodeFormEntities(tag[1] ?? '');
    }
  }

  for (final tag in RegExp(
    r'<select\b[^>]*>([\s\S]*?)</select>',
    caseSensitive: false,
  ).allMatches(body)) {
    final open = RegExp(
      r'<select\b[^>]*>',
      caseSensitive: false,
    ).firstMatch(tag[0]!)![0]!;
    final name = _attrsOf(open)['name'];
    if (name == null || name.isEmpty) continue;
    final options = [
      for (final o in RegExp(
        r'<option\b[^>]*>',
        caseSensitive: false,
      ).allMatches(tag[1] ?? ''))
        _attrsOf(o[0]!),
    ];
    if (options.isEmpty) continue;
    // the selected one, or the first — which is what the browser would send
    final chosen = options.firstWhere(
      (o) => o.containsKey('selected'),
      orElse: () => options.first,
    );
    fields[name] = chosen['value'] ?? '';
  }

  return ArchiveForm(
    action: form['action'] ?? '',
    method: (form['method'] ?? 'post').toLowerCase(),
    fields: fields,
  );
}

/// The CSRF token, wherever it is on the page, for forms built by script.
String? csrfToken(String? html) {
  final page = html ?? '';
  final meta = RegExp(
    '<meta\\b[^>]*name=["\']csrf-token["\'][^>]*>',
    caseSensitive: false,
  ).firstMatch(page);
  if (meta != null) return _attrsOf(meta[0]!)['content'];
  final input = RegExp(
    '<input\\b[^>]*name=["\']authenticity_token["\'][^>]*>',
    caseSensitive: false,
  ).firstMatch(page);
  return input == null ? null : _attrsOf(input[0]!)['value'];
}

/// Form fields as a body the archive will accept.
String encodeForm(Map<String, String?> fields) => [
      for (final entry in fields.entries)
        if (entry.value != null)
          '${Uri.encodeComponent(entry.key)}='
              '${Uri.encodeComponent(entry.value!)}',
    ].join('&');
