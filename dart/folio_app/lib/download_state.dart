import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';

// Only display state crosses the worker boundary. Cookies and HTML never do.
Map<String, Object?> downloadState(Downloads d) => {
  'jobs': [
    for (final j in d.jobs)
      {
        'id': j.id,
        'author': j.author,
        'part': j.part,
        'state': j.state.name,
        'total': j.total,
        'done': j.done,
        'added': j.added,
        'failed': j.failed,
        'open': j.open,
        'unfinished': j.unfinished,
        'rounds': j.rounds,
        'page': j.page,
        'pages': j.pages,
        'parallel': j.parallel,
        'at': j.at?.toIso8601String(),
        'retrying': j.retrying,
        'lastError': j.lastError,
        'say': j.say,
      },
  ],
  'cooling': d.cooling?.toIso8601String(),
  'username': d.signedInAs,
  'problem': d.storageProblem,
};

List<core.JobView> jobsFromState(Map state) => [
  for (final j in state['jobs'] as List)
    core.JobView(
      id: j['id'] as int,
      author: j['author'] as String,
      part: j['part'] as String,
      state: core.JobState.values.byName(j['state'] as String),
      total: j['total'] as int,
      done: j['done'] as int,
      added: j['added'] as int,
      failed: j['failed'] as int,
      open: j['open'] as bool,
      unfinished: j['unfinished'] as int,
      rounds: j['rounds'] as int,
      page: j['page'] as int,
      pages: j['pages'] as int?,
      parallel: j['parallel'] as bool,
      at: j['at'] == null ? null : DateTime.parse(j['at'] as String),
      retrying: j['retrying'] as String?,
      lastError: j['lastError'] as String?,
      say: j['say'] as String?,
    ),
];
