import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// The archive session, kept beside the library rather than inside it.
///
/// Deliberately not in the library's own meta table, where the reading setup
/// lives. A backup is made to be handed to a new phone — or to a cloud, or to
/// somebody helping — and a session cookie inside one is an account somebody
/// else can sign into. What travels in a backup is the reading; what stays on
/// the phone is the signing in.
///
/// It is still only app-private storage, which is as far as this goes without
/// asking the reader for a second password. What it is not is a thing that
/// leaves the device by accident.
class Session {
  const Session({required this.cookies, this.username});

  final Map<String, String> cookies;

  /// Who the archive last said we were. A name to show, not proof of
  /// anything — the cookie behind it can be revoked on the site at any time.
  final String? username;

  bool get signedIn => cookies.isNotEmpty;

  static const Session none = Session(cookies: {});

  static Future<File> _file() async {
    final dir = await getApplicationSupportDirectory();
    return File(p.join(dir.path, 'session.json'));
  }

  static Future<Session> load() async {
    try {
      final file = await _file();
      if (!file.existsSync()) return none;
      final held = jsonDecode(await file.readAsString());
      if (held is! Map) return none;
      final jar = held['cookies'];
      return Session(
        cookies: jar is Map
            ? {for (final e in jar.entries) '${e.key}': '${e.value}'}
            : const {},
        username: held['username'] as String?,
      );
    } catch (_) {
      // an unreadable session is a reader who has to sign in again, which is
      // a small thing; refusing to start the app over it is not
      return none;
    }
  }

  Future<void> save() async {
    final file = await _file();
    await file.writeAsString(
      jsonEncode({'cookies': cookies, 'username': username}),
      flush: true,
    );
  }

  static Future<void> forget() async {
    try {
      final file = await _file();
      if (file.existsSync()) await file.delete();
    } catch (_) {
      // nothing to be done about it, and nothing that depends on it
    }
  }
}
