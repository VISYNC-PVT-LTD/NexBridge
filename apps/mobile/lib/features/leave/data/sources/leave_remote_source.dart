import 'package:dio/dio.dart';
import '../../../../core/constants/api_endpoints.dart';
import '../../../../core/models/leave.dart';

class LeaveRemoteSource {
  final Dio _dio;
  LeaveRemoteSource(this._dio);

  Future<List<LeaveBalance>> getBalance() async {
    final r = await _dio.get(ApiEndpoints.leaveBalance);
    // Backend returns data as { paidLeave, sickLeave, casualLeave, asOf } — a Map, not a List.
    final data = (r.data as Map<String, dynamic>)['data'] as Map<String, dynamic>;
    const labels = {'paidLeave': 'Paid Leave', 'sickLeave': 'Sick Leave', 'casualLeave': 'Casual Leave'};
    final result = <LeaveBalance>[];
    for (final key in const ['paidLeave', 'sickLeave', 'casualLeave']) {
      final bal = data[key] as Map<String, dynamic>?;
      if (bal == null) continue;
      final currentYear = (bal['currentYear'] as num?)?.toInt() ?? 0;
      final cf = (bal['carriedForward'] as num?)?.toInt() ?? 0;
      final total = (bal['total'] as num?)?.toInt() ?? (currentYear + cf);
      result.add(LeaveBalance(
        leaveType: key,
        leaveTypeName: labels[key] ?? key,
        entitled: total,
        used: 0,
        remaining: total,
        carriedForward: cf,
        cfExpiryDate: bal['carryForwardExpiry'] as String?,
      ));
    }
    return result;
  }

  Future<List<LeaveRequest>> getHistory({String? status, int page = 1, int limit = 20}) async {
    final r = await _dio.get(ApiEndpoints.leaves, queryParameters: {'page': page, 'limit': limit, if (status != null) 'status': status});
    final data = (r.data as Map<String, dynamic>)['data'] as List<dynamic>;
    return data.map((e) => LeaveRequest.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<LeaveRequest> getById(String id) async {
    final r = await _dio.get(ApiEndpoints.leaveById(id));
    return LeaveRequest.fromJson((r.data as Map<String, dynamic>)['data'] as Map<String, dynamic>);
  }

  Future<LeaveRequest> apply({required String leaveType, required String startDate, required String endDate, required String reason}) async {
    final r = await _dio.post(ApiEndpoints.leaves, data: leaveApplyBody(leaveType: leaveType, startDate: startDate, endDate: endDate, reason: reason));
    return LeaveRequest.fromJson((r.data as Map<String, dynamic>)['data'] as Map<String, dynamic>);
  }

  Future<void> cancel(String id) async {
    await _dio.patch(ApiEndpoints.leaveCancel(id));
  }
}

/// Request body for POST /api/v1/leaves (contract: validators/leave.ts ApplyLeaveSchema).
/// The app only offers full-day leave, so `duration` is always 'full'.
/// Regression: the app sent 'PL'/'SL'/'CL'/'LWP' and no `duration`, so every
/// leave application from the phone was rejected with 400.
Map<String, dynamic> leaveApplyBody({required String leaveType, required String startDate, required String endDate, required String reason}) => {
      'leaveType': leaveType,
      'startDate': startDate,
      'endDate': endDate,
      'duration': 'full',
      'reason': reason,
    };

/// The server's own reason (e.g. "Insufficient leave balance.") instead of a generic failure.
String leaveSubmitErrorMessage(Object e) {
  if (e is DioException) {
    final body = e.response?.data;
    if (body is Map<String, dynamic>) {
      final msg = (body['error'] as Map<String, dynamic>?)?['message'] as String?;
      if (msg != null && msg.isNotEmpty) return msg;
    }
    if (e.response == null) return 'No connection. Check your network and try again.';
  }
  return 'Submission failed. Please try again.';
}
