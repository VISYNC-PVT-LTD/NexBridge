import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';
import '../../../../core/constants/api_endpoints.dart';
import '../../../../core/models/attendance.dart';

class AttendanceRemoteSource {
  final Dio _dio;
  AttendanceRemoteSource(this._dio);

  Future<TodayAttendance> getToday() async {
    // /attendance/today is admin-only. /attendance/status is employee-safe.
    final r = await _dio.get(ApiEndpoints.attendanceStatus);
    final raw = (r.data as Map<String, dynamic>)['data'] as Map<String, dynamic>;
    final summary = raw['todaySummary'] as Map<String, dynamic>? ?? {};
    final currentSession = raw['currentSession'] as Map<String, dynamic>?;
    final rawSessions = summary['sessions'] as List<dynamic>? ?? [];
    return TodayAttendance.fromJson({
      'date': raw['todayDateString'] ?? '',
      'status': summary['status'] ?? 'absent',
      'isCheckedIn': raw['isCheckedIn'] ?? false,
      'forgotCheckout': raw['forgotCheckout'] ?? false,
      'staleSession': raw['staleSession'],
      'currentSessionStart': currentSession?['checkInTimestamp'],
      'currentSessionDeadline': currentSession?['checkoutDeadline'],
      'sessions': rawSessions.map((s) {
        final m = s as Map<String, dynamic>;
        return {
          'checkIn': m['checkInTimestamp'],
          'checkOut': m['checkOutTimestamp'],
          'durationMinutes': m['durationMinutes'],
          'closedBySystem': m['closedBySystem'],
          'isRemote': m['isRemote'],
          'remoteSource': m['remoteSource'],
          'checkInAddress': m['checkInAddress'],
          'missedCheckout': m['missedCheckout'] ?? false,
        };
      }).toList(),
      'totalMinutesToday': summary['totalMinutes'] ?? 0,
    });
  }

  Future<TodayAttendance> checkIn({required double lat, required double lng, required double accuracy, required String nonce}) async {
    await _dio.post(ApiEndpoints.checkIn, data: {
      'latitude': lat,
      'longitude': lng,
      'accuracy': accuracy,
      'nonce': nonce,
      'timestamp': DateTime.now().toUtc().toIso8601String(),
    });
    return getToday();
  }

  Future<TodayAttendance> checkOut({double? latitude, double? longitude, double? accuracy}) async {
    final data = <String, dynamic>{
      'nonce': const Uuid().v4(),
      'timestamp': DateTime.now().toUtc().toIso8601String(),
    };
    if (latitude != null && longitude != null && accuracy != null) {
      data['latitude'] = latitude;
      data['longitude'] = longitude;
      data['accuracy'] = accuracy;
    }
    await _dio.post(ApiEndpoints.checkOut, data: data);
    return getToday();
  }

  Future<List<AttendanceRecord>> getHistory({String? startDate, String? endDate, int page = 1, int limit = 30}) async {
    // /attendance/[employeeId] is admin-only. /attendance/history uses JWT userId.
    // History endpoint requires startDate and endDate; default to last 30 days.
    final now = DateTime.now();
    final end = endDate ?? '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
    final startFallback = now.subtract(const Duration(days: 29));
    final start = startDate ?? '${startFallback.year}-${startFallback.month.toString().padLeft(2, '0')}-${startFallback.day.toString().padLeft(2, '0')}';
    final params = <String, dynamic>{'startDate': start, 'endDate': end, 'page': page, 'limit': limit};
    final r = await _dio.get(ApiEndpoints.attendanceHistory, queryParameters: params);
    final raw = (r.data as Map<String, dynamic>)['data'] as List<dynamic>;
    return raw.map((e) => AttendanceRecord.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<MonthlySummary?> getMonthlySummary(String yearMonth) async {
    try {
      final r = await _dio.get('${ApiEndpoints.attendanceEmployee('me')}/summary', queryParameters: {'yearMonth': yearMonth});
      final data = (r.data as Map<String, dynamic>)['data'];
      if (data == null) return null;
      return MonthlySummary.fromJson(data as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }
}
