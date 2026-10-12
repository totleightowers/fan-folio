/// How often this app is allowed to ask the archive for anything.
///
/// Everything goes through here so there is one place that decides. That
/// matters more than anything else being ported: an app that walks somebody's
/// bookmarks impatiently gets their account limited, and they will not know
/// why.
///
/// 1.x learned this twice. Once when four separate loops each waited their own
/// half minute — so four things running together made a request every seven
/// seconds while every one of them believed it was making one every
/// twenty-eight — and again when a bookmark sync added its own wait on top of
/// the shared one. One clock, and everything waits on it.
library;

import 'dart:async';
import 'dart:math' as math;

/// Roughly two a minute, spread out. What the walker settled on.
const Duration minGap = Duration(milliseconds: 28000);

/// Gaps drawn from an exponential distribution rather than a fixed wait.
///
/// A request exactly every 28 seconds is a metronome, and a metronome is the
/// easiest thing in the world to notice. The mean is what matters; the spacing
/// should not be predictable.
Duration nextGap({Duration gap = minGap, math.Random? random}) {
  final r = random ?? math.Random();
  final spread = -math.log(1 - r.nextDouble()) * gap.inMilliseconds;
  final ms = spread.clamp(gap.inMilliseconds * 0.45, gap.inMilliseconds * 2.5);
  return Duration(milliseconds: ms.round());
}

/// One queue of turns, one memory of when the last request went, and a
/// cool-off that everything honours when the archive says to slow down.
///
/// A single request from a work page was never throttled in 1.x because it is
/// a single request — and the archive sees the total, not the intent. So there
/// is no such thing here as a request that skips the queue.
class Pacer {
  Pacer({
    Duration gap = minGap,
    math.Random? random,
    Future<void> Function(Duration)? sleep,
    DateTime Function()? now,
    this.checkpoint,
  })  : _gap = gap,
        _random = random ?? math.Random(),
        _sleep = sleep ?? ((d) => Future<void>.delayed(d)),
        _now = now ?? DateTime.now;

  /// Persist pacing before another request may leave the process.
  final Future<void> Function()? checkpoint;

  Map<String, Object?> save() => {
        'lastAt': _lastAt?.millisecondsSinceEpoch,
        'coolUntil': _coolUntil?.millisecondsSinceEpoch,
      };

  void restore(Map<String, Object?> saved) {
    DateTime? stamp(String key) => saved[key] is num
        ? DateTime.fromMillisecondsSinceEpoch((saved[key] as num).toInt())
        : null;
    _lastAt = stamp('lastAt');
    _coolUntil = stamp('coolUntil');
  }

  final Duration _gap;
  final math.Random _random;
  final Future<void> Function(Duration) _sleep;
  final DateTime Function() _now;

  final List<_Turn<dynamic>> _turns = [];
  bool _draining = false;
  DateTime? _lastAt;
  DateTime? _coolUntil;

  /// The archive asked for room. Everything waits, not only whoever was told.
  void slowDown([Duration how = const Duration(minutes: 5)]) {
    final until = _now().add(how);
    if (_coolUntil == null || until.isAfter(_coolUntil!)) _coolUntil = until;
  }

  /// Whether a cool-off is in force, and until when.
  DateTime? get coolingUntil =>
      _coolUntil != null && _coolUntil!.isAfter(_now()) ? _coolUntil : null;

  /// Foreground actions get the next available turn, but still obey the same
  /// spacing and cooldown as background downloads. Never interrupt a request.
  Future<T> run<T>(Future<T> Function() task, {bool priority = false}) {
    final turn = _Turn<T>(task, priority);
    _turns.add(turn);
    if (!_draining) {
      _draining = true;
      unawaited(_drain());
    }
    return turn.done.future;
  }

  Future<void> _drain() async {
    // Let callers attach error handlers before a synchronous checkpoint fails.
    await Future<void>.value();
    while (_turns.isNotEmpty) {
      Object? waitingError;
      StackTrace? waitingStack;
      try {
        final due = _now().add(_owed());
        for (;;) {
          final until = _coolUntil != null && _coolUntil!.isAfter(due)
              ? _coolUntil!
              : due;
          final owed = until.difference(_now());
          if (owed <= Duration.zero) break;
          await _sleep(owed);
        }
      } catch (error, stack) {
        waitingError = error;
        waitingStack = stack;
      }
      // Choose after the wait: a newly opened work must be able to overtake
      // a background job that was already waiting for the pacing clock.
      final urgent = _turns.indexWhere((turn) => turn.priority);
      final turn = _turns.removeAt(urgent < 0 ? 0 : urgent);
      try {
        if (waitingError != null)
          Error.throwWithStackTrace(waitingError, waitingStack!);
        dynamic result;
        try {
          _lastAt = _now();
          await checkpoint?.call();
          result = await turn.task();
        } finally {
          // Persist a cooldown before releasing the next caller.
          await checkpoint?.call();
        }
        turn.done.complete(result);
      } catch (error, stack) {
        turn.done.completeError(error, stack);
      }
    }
    _draining = false;
  }

  Duration _owed() {
    final now = _now();
    final sinceLast =
        _lastAt == null ? const Duration(days: 1) : now.difference(_lastAt!);
    final forGap = nextGap(gap: _gap, random: _random) - sinceLast;
    final forCool =
        _coolUntil == null ? Duration.zero : _coolUntil!.difference(now);
    final owed = forGap > forCool ? forGap : forCool;
    return owed > Duration.zero ? owed : Duration.zero;
  }
}

class _Turn<T> {
  _Turn(this.task, this.priority);
  final Future<T> Function() task;
  final bool priority;
  final Completer<T> done = Completer<T>();
}
