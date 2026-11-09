import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/models/leave.dart';
import 'package:genesis_workforce/features/leave/data/sources/leave_remote_source.dart';

// Regression (found on a real phone against the local API): the app sent
// leaveType 'PL'/'SL'/'CL'/'LWP' without `duration`, every application was
// rejected with 400, and the screen only said "Submission failed".
void main() {
  group('leaveApplyBody', () {
    test('sends the API leave type and a full-day duration', () {
      final body = leaveApplyBody(leaveType: 'casualLeave', startDate: '2026-11-06', endDate: '2026-11-06', reason: 'x');
      expect(body, {
        'leaveType': 'casualLeave',
        'startDate': '2026-11-06',
        'endDate': '2026-11-06',
        'duration': 'full',
        'reason': 'x',
      });
    });
  });

  group('leaveSubmitErrorMessage', () {
    DioException withBody(dynamic data) {
      final req = RequestOptions(path: '/api/v1/leaves');
      return DioException(requestOptions: req, response: Response(requestOptions: req, statusCode: 422, data: data));
    }

    test('shows the server reason', () {
      expect(leaveSubmitErrorMessage(withBody({'success': false, 'error': {'code': 'LVE_001', 'message': 'Insufficient leave balance.'}})),
          'Insufficient leave balance.');
    });

    test('no response at all: a connection message', () {
      expect(leaveSubmitErrorMessage(DioException(requestOptions: RequestOptions(path: '/x'))),
          'No connection. Check your network and try again.');
    });

    test('anything else: the generic message', () {
      expect(leaveSubmitErrorMessage(StateError('boom')), 'Submission failed. Please try again.');
      expect(leaveSubmitErrorMessage(withBody('<html>')), 'Submission failed. Please try again.');
    });
  });

  // Regression: history/detail showed the raw API code ("paidLeave").
  group('leaveTypeLabel', () {
    test('maps every API code to its label', () {
      expect(leaveTypeLabel('paidLeave'), 'Paid Leave');
      expect(leaveTypeLabel('sickLeave'), 'Sick Leave');
      expect(leaveTypeLabel('casualLeave'), 'Casual Leave');
      expect(leaveTypeLabel('lwp'), 'Leave Without Pay');
    });
    test('unknown codes are shown as-is', () => expect(leaveTypeLabel('compOff'), 'compOff'));
  });
}
