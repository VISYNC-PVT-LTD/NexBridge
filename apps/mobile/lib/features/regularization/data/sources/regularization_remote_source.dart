import 'package:dio/dio.dart';
import '../../../../core/constants/api_endpoints.dart';
import '../../../../core/models/regularization.dart';

class RegularizationRemoteSource {
  final Dio _dio;
  RegularizationRemoteSource(this._dio);

  Future<List<RegularizationRequest>> getHistory({String? status, int page = 1, int limit = 20}) async {
    final r = await _dio.get(ApiEndpoints.regularizations, queryParameters: {'page': page, 'limit': limit, if (status != null) 'status': status});
    final data = (r.data as Map<String, dynamic>)['data'] as List<dynamic>;
    return data.map((e) => RegularizationRequest.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<RegularizationRequest> getById(String id) async {
    final r = await _dio.get(ApiEndpoints.regularizationById(id));
    return RegularizationRequest.fromJson((r.data as Map<String, dynamic>)['data'] as Map<String, dynamic>);
  }

  Future<RegularizationRequest> create({required String date, required String type, required String reason, String? requestedCheckIn, String? requestedCheckOut}) async {
    final r = await _dio.post(ApiEndpoints.regularizations, data: {
      'date': date,
      'type': type,
      'reason': reason,
      if (requestedCheckIn != null) 'requestedCheckIn': requestedCheckIn,
      if (requestedCheckOut != null) 'requestedCheckOut': requestedCheckOut,
    });
    return RegularizationRequest.fromJson((r.data as Map<String, dynamic>)['data'] as Map<String, dynamic>);
  }

  /// Withdraws the caller's own PENDING request (server: PATCH .../withdraw).
  Future<void> cancel(String id) async {
    await _dio.patch(ApiEndpoints.regularizationWithdraw(id));
  }
}
