import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/constants/api_endpoints.dart';

void main() {
  group('ApiEndpoints — H1 contract', () {
    test('changePassword matches spec path', () {
      expect(ApiEndpoints.changePassword, '/api/v1/auth/me/change-password');
    });

    test('forgotPassword matches spec path', () {
      expect(ApiEndpoints.forgotPassword, '/api/v1/auth/password-reset/request');
    });

    test('resetPassword matches spec path', () {
      expect(ApiEndpoints.resetPassword, '/api/v1/auth/password-reset/confirm');
    });

    test('notificationsReadAll matches spec path', () {
      expect(ApiEndpoints.notificationsReadAll, '/api/v1/notifications/read-all');
    });

    test('login path correct', () {
      expect(ApiEndpoints.login, '/api/v1/auth/login');
    });

    test('refresh path correct', () {
      expect(ApiEndpoints.refresh, '/api/v1/auth/refresh');
    });

    test('logout path correct', () {
      expect(ApiEndpoints.logout, '/api/v1/auth/logout');
    });

    test('fcmToken matches spec path POST /notifications/fcm-token', () {
      expect(ApiEndpoints.fcmToken, '/api/v1/notifications/fcm-token');
    });

    test('regularization withdraw matches server route PATCH /regularizations/:id/withdraw', () {
      // Regression: the app previously called /cancel, which does not exist (404).
      expect(ApiEndpoints.regularizationWithdraw('abc123'), '/api/v1/regularizations/abc123/withdraw');
    });
  });
}
