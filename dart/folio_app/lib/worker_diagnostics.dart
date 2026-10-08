import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// Bounded app-private journal. Only numbers and booleans are accepted as data.
class WorkerDiagnostics {
  WorkerDiagnostics(this.file);
  final File file;
  Future<void> _writes = Future.value();
  final String session = DateTime.now().microsecondsSinceEpoch.toString();
  Future<void> event(String name, [Map<String, Object?> data = const {}]) {
    _writes = _writes
        .then((_) async {
          await file.parent.create(recursive: true);
          if (await file.exists() && await file.length() > 1024 * 1024) {
            final old = File('${file.path}.previous');
            if (await old.exists()) await old.delete();
            await file.rename(old.path);
          }
          final record = jsonEncode({
            'time': DateTime.now().toUtc().toIso8601String(),
            'session': session,
            'event': name,
            'data': {
              for (final e in data.entries)
                if (e.value is num || e.value is bool) e.key: e.value,
            },
          });
          await file.writeAsString(
            '$record\n',
            mode: FileMode.append,
            flush: true,
          );
        })
        .catchError((Object _) {});
    return _writes;
  }

  static Future<File> location() async => File(
    p.join(
      (await getApplicationSupportDirectory()).path,
      'download-worker.jsonl',
    ),
  );
  static Future<String> export() async {
    final source = await location();
    final target = File(
      p.join(
        (await getTemporaryDirectory()).path,
        'fanfolio-preview-downloads-${DateTime.now().millisecondsSinceEpoch}.jsonl',
      ),
    );
    final out = target.openWrite();
    for (final file in [File('${source.path}.previous'), source]) {
      if (await file.exists()) await out.addStream(file.openRead());
    }
    await out.close();
    return target.path;
  }
}
