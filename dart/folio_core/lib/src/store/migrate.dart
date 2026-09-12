/// Bringing an older library up to the shape this version queries.
///
/// Ported from `ensureColumns` in app/core/store/schema.js. A library is a
/// file somebody keeps for years: it is backed up, carried between phones, and
/// imported into a version written long after it. So every version has to be
/// able to open one written by an earlier one, and the only migration ever
/// attempted is adding what is missing — SQLite records a new column in the
/// table definition without touching a row, so it is quick on a large library
/// and safe to run on every open.
library;

import 'schema.g.dart';

/// The little of a database this needs, so the logic can be tested with one
/// driver and shipped with another. `package:sqlite3` in a test, `sqflite` in
/// the app; neither belongs in here.
abstract interface class SqlRunner {
  Future<List<Map<String, Object?>>> query(String sql, [List<Object?> args]);
  Future<void> execute(String sql);
}

/// A column as the schema declares it, with enough DDL to add it.
class _Column {
  const _Column(this.name, this.ddl);
  final String name;
  final String ddl;
}

/// The columns the schema declares for one table.
List<_Column> _declared(String table) {
  final create = schemaStatements.firstWhere(
    (s) => s.contains('CREATE TABLE IF NOT EXISTS $table ('),
    orElse: () => '',
  );
  if (create.isEmpty) return const [];

  final body = create.substring(create.indexOf('(') + 1);
  final columns = <_Column>[];
  for (final line in body.split('\n')) {
    final match = RegExp(r'^\s{2}([a-z_]+)\s+(TEXT|INTEGER|REAL)([^,\n]*)')
        .firstMatch(line);
    if (match == null) continue;
    final rest = match.group(3) ?? '';
    // a default travels with the column; a primary key is not addable later
    final ddl = rest.contains('DEFAULT')
        ? '${match.group(2)}$rest'.trim()
        : match.group(2)!;
    columns.add(_Column(match.group(1)!, ddl));
  }
  return columns;
}

/// The tables a library keeps, beyond the ones the schema always creates.
///
/// `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that exists, so
/// a column added to the schema arrives for new libraries and for nobody else.
/// These two are the ones the library query reads, and a single missing column
/// in either is not a missing shelf — it is the library screen.
const List<String> _migrated = ['works', 'reading'];

/// Add what is missing. Returns the names of the columns added, which is
/// empty on a current library and on every run after the first.
Future<List<String>> ensureColumns(SqlRunner db) async {
  final added = <String>[];
  for (final table in _migrated) {
    final info = await db.query('PRAGMA table_info($table)');
    if (info.isEmpty) continue; // no such table yet; the schema will make it
    final have = info.map((r) => '${r['name']}').toSet();
    for (final column in _declared(table)) {
      if (have.contains(column.name)) continue;
      try {
        // quoted, because one of these columns is called offset and that is a
        // keyword everywhere else in a statement
        await db.execute('ALTER TABLE $table ADD COLUMN "${column.name}" ${column.ddl}');
        added.add(column.name);
      } catch (_) {
        // a column that cannot be added must not stop the ones that can
      }
    }
  }
  return added;
}

/// Everything a library needs before it is queried: the tables it lacks, then
/// the columns they lack.
Future<List<String>> prepare(SqlRunner db) async {
  for (final statement in schemaStatements) {
    try {
      await db.execute(statement);
    } catch (_) {
      // an index or a virtual table an older SQLite will not make is not a
      // reason to refuse the library; the query that needs it will say so
    }
  }
  return ensureColumns(db);
}
