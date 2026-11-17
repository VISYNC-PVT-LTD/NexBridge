import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/constants/api_endpoints.dart';
import 'package:genesis_workforce/features/leave/data/sources/leave_remote_source.dart';
import 'package:genesis_workforce/features/leave/presentation/providers/leave_provider.dart';
import 'package:genesis_workforce/features/leave/presentation/screens/leave_balance_screen.dart';

// Regression (found on a phone against a real test database): a pro-rated
// sick-leave balance of 1.5 days showed as "1" (`.toInt()`), the card showed
// an invented "Entitled"/"Used 0" pair, and revoked/withdrawn leave appeared as
// unstyled grey text. Fixtures use the exact API response shapes, and the
// screen is driven through the real LeaveRemoteSource parsing.

const _balanceResponse = {
  'success': true,
  'data': {
    'paidLeave': {'currentYear': 2, 'carriedForward': 0, 'carryForwardExpiry': null, 'total': 2},
    'sickLeave': {'currentYear': 1.5, 'carriedForward': 0, 'carryForwardExpiry': null, 'total': 1.5},
    'casualLeave': {'currentYear': 0.5, 'carriedForward': 1, 'carryForwardExpiry': '2027-03-31', 'total': 1.5},
    'asOf': '2026-11-17T10:00:00.000Z',
  },
};

Map<String, dynamic> _leave(String id, num totalDays, String status) => {
      'id': id,
      'employeeId': 'e1',
      'leaveType': 'paidLeave',
      'startDate': '2026-11-24',
      'endDate': '2026-11-24',
      'totalDays': totalDays,
      'reason': 'Test',
      'status': status,
      'createdAt': '2026-11-17T10:00:00.000Z',
    };

final _historyResponse = {
  'success': true,
  'data': [
    _leave('a', 0.5, 'revoked'),
    _leave('b', 1, 'withdrawn'),
    _leave('c', 1.5, 'approved'),
    _leave('d', 3, ''),
  ],
};

LeaveRemoteSource _source() {
  final dio = Dio(BaseOptions(baseUrl: 'http://fixture.invalid'));
  dio.interceptors.add(InterceptorsWrapper(onRequest: (o, h) {
    final body = o.path == ApiEndpoints.leaveBalance ? _balanceResponse : (o.path == ApiEndpoints.leaves ? _historyResponse : null);
    if (body == null) return h.reject(DioException(requestOptions: o, message: 'unexpected ${o.path}'));
    h.resolve(Response(requestOptions: o, statusCode: 200, data: body));
  }));
  return LeaveRemoteSource(dio);
}

Future<void> _pump(WidgetTester tester) async {
  await tester.pumpWidget(ProviderScope(
    overrides: [leaveSourceProvider.overrideWithValue(_source())],
    child: const MaterialApp(home: LeaveScreen()),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('balance tab shows fractional and whole values exactly, and only API figures', (tester) async {
    await _pump(tester);

    expect(find.text('Sick Leave'), findsOneWidget);
    expect(find.text('1.5'), findsNWidgets(3)); // sick: this year + available; casual: available
    expect(find.text('0.5'), findsOneWidget); // casual this year
    expect(find.text('2'), findsNWidgets(2)); // paid: this year + available (no "2.0")
    expect(find.text('2.0'), findsNothing);
    expect(find.text('This Year'), findsNWidgets(3));
    expect(find.text('Carry Fwd'), findsNWidgets(3));
    expect(find.text('Available'), findsNWidgets(3));
    // Values the API does not provide are not shown.
    expect(find.text('Entitled'), findsNothing);
    expect(find.text('Used'), findsNothing);
  });

  testWidgets('history tab: fractional durations and shared status chips', (tester) async {
    await _pump(tester);
    await tester.tap(find.text('History'));
    await tester.pumpAndSettle();

    expect(find.textContaining('· 0.5 days'), findsOneWidget);
    expect(find.textContaining('· 1 day'), findsOneWidget);
    expect(find.textContaining('· 1.5 days'), findsOneWidget);
    expect(find.textContaining('· 3 days'), findsOneWidget);

    expect(find.text('Revoked'), findsOneWidget);
    expect(find.text('Withdrawn'), findsOneWidget);
    expect(find.text('Approved'), findsOneWidget);
    expect(find.text('Unknown'), findsOneWidget); // empty status no longer crashes the row
    expect(tester.widget<Text>(find.text('Revoked')).style!.color, const Color(0xFFC2410C));
    expect(tester.widget<Text>(find.text('Withdrawn')).style!.color, const Color(0xFF4B5563));
  });
}
