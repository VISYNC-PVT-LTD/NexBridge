import 'dart:async';
import 'package:dio/dio.dart';
import '../../constants/api_endpoints.dart';
import '../../constants/storage_keys.dart';
import '../../storage/secure_storage.dart';

typedef SessionExpiredCallback = void Function();

/// True only when the server definitively rejected the refresh token
/// (401 invalid/revoked/expired session, 403 deactivated). Rate limiting
/// (429), server errors (5xx) and network failures (null status) are
/// temporary and must NOT destroy a valid session.
bool isDefinitiveRefreshRejection(int? statusCode) =>
    statusCode == 401 || statusCode == 403;

/// Endpoints where a 401 means "wrong credentials" (or an intentional
/// sign-out), NOT an expired session. These are called before/without a
/// session — e.g. the device-registration screen re-checks the password — so
/// a 401 must be shown to the user as an error instead of triggering the
/// "Session Expired" flow.
bool isCredentialCheckPath(String path) {
  const paths = [
    ApiEndpoints.login,
    ApiEndpoints.forgotPassword,
    ApiEndpoints.resetPassword,
    ApiEndpoints.logout,
    ApiEndpoints.deviceRequest,
    ApiEndpoints.deviceRequestStatus,
  ];
  return paths.any((p) => path.endsWith(p));
}

class AuthInterceptor extends Interceptor {
  final Dio _dio;
  SessionExpiredCallback? onSessionExpired;

  Completer<String?>? _refreshCompleter;

  AuthInterceptor(this._dio);

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    // Skip auth header for auth endpoints that don't need it
    final skipAuth = [ApiEndpoints.login, ApiEndpoints.refresh, ApiEndpoints.forgotPassword, ApiEndpoints.resetPassword];
    if (skipAuth.any((path) => options.path.endsWith(path))) {
      handler.next(options);
      return;
    }

    final token = await SecureStorageService.read(StorageKeys.accessToken);
    final fingerprint = await SecureStorageService.read(StorageKeys.deviceHash);
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    if (fingerprint != null) {
      options.headers['X-Device-Fingerprint'] = fingerprint;
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.response?.statusCode != 401) {
      handler.next(err);
      return;
    }

    // For public auth endpoints a 401 means wrong credentials, not session expiry.
    // Logout is included: a 401 there means the token was already expired/invalid,
    // but we are intentionally clearing the session — not losing it unexpectedly.
    // Pass through so logout always completes without triggering the session-expiry flow.
    if (isCredentialCheckPath(err.requestOptions.path)) {
      handler.next(err);
      return;
    }

    // Avoid refresh loop on refresh endpoint itself. The refresh call below
    // handles its own failures (see isDefinitiveRefreshRejection).
    if (err.requestOptions.path.endsWith(ApiEndpoints.refresh)) {
      handler.next(err);
      return;
    }

    // Deduplicate concurrent refresh calls
    if (_refreshCompleter != null) {
      final newToken = await _refreshCompleter!.future;
      if (newToken != null) {
        handler.resolve(await _retry(err.requestOptions, newToken));
      } else {
        handler.next(err);
      }
      return;
    }

    _refreshCompleter = Completer<String?>();
    try {
      final refreshToken = await SecureStorageService.read(StorageKeys.refreshToken);
      final sessionId = await SecureStorageService.read(StorageKeys.sessionId);
      if (refreshToken == null || sessionId == null) {
        _refreshCompleter!.complete(null);
        onSessionExpired?.call();
        handler.next(err);
        return;
      }

      final response = await _dio.post(ApiEndpoints.refresh, data: {
        'refreshToken': refreshToken,
        'sessionId': sessionId,
      });
      final newAccessToken = response.data['data']['accessToken'] as String?;
      final newRefreshToken = response.data['data']['refreshToken'] as String?;

      if (newAccessToken == null) {
        _refreshCompleter!.complete(null);
        onSessionExpired?.call();
        handler.next(err);
        return;
      }

      await SecureStorageService.saveTokens(
        accessToken: newAccessToken,
        refreshToken: newRefreshToken ?? refreshToken,
      );
      _refreshCompleter!.complete(newAccessToken);
      handler.resolve(await _retry(err.requestOptions, newAccessToken));
    } on DioException catch (refreshErr) {
      _refreshCompleter!.complete(null);
      // Only a definitive auth rejection of the refresh token ends the session.
      // 429 (rate limited), 5xx and network/timeouts are TEMPORARY: keep the
      // stored tokens so the next request can retry the refresh.
      if (isDefinitiveRefreshRejection(refreshErr.response?.statusCode)) {
        await SecureStorageService.clearSession();
        onSessionExpired?.call();
      }
      handler.next(err);
    } catch (_) {
      // Unexpected (e.g. malformed response body) — treat as temporary.
      _refreshCompleter!.complete(null);
      handler.next(err);
    } finally {
      _refreshCompleter = null;
    }
  }

  Future<Response<dynamic>> _retry(RequestOptions requestOptions, String token) {
    final opts = Options(
      method: requestOptions.method,
      headers: {...requestOptions.headers, 'Authorization': 'Bearer $token'},
    );
    return _dio.request<dynamic>(
      requestOptions.path,
      data: requestOptions.data,
      queryParameters: requestOptions.queryParameters,
      options: opts,
    );
  }
}
