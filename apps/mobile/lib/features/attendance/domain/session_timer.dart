// Session timer rules for the 24-hour missed check-out policy (docs/85).
//
// Pure functions (no Flutter, no clock) so the exact boundary can be tested
// with a controlled `now`.

/// True when the server-provided check-out deadline (checkIn + 24 h) has been
/// reached. Boundary inclusive: at the deadline the window is over.
bool missedCheckoutDeadlinePassed(String? deadlineIso, DateTime now) {
  if (deadlineIso == null) return false;
  final deadline = DateTime.tryParse(deadlineIso);
  if (deadline == null) return false;
  return !now.toUtc().isBefore(deadline.toUtc());
}

/// Elapsed time shown on the session timer.
///  * not checked in → 00:00:00
///  * at/after the 24-hour deadline → 00:00:00 (never 24:00:00 or more)
///  * otherwise now − check-in (never negative)
Duration sessionTimerElapsed({
  required String? sessionStart,
  required String? deadline,
  required bool isActive,
  required DateTime now,
}) {
  if (!isActive || sessionStart == null) return Duration.zero;
  final start = DateTime.tryParse(sessionStart);
  if (start == null) return Duration.zero;
  if (missedCheckoutDeadlinePassed(deadline, now)) return Duration.zero;
  final d = now.toUtc().difference(start.toUtc());
  if (d.isNegative) return Duration.zero;
  // Defensive cap if the server omitted the deadline.
  if (d >= const Duration(hours: 24)) return Duration.zero;
  return d;
}

String formatSessionTimer(Duration d) {
  final h = d.inHours.toString().padLeft(2, '0');
  final m = (d.inMinutes % 60).toString().padLeft(2, '0');
  final s = (d.inSeconds % 60).toString().padLeft(2, '0');
  return '$h : $m : $s';
}
