import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/models/attendance.dart';
import 'package:genesis_workforce/core/models/notification.dart';
import 'package:genesis_workforce/features/attendance/data/sources/attendance_remote_source.dart';
import 'package:genesis_workforce/features/attendance/presentation/providers/attendance_provider.dart';

// Automated simulation (controlled clock, fake server responses) of the
// 24-hour cutoff when the first refresh after the deadline does not show the
// server's final state: the phone is offline, or the server's clock is a few
// seconds behind and still reports the session open.
//
// Regression: the app re-synced exactly once at the deadline, then waited for
// the 5-minute sync / resume / manual retry.

const _checkIn = '2026-11-17T09:55:32.000Z';
const _deadline = '2026-11-18T09:55:32.000Z';
final _afterDeadline = DateTime.parse('2026-11-18T09:55:40.000Z');

/// Server says: session still open (its clock is behind the phone's).
const _stillOpen = TodayAttendance(
  date: '2026-11-18',
  status: 'checked-in',
  isCheckedIn: true,
  currentSessionStart: _checkIn,
  currentSessionDate: '2026-11-17',
  currentSessionDeadline: _deadline,
  sessions: [],
  totalMinutesToday: 0,
);

/// Server says: missed check-out recorded. No check-out exists for it.
const _missed = TodayAttendance(
  date: '2026-11-18',
  status: 'absent',
  isCheckedIn: false,
  forgotCheckout: true,
  unresolvedMissedCheckoutDates: ['2026-11-17'],
  sessions: [],
  totalMinutesToday: 0,
);

/// A new session started after the old one expired (deadline in the future).
const _newSession = TodayAttendance(
  date: '2026-11-18',
  status: 'checked-in',
  isCheckedIn: true,
  currentSessionStart: '2026-11-18T09:56:00.000Z',
  currentSessionDate: '2026-11-18',
  currentSessionDeadline: '2026-11-19T09:56:00.000Z',
  sessions: [],
  totalMinutesToday: 0,
);

class _ScriptedSource extends AttendanceRemoteSource {
  _ScriptedSource(this.script) : super(Dio());
  final List<Object> script; // TodayAttendance or an Exception to throw
  int calls = 0;

  @override
  Future<TodayAttendance> getToday() async {
    final next = script[calls < script.length ? calls : script.length - 1];
    calls++;
    if (next is Exception) throw next;
    return next as TodayAttendance;
  }
}

const _delays = [Duration(milliseconds: 20), Duration(milliseconds: 20), Duration(milliseconds: 20)];

(ProviderContainer, _ScriptedSource) _setup(List<Object> script) {
  final source = _ScriptedSource(script);
  final c = ProviderContainer(overrides: [
    attendanceProvider.overrideWith((ref) => AttendanceNotifier(
          source,
          CompanySettings.defaults,
          ref,
          clock: () => _afterDeadline,
          deadlineRetryDelays: _delays,
        )),
  ]);
  addTearDown(c.dispose);
  return (c, source);
}

Future<void> _settle() => Future<void>.delayed(const Duration(milliseconds: 200));

void main() {
  test('offline at the cutoff: error first, then the server state on the next re-check', () async {
    final (c, src) = _setup([DioException(requestOptions: RequestOptions(path: '/x')), _missed]);
    await c.read(attendanceProvider.notifier).reconcileAfterDeadline();
    expect(c.read(attendanceProvider).hasError, isTrue);

    await _settle();
    final t = c.read(attendanceProvider).value!;
    expect(src.calls, 2);
    expect(t.isCheckedIn, isFalse);
    expect(t.missedCheckoutDates, ['2026-11-17']);
    expect(c.read(checkInStateProvider), CheckInState.idle);
    // Nothing invented: no session time, no check-out.
    expect(t.totalMinutesToday, 0);
    expect(t.sessions.where((s) => s.checkOut != null), isEmpty);
  });

  test('server clock behind: "still open" after the deadline is re-checked, not shown as checked in', () async {
    final (c, src) = _setup([_stillOpen, _missed]);
    await c.read(attendanceProvider.notifier).reconcileAfterDeadline();
    expect(c.read(checkInStateProvider), CheckInState.checkedIn); // server said so — for now

    await _settle();
    expect(src.calls, 2);
    expect(c.read(attendanceProvider).value!.isCheckedIn, isFalse);
    expect(c.read(checkInStateProvider), CheckInState.idle);
  });

  test('re-checks are bounded when the server stays unreachable', () async {
    final (c, src) = _setup([DioException(requestOptions: RequestOptions(path: '/x'))]);
    await c.read(attendanceProvider.notifier).reconcileAfterDeadline();
    await _settle();
    await _settle();
    expect(src.calls, 1 + _delays.length);
    expect(c.read(attendanceProvider).hasError, isTrue); // honest error, no invented state
  });

  test('no extra calls when the first refresh already shows the missed check-out', () async {
    final (c, src) = _setup([_missed]);
    await c.read(attendanceProvider.notifier).reconcileAfterDeadline();
    await _settle();
    expect(src.calls, 1);
  });

  test('no re-checks for a new session whose deadline is still ahead', () async {
    final (c, src) = _setup([_newSession]);
    await c.read(attendanceProvider.notifier).reconcileAfterDeadline();
    await _settle();
    expect(src.calls, 1);
    expect(c.read(checkInStateProvider), CheckInState.checkedIn);
  });

  test('app resume / reopen after the cutoff: one refresh shows the server state', () async {
    // HomeScreen calls reconcile() on start and on AppLifecycleState.resumed.
    final (c, src) = _setup([_missed]);
    await c.read(attendanceProvider.notifier).reconcile();
    expect(src.calls, 1);
    expect(c.read(attendanceProvider).value!.missedCheckoutDates, ['2026-11-17']);
    expect(c.read(checkInStateProvider), CheckInState.idle);
  });
}
