import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/constants/api_endpoints.dart';
import 'package:genesis_workforce/core/models/attendance.dart';
import 'package:genesis_workforce/features/attendance/data/sources/attendance_remote_source.dart';
import 'package:genesis_workforce/features/attendance/domain/attendance_display.dart';
import 'package:genesis_workforce/features/attendance/presentation/providers/attendance_provider.dart';

// Regressions found on a phone against a disposable local server (simulated
// 24-hour cutoff):
//  - Home said "Partial Day" while History said "Absent" for the same day.
//  - An open session started yesterday showed "Since 15:25" and
//    "Overtime: 14h 58m" as if it were today's work.
//  - Employee history always showed "Hours: 0.0h" and no times (the app read
//    admin-only fields), and a missed check-out was shown only as "Absent".
//  - History stayed stale ("Active") after the cutoff until an app restart.

/// ISO instant for a local wall-clock time (so tests do not depend on the
/// machine's timezone).
String localIso(int y, int mo, int d, int h, int mi) => DateTime(y, mo, d, h, mi).toUtc().toIso8601String();

void main() {
  group('dayStatusLabel (same words as History)', () {
    test('known statuses', () {
      expect(dayStatusLabel('absent'), 'Absent');
      expect(dayStatusLabel('half-day'), 'Half Day');
      expect(dayStatusLabel('half_day'), 'Half Day');
      expect(dayStatusLabel('present'), 'Present');
      expect(dayStatusLabel('leave'), 'Leave');
      expect(dayStatusLabel('checked-in'), 'Active');
    });
    test('empty and unknown are safe', () {
      expect(dayStatusLabel(''), 'Unknown');
      expect(dayStatusLabel('  '), 'Unknown');
      expect(dayStatusLabel('something_new'), 'something_new');
    });
  });

  group('sessionStartedBeforeToday', () {
    test('server session date wins', () {
      expect(sessionStartedBeforeToday(sessionDate: '2026-11-17', todayDate: '2026-11-18'), isTrue);
      expect(sessionStartedBeforeToday(sessionDate: '2026-11-18', todayDate: '2026-11-18'), isFalse);
      // Even if the device-local date of the instant says otherwise.
      expect(
        sessionStartedBeforeToday(sessionDate: '2026-11-18', sessionStartIso: localIso(2026, 11, 17, 23, 0), todayDate: '2026-11-18'),
        isFalse,
      );
    });
    test('falls back to the device-local check-in date for older servers', () {
      expect(sessionStartedBeforeToday(sessionStartIso: localIso(2026, 11, 17, 15, 25), todayDate: '2026-11-18'), isTrue);
      expect(sessionStartedBeforeToday(sessionStartIso: localIso(2026, 11, 18, 9, 0), todayDate: '2026-11-18'), isFalse);
    });
    test('missing data → not earlier (no special display)', () {
      expect(sessionStartedBeforeToday(todayDate: '2026-11-18'), isFalse);
      expect(sessionStartedBeforeToday(sessionDate: '2026-11-17', todayDate: ''), isFalse);
      expect(sessionStartedBeforeToday(sessionStartIso: 'garbage', todayDate: '2026-11-18'), isFalse);
    });
  });

  test('clockLabel: time only today, date + time for an earlier day', () {
    final iso = localIso(2026, 11, 17, 15, 25);
    expect(clockLabel(iso, withDate: false), '15:25');
    expect(clockLabel(iso, withDate: true), '17 Nov, 15:25');
    expect(clockLabel('not-a-date', withDate: true), 'not-a-date');
  });

  group('historySubtitle', () {
    test('active day: start time only, marked provisional', () {
      expect(historySubtitle(checkInIso: localIso(2026, 11, 18, 9, 5), isToday: true), 'So far · 09:05');
    });
    test('short completed session: times and exact minutes', () {
      expect(
        historySubtitle(checkInIso: localIso(2026, 11, 18, 14, 55), checkOutIso: localIso(2026, 11, 18, 14, 56), totalMinutes: 1),
        '14:55–14:56 · 0h 1m',
      );
    });
    test('missed check-out: no invented check-out time, clearly labelled', () {
      expect(
        historySubtitle(checkInIso: localIso(2026, 11, 17, 15, 25), missedCheckout: true, unresolvedMissedCheckout: true),
        '15:25 · Missed check-out (unresolved)',
      );
      expect(historySubtitle(checkInIso: localIso(2026, 11, 16, 10, 32), missedCheckout: true), '10:32 · Missed check-out');
    });
    test('nothing recorded → empty', () {
      expect(historySubtitle(), '');
    });
  });

  group('AttendanceRecord.fromJson — employee history shape', () {
    // Exact shape of GET /api/v1/attendance/history (AttendanceService.getHistory).
    Map<String, dynamic> day({required String status, int total = 0, bool unresolved = false, List<Map<String, dynamic>> sessions = const []}) => {
          'dateString': '2026-11-17',
          'dayOfWeek': 'Tuesday',
          'status': status,
          'totalMinutes': total,
          'overtimeMinutes': 0,
          'isRegularized': false,
          'hasUnresolvedMissedCheckout': unresolved,
          'sessions': sessions,
        };

    test('hours and times come from totalMinutes and sessions (regression: always 0.0h)', () {
      final r = AttendanceRecord.fromJson(day(status: 'absent', total: 94, sessions: [
        {'checkInTimestamp': '2026-11-17T12:56:04.000Z', 'checkOutTimestamp': '2026-11-17T14:30:00.000Z', 'durationMinutes': 94, 'missedCheckout': false},
      ]));
      expect(r.date, '2026-11-17');
      expect(r.totalMinutes, 94);
      expect(r.workHours, 1.6);
      expect(r.checkIn, '2026-11-17T12:56:04.000Z');
      expect(r.checkOut, '2026-11-17T14:30:00.000Z');
      expect(r.missedCheckout, isFalse);
    });

    test('missed check-out day: flags parsed, no check-out invented', () {
      final r = AttendanceRecord.fromJson(day(status: 'absent', unresolved: true, sessions: [
        {'checkInTimestamp': '2026-11-17T09:55:32.000Z', 'checkOutTimestamp': null, 'durationMinutes': 0, 'missedCheckout': true},
      ]));
      expect(r.missedCheckout, isTrue);
      expect(r.hasUnresolvedMissedCheckout, isTrue);
      expect(r.checkOut, isNull);
      expect(r.workHours, isNull);
      expect(r.totalMinutes, 0);
    });

    test('admin list shape still parses (workHours given)', () {
      final r = AttendanceRecord.fromJson({'_id': 'a1', 'date': '2026-06-20', 'status': 'present', 'workHours': 8.5, 'isRegularized': false, 'sessions': []});
      expect(r.workHours, 8.5);
      expect(r.totalMinutes, 510);
    });
  });

  group('attendanceHistoryKey (history refetch trigger)', () {
    TodayAttendance t({bool checkedIn = false, String status = 'absent', List<String> missed = const [], int minutes = 0}) => TodayAttendance(
          date: '2026-11-18',
          status: status,
          isCheckedIn: checkedIn,
          unresolvedMissedCheckoutDates: missed,
          sessions: const [],
          totalMinutesToday: minutes,
        );

    test('changes at the cutoff and when a missed day is resolved', () {
      final before = attendanceHistoryKey(t(checkedIn: true, status: 'checked-in'));
      final afterCutoff = attendanceHistoryKey(t(missed: ['2026-11-17']));
      final resolved = attendanceHistoryKey(t());
      expect(afterCutoff, isNot(before));
      expect(resolved, isNot(afterCutoff));
    });
    test('stable when nothing changed (no needless refetch)', () {
      expect(attendanceHistoryKey(t(minutes: 5)), attendanceHistoryKey(t(minutes: 5)));
    });
  });

  test('status mapping keeps the open session date from the server', () async {
    final dio = Dio(BaseOptions(baseUrl: 'http://fixture.invalid'));
    dio.interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
      if (o.path != ApiEndpoints.attendanceStatus) return h.reject(DioException(requestOptions: o, message: 'unexpected ${o.path}'));
      h.resolve(Response(requestOptions: o, statusCode: 200, data: {
        'success': true,
        'data': {
          'isCheckedIn': true,
          'forgotCheckout': false,
          'unresolvedMissedCheckoutDates': <String>[],
          'todayDateString': '2026-11-18',
          'currentSession': {
            'sessionId': 's1',
            'checkInTimestamp': '2026-11-17T09:55:32.000Z',
            'dateString': '2026-11-17',
            'checkoutDeadline': '2026-11-18T09:55:32.000Z',
          },
          'staleSession': null,
          'todaySummary': {'totalMinutes': 1, 'status': 'checked-in', 'sessions': <Map<String, dynamic>>[]},
        },
      }));
    }));
    final today = await AttendanceRemoteSource(dio).getToday();
    expect(today.date, '2026-11-18');
    expect(today.currentSessionDate, '2026-11-17');
    expect(sessionStartedBeforeToday(sessionDate: today.currentSessionDate, sessionStartIso: today.currentSessionStart, todayDate: today.date), isTrue);
  });
}
