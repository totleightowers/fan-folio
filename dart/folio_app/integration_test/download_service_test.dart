import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:integration_test/integration_test.dart';
import 'package:folio_app/keep_working.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/remote_downloads.dart';
import 'package:folio_app/session.dart';
import 'package:folio_app/worker_diagnostics.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Android service opens the library and accepts a UI command', (
    tester,
  ) async {
    prepareDownloadService();
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: Text('Service test'))),
    );
    final library = await Library.create();
    RemoteDownloads? ui;
    try {
      ui = RemoteDownloads(library: library, session: Session.none);
      await ui.restore();
      // Empty work list exercises the real Android service and SQLite, with
      // no archive requests, cookies, or remote account involved.
      final id = await ui
          .addWorks('Android service fixture', [])
          .timeout(const Duration(seconds: 45));
      expect(id, greaterThan(0));
      for (var i = 0; i < 50 && ui.jobs.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
      expect(ui.jobs.single.author, 'Android service fixture');
      expect(ui.storageProblem, isNull);
      ui.dispose();
      ui = RemoteDownloads(library: library, session: Session.none);
      await ui.restore();
      expect(ui.jobs, hasLength(1));
    } finally {
      ui?.dispose();
      await FlutterForegroundTask.stopService();
      final log = await WorkerDiagnostics.location();
      if (await log.exists()) {
        debugPrint(await log.readAsString());
      }
      await library.close();
    }
  });
}
