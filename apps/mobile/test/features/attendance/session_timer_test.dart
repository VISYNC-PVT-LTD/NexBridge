import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/models/attendance.dart';
import 'package:genesis_workforce/features/attendance/domain/session_timer.dart';

void main() {
  // Controlled clock: check-in at 09:00:00Z, deadline 24 h later.
  final checkIn = DateTime.utc(2026, 3, 2, 9);
  final start = checkIn.toIso8601String();
  final deadline = checkIn.add(const Duration(hours: 24)).toIso8601String();

  group('24-hour missed check-out — timer boundary', () {
    test('1 second before the deadline the timer shows 23:59:59', () {
      final now = checkIn.add(const Duration(hours: 24)).subtract(const Duration(seconds: 1));
      final d = sessionTimerElapsed(sessionStart: start, deadline: deadline, isActive: true, now: now);
      expect(formatSessionTimer(d), '23 : 59 : 59');
      expect(missedCheckoutDeadlinePassed(deadline, now), isFalse);
    });

    test('exactly at the deadline the timer resets to 00:00:00', () {
      final now = checkIn.add(const Duration(hours: 24));
      final d = sessionTimerElapsed(sessionStart: start, deadline: deadline, isActive: true, now: now);
      expect(formatSessionTimer(d), '00 : 00 : 00');
      expect(missedCheckoutDeadlinePassed(deadline, now), isTrue);
    });

    test('after the deadline (e.g. app reopened days later) it stays 00:00:00', () {
      final now = checkIn.add(const Duration(days: 3, hours: 5));
      final d = sessionTimerElapsed(sessionStart: start, deadline: deadline, isActive: true, now: now);
      expect(d, Duration.zero);
    });

    test('defensive: without a server deadline it still never shows 24 h or more', () {
      final now = checkIn.add(const Duration(hours: 30));
      expect(sessionTimerElapsed(sessionStart: start, deadline: null, isActive: true, now: now), Duration.zero);
    });

    test('not checked in → 00:00:00', () {
      expect(sessionTimerElapsed(sessionStart: start, deadline: deadline, isActive: false, now: checkIn.add(const Duration(hours: 2))), Duration.zero);
    });

    test('device clock behind check-in never shows a negative time', () {
      expect(sessionTimerElapsed(sessionStart: start, deadline: deadline, isActive: true, now: checkIn.subtract(const Duration(minutes: 5))), Duration.zero);
    });

    test('normal running session', () {
      final d = sessionTimerElapsed(sessionStart: start, deadline: deadline, isActive: true, now: checkIn.add(const Duration(hours: 2, minutes: 3, seconds: 4)));
      expect(formatSessionTimer(d), '02 : 03 : 04');
    });
  });

  group('missed check-out data from the server', () {
    test('a missed session has no check-out and is flagged', () {
      final s = AttendanceSession.fromJson({
        'checkInTimestamp': start, 'checkOutTimestamp': null, 'durationMinutes': 0,
        'closedBySystem': true, 'missedCheckout': true,
      });
      expect(s.checkOut, isNull);
      expect(s.missedCheckout, isTrue);
      expect(s.durationMinutes, 0);
    });

    test('today parses the check-out deadline', () {
      final t = TodayAttendance.fromJson({
        'date': '2026-03-02', 'status': 'checked-in', 'isCheckedIn': true,
        'currentSessionStart': start, 'currentSessionDeadline': deadline,
        'sessions': <dynamic>[], 'totalMinutesToday': 0,
      });
      expect(t.currentSessionDeadline, deadline);
    });

    test('stale session tolerates a missing check-in timestamp', () {
      final t = TodayAttendance.fromJson({
        'date': '2026-03-03', 'status': 'absent', 'isCheckedIn': false, 'forgotCheckout': true,
        'staleSession': {'dateString': '2026-03-02', 'checkInTimestamp': null},
        'sessions': <dynamic>[], 'totalMinutesToday': 0,
      });
      expect(t.forgotCheckout, isTrue);
      expect(t.staleSession!.dateString, '2026-03-02');
    });
  });
}
