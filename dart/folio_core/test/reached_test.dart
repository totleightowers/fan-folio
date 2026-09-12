import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// Every case here is one a phone reported and no test could.
///
/// The same cases as test/reading.test.mjs, because the two versions must
/// agree about when a work has been read — a work finished by being opened
/// leaves the Continue reading shelf unread, and the reader finds out by
/// looking for it.
bool end({
  double scrollHeight = 12000,
  double scrollY = 0,
  double openedAt = 0,
  double innerHeight = 780,
}) =>
    reachedTheEnd(
      scrollY: scrollY,
      innerHeight: innerHeight,
      scrollHeight: scrollHeight,
      openedAt: openedAt,
    );

void main() {
  test('a chapter with nothing to scroll is not a chapter read to its end', () {
    expect(end(scrollHeight: 800), isFalse);
    expect(end(scrollHeight: 780), isFalse);
  });

  test('a layout that has not settled yet says nothing about reading', () {
    // before the text is laid out, scrollHeight is the empty page — which is
    // exactly the state at the frame after a chapter is written in
    expect(end(scrollHeight: 780), isFalse);
  });

  test('being put back where you left off is not reading to the end', () {
    const double room = 12000 - 780;
    expect(end(scrollY: room, openedAt: room), isFalse);
    expect(end(scrollY: room, openedAt: room - 30), isFalse,
        reason: 'a few pixels of settling is still not somebody reading');
  });

  test('reading to the foot of a long chapter is reading to its end', () {
    const double room = 12000 - 780;
    expect(end(scrollY: room), isTrue);
    expect(end(scrollY: room - 60), isTrue, reason: 'nobody scrolls the last pixel');
  });

  test('finishing the last stretch of a chapter reopened near its end counts', () {
    const double room = 12000 - 780;
    expect(end(scrollY: room, openedAt: room - 900), isTrue);
  });

  test('the middle of a chapter is not the end of it', () {
    expect(end(scrollY: 4000), isFalse);
  });

  test('numbers that are not numbers decide nothing', () {
    expect(reachedTheEnd(), isFalse);
    expect(end(scrollHeight: double.nan, scrollY: double.nan), isFalse);
    expect(end(scrollHeight: double.infinity, scrollY: 500), isFalse);
  });
}
