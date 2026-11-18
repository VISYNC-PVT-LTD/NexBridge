// Presentation helpers for attendance. They only describe what the server
// reports; none of them decides a day's status (thresholds and payroll rules
// stay on the server).

/// Human label for a server day status. Matches the shared StatusChip labels so
/// Home and History use the same words for the same day.
String dayStatusLabel(String status) => switch (status.trim().toLowerCase()) {
      'present' => 'Present',
      'absent' => 'Absent',
      'half_day' || 'half-day' => 'Half Day',
      'leave' => 'Leave',
      'lwp' => 'Leave Without Pay',
      'holiday' => 'Holiday',
      'weekend' => 'Weekend',
      'checked-in' => 'Active',
      '' => 'Unknown',
      _ => status,
    };

/// Device-local calendar date (YYYY-MM-DD) of an ISO instant, or null.
String? localDateOf(String? iso) {
  final dt = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (dt == null) return null;
  return '${dt.year.toString().padLeft(4, '0')}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}

/// True when the open session belongs to an earlier attendance day than
/// [todayDate] (the server's company-local "today"). Uses the server's session
/// date when available, otherwise the device-local date of the check-in.
///
/// Regression: a session started yesterday was shown as "Since 15:25" and its
/// hours were counted as today's "Overtime: 14h 58m".
bool sessionStartedBeforeToday({String? sessionDate, String? sessionStartIso, required String todayDate}) {
  final d = (sessionDate != null && sessionDate.isNotEmpty) ? sessionDate : localDateOf(sessionStartIso);
  if (d == null || todayDate.isEmpty) return false;
  return d.compareTo(todayDate) < 0;
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _hhmm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// "15:25" for a time on the current day; "17 Nov, 15:25" when [withDate].
String clockLabel(String iso, {required bool withDate}) {
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return iso;
  return withDate ? '${t.day} ${_months[t.month - 1]}, ${_hhmm(t)}' : _hhmm(t);
}

String _hours(int minutes) => '${minutes ~/ 60}h ${minutes % 60}m';

/// One line for a history row: times, hours and, where relevant, that the
/// check-out was missed and whether the status is still provisional (today).
String historySubtitle({
  String? checkInIso,
  String? checkOutIso,
  int? totalMinutes,
  bool missedCheckout = false,
  bool unresolvedMissedCheckout = false,
  bool isToday = false,
}) {
  final parts = <String>[];
  if (isToday) parts.add('So far');
  if (checkInIso != null) {
    final inLabel = clockLabel(checkInIso, withDate: false);
    final outLabel = checkOutIso != null ? clockLabel(checkOutIso, withDate: false) : null;
    parts.add(outLabel != null ? '$inLabel–$outLabel' : inLabel);
  }
  if (totalMinutes != null && totalMinutes > 0) parts.add(_hours(totalMinutes));
  if (missedCheckout || unresolvedMissedCheckout) {
    parts.add(unresolvedMissedCheckout ? 'Missed check-out (unresolved)' : 'Missed check-out');
  }
  return parts.join(' · ');
}
