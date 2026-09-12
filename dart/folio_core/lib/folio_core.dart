/// Fan Folio, without a user interface.
///
/// Flutter publishes no Linux arm64 SDK, so this half is the half that can be
/// tested on the machine it is written on. Nothing in here may import Flutter.
library;

export 'src/ao3/urls.dart';
export 'src/read/document.dart';
export 'src/read/progress.dart';
export 'src/store/migrate.dart';
export 'src/store/query.dart';
export 'src/store/schema.g.dart';
