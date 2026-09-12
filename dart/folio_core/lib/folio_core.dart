/// Fan Folio, without a user interface.
///
/// Flutter publishes no Linux arm64 SDK, so this half is the half that can be
/// tested on the machine it is written on. Nothing in here may import Flutter.
library;

export 'src/ao3/client.dart';
export 'src/ao3/forms.dart';
export 'src/ao3/parse.dart';
export 'src/ao3/text.dart';
export 'src/ao3/urls.dart';
export 'src/read/document.dart';
export 'src/search/rank.dart';
export 'src/read/progress.dart';
export 'src/read/reached.dart';
export 'src/read/settings.dart';
export 'src/read/spine.dart';
export 'src/store/facets.dart';
export 'src/sync/pacer.dart';
export 'src/sync/download.dart';
export 'src/sync/plan.dart';
export 'src/sync/run.dart';
export 'src/sync/queue.dart';
export 'src/store/migrate.dart';
export 'src/store/query.dart';
export 'src/store/shelves.dart';
export 'src/store/tidy.dart';
export 'src/store/schema.g.dart';
