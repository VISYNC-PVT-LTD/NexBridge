import 'package:dio/dio.dart';
import '../../../../core/constants/api_endpoints.dart';
import '../../../../core/models/user.dart';

class AuthRemoteSource {
  final Dio _dio;
  AuthRemoteSource(this._dio);

  Future<Map<String, dynamic>> login({
    required String email,
    required String password,
    required String deviceFingerprint,
  }) async {
    final response = await _dio.post(ApiEndpoints.login, data: {
      'email': email,
      'password': password,
      'deviceFingerprint': deviceFingerprint,
    });
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> refresh(String refreshToken, String sessionId) async {
    final response = await _dio.post(ApiEndpoints.refresh, data: {
      'refreshToken': refreshToken,
      'sessionId': sessionId,
    });
    return response.data as Map<String, dynamic>;
  }

  Future<void> logout(String sessionId) async {
    try {
      await _dio.post(ApiEndpoints.logout, data: {'sessionId': sessionId});
    } catch (_) {
      // Best-effort — clear local regardless
    }
  }

  Future<User> getMe() async {
    final response = await _dio.get(ApiEndpoints.me);
    final data = response.data as Map<String, dynamic>;
    return User.fromJson(data['data'] as Map<String, dynamic>);
  }

  Future<Map<String, dynamic>> changePassword({
    required String currentPassword,
    required String newPassword,
    String? sessionId,
  }) async {
    final response = await _dio.patch(ApiEndpoints.changePassword, data: {
      'currentPassword': currentPassword,
      'newPassword': newPassword,
      // Lets the server keep THIS device signed in and revoke the others.
      if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
    });
    return response.data as Map<String, dynamic>;
  }

  Future<void> forgotPassword(String email) async {
    await _dio.post(ApiEndpoints.forgotPassword, data: {'email': email});
  }

  Future<void> resetPassword({
    required String token,
    required String email,
    required String newPassword,
  }) async {
    await _dio.post(ApiEndpoints.resetPassword, data: {
      'token': token,
      'email': email,
      'newPassword': newPassword,
    });
  }

  Future<void> updateFcmToken(String fcmToken) async {
    await _dio.patch(ApiEndpoints.fcmToken, data: {'fcmToken': fcmToken});
  }

  Future<Map<String, dynamic>> submitDeviceRequest(Map<String, dynamic> body) async {
    final response = await _dio.post(ApiEndpoints.deviceRequest, data: body);
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> checkDeviceRequestStatus({
    required String email,
    required String deviceFingerprint,
  }) async {
    final response = await _dio.get(
      ApiEndpoints.deviceRequestStatus,
      queryParameters: {'email': email, 'deviceFingerprint': deviceFingerprint},
    );
    return response.data as Map<String, dynamic>;
  }
}
