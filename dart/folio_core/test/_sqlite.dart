import 'dart:ffi';
import 'dart:io';

import 'package:sqlite3/open.dart';

/// Find SQLite by the name it actually has.
///
/// package:sqlite3 asks for `libsqlite3.so`, which is the development symlink
/// and is only present where development headers are installed. A phone, a
/// container and this machine all have `libsqlite3.so.0` and nothing else, so
/// without this the tests do not run at all on any of them.
void useSystemSqlite() {
  if (!Platform.isLinux) return;
  open.overrideFor(OperatingSystem.linux, () {
    for (final name in ['libsqlite3.so', 'libsqlite3.so.0']) {
      try {
        return DynamicLibrary.open(name);
      } on ArgumentError {
        continue;
      }
    }
    throw StateError('no libsqlite3 on this machine');
  });
}
