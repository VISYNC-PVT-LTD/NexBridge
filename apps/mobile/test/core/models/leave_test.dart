import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/models/leave.dart';

void main() {
  // Shape of one entry of GET /api/v1/leaves/balance (LeaveService.getBalance).
  // The old test used an entitled/used/remaining shape the API never sends.
  group('LeaveBalance.fromApi', () {
    test('keeps fractional values (regression: 1.5 was truncated to 1)', () {
      final b = LeaveBalance.fromApi('sickLeave', 'Sick Leave',
          {'currentYear': 1.5, 'carriedForward': 0.5, 'carryForwardExpiry': '2027-03-31', 'total': 2.0});
      expect(b.leaveType, 'sickLeave');
      expect(b.leaveTypeName, 'Sick Leave');
      expect(b.currentYear, 1.5);
      expect(b.carriedForward, 0.5);
      expect(b.available, 2.0);
      expect(b.cfExpiryDate, '2027-03-31');
    });

    test('whole values arrive as JSON ints and stay exact', () {
      final b = LeaveBalance.fromApi('paidLeave', 'Paid Leave',
          {'currentYear': 12, 'carriedForward': 3, 'carryForwardExpiry': null, 'total': 15});
      expect(b.currentYear, 12);
      expect(b.carriedForward, 3);
      expect(b.available, 15);
      expect(b.cfExpiryDate, isNull);
    });

    test('available is the API total, not recomputed, when present', () {
      // The API zeroes an expired carry-forward itself; trust its total.
      final b = LeaveBalance.fromApi('paidLeave', 'Paid Leave', {'currentYear': 4, 'carriedForward': 0, 'total': 4});
      expect(b.available, 4);
    });

    test('missing total falls back to currentYear + carriedForward; missing fields are 0', () {
      expect(LeaveBalance.fromApi('x', 'X', {'currentYear': 0.5, 'carriedForward': 1}).available, 1.5);
      final empty = LeaveBalance.fromApi('x', 'X', {});
      expect([empty.currentYear, empty.carriedForward, empty.available], [0, 0, 0]);
    });

    test('numeric strings are parsed, garbage is treated as missing', () {
      final b = LeaveBalance.fromApi('x', 'X', {'currentYear': '2.5', 'carriedForward': 'n/a', 'total': null});
      expect(b.currentYear, 2.5);
      expect(b.carriedForward, 0);
      expect(b.available, 2.5);
    });
  });

  group('formatLeaveDays / leaveDurationLabel', () {
    test('whole days have no decimal', () {
      expect(formatLeaveDays(0), '0');
      expect(formatLeaveDays(1), '1');
      expect(formatLeaveDays(12.0), '12');
    });
    test('fractions are shown as they are', () {
      expect(formatLeaveDays(0.5), '0.5');
      expect(formatLeaveDays(1.5), '1.5');
      expect(formatLeaveDays(2.25), '2.25');
    });
    test('floating-point noise is rounded away', () {
      expect(formatLeaveDays(1.4999999999), '1.5');
      expect(formatLeaveDays(0.1 + 0.2), '0.3');
      expect(formatLeaveDays(2.0000001), '2');
    });
    test('duration labels', () {
      expect(leaveDurationLabel(1), '1 day');
      expect(leaveDurationLabel(0.5), '0.5 days');
      expect(leaveDurationLabel(1.5), '1.5 days');
      expect(leaveDurationLabel(3), '3 days');
      expect(leaveDurationLabel(null), '—');
    });
  });

  group('LeaveRequest.isCancellable', () {
    LeaveRequest make(String status) => LeaveRequest(
          id: 'l1',
          employeeId: 'e1',
          leaveType: 'casual',
          startDate: '2026-06-20',
          endDate: '2026-06-20',
          days: 1,
          reason: 'Personal',
          status: status,
          createdAt: '2026-06-18T00:00:00Z',
        );

    test('pending is cancellable', () => expect(make('pending').isCancellable, isTrue));
    test('approved not cancellable', () => expect(make('approved').isCancellable, isFalse));
    test('rejected not cancellable', () => expect(make('rejected').isCancellable, isFalse));
    test('cancelled not cancellable', () => expect(make('cancelled').isCancellable, isFalse));
  });

  group('LeaveRequest.fromJson', () {
    final json = {
      '_id': 'l1',
      'employeeId': 'e1',
      'leaveType': 'casual',
      'startDate': '2026-06-20',
      'endDate': '2026-06-20',
      'days': 1,
      'reason': 'Personal',
      'status': 'pending',
      'createdAt': '2026-06-18T00:00:00Z',
    };

    test('parses correctly', () {
      final r = LeaveRequest.fromJson(json);
      expect(r.id, 'l1');
      expect(r.status, 'pending');
      expect(r.isCancellable, isTrue);
    });

    test('handles nested employeeId', () {
      final j = {...json, 'employeeId': {'_id': 'e99'}};
      expect(LeaveRequest.fromJson(j).employeeId, 'e99');
    });

    test('half-day totalDays 0.5 parses (regression: `as int?` threw)', () {
      final r = LeaveRequest.fromJson({...json, 'days': null, 'totalDays': 0.5});
      expect(r.days, 0.5);
    });

    test('totalDays is preferred over legacy days; whole and fractional', () {
      expect(LeaveRequest.fromJson({...json, 'totalDays': 3}).days, 3);
      expect(LeaveRequest.fromJson({...json, 'totalDays': 1.5}).days, 1.5);
      expect(LeaveRequest.fromJson(json).days, 1); // legacy 'days'
    });

    test('a missing duration stays unknown instead of being invented as 1', () {
      final j = Map<String, dynamic>.from(json)..remove('days');
      expect(LeaveRequest.fromJson(j).days, isNull);
    });
  });
}
