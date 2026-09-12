/// Markup to plain text, exactly the way 1.x does it.
///
/// This decides what a summary reads like, what the search index contains and
/// what a work's length is, so the two versions cannot each have their own
/// idea of it. Ported statement for statement rather than reimplemented with
/// a DOM walk, because "close enough" here means a library where the same work
/// has two different word counts depending on which app wrote the row.
library;

const Map<String, String> _entities = {
  'amp': '&',
  'lt': '<',
  'gt': '>',
  'quot': '"',
  'apos': "'",
  'nbsp': ' ',
  'mdash': '—',
  'ndash': '–',
  'hellip': '…',
  'rsquo': '’',
  'lsquo': '‘',
  'ldquo': '“',
  'rdquo': '”',
};

String decodeEntities(String s) =>
    s.replaceAllMapped(RegExp(r'&(#x?[0-9a-f]+|[a-z]+);', caseSensitive: false),
        (m) {
      final body = m.group(1)!;
      if (body.startsWith('#')) {
        final hex = body.length > 1 && (body[1] == 'x' || body[1] == 'X');
        final code = hex
            ? int.tryParse(body.substring(2), radix: 16)
            : int.tryParse(body.substring(1));
        return code == null ? m.group(0)! : String.fromCharCode(code);
      }
      return _entities[body.toLowerCase()] ?? m.group(0)!;
    });

final _script = RegExp(
  r'<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)',
  caseSensitive: false,
);
final _closingBlock = RegExp(
  r'<\/(p|div|h[1-6]|li|blockquote|tr)>',
  caseSensitive: false,
);
final _openingBlock = RegExp(
  r'(?<!\n)<(p|div|h[1-6]|li|blockquote|tr)\b[^>]*>',
  caseSensitive: false,
);
final _br = RegExp(r'<br\s*\/?>', caseSensitive: false);
final _anyTag = RegExp(r'<[^>]*>');

/// Plain text, for indexing, word counts and summaries.
///
/// Tags come out to a fixed point, not in one pass: `<scr<script>ipt>` holds
/// no complete tag until the inner one goes, at which point the outer halves
/// join into a real one — so a single pass can create the very thing it
/// removes. Looping until nothing changes settles it, and terminates because
/// every pass that changes the string shortens it.
///
/// An opening block tag ends a line too, where one has not ended already.
/// Fic markup is full of paragraphs nobody closed, and `<p>one<p>two` is two
/// paragraphs to every browser that has ever rendered it.
String htmlToText(String? html) {
  var out = html ?? '';
  String previous;
  do {
    previous = out;
    out = out
        .replaceAll(_script, '')
        .replaceAll(_closingBlock, '\n')
        .replaceAll(_openingBlock, '\n')
        .replaceAll(_br, '\n')
        .replaceAll(_anyTag, '');
  } while (out != previous);

  return decodeEntities(out)
      .replaceAll(RegExp('[ \t\u00A0]+'), ' ')
      .replaceAll(RegExp(r'\n\s*\n\s*\n+'), '\n\n')
      .trim();
}

/// Words, counted the way the library counts them.
int countWords(String text) =>
    RegExp(r"[\p{L}\p{N}'’-]+", unicode: true).allMatches(text).length;
