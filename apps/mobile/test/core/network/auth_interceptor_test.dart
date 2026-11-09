import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/network/interceptors/auth_interceptor.dart';

void main() {
  group('isDefinitiveRefreshRejection', () {
    test('401 and 403 end the session', () {
      expect(isDefinitiveRefreshRejection(401), isTrue);
      expect(isDefinitiveRefreshRejection(403), isTrue);
    });

    test('429 rate limiting keeps the session', () {
      expect(isDefinitiveRefreshRejection(429), isFalse);
    });

    test('server errors keep the session', () {
      expect(isDefinitiveRefreshRejection(500), isFalse);
      expect(isDefinitiveRefreshRejection(502), isFalse);
      expect(isDefinitiveRefreshRejection(503), isFalse);
    });

    test('network failure / timeout (no status) keeps the session', () {
      expect(isDefinitiveRefreshRejection(null), isFalse);
    });
  });

  // Regression (found on a real phone against the local API): a wrong password
  // on the "Device Not Registered" screen (POST /auth/device-request → 401
  // AUTH_001) was shown as "Session Expired" because the interceptor treated
  // every 401 outside login/reset/logout as an expired session.
  group('isCredentialCheckPath', () {
    test('device registration endpoints: 401 means wrong credentials', () {
      expect(isCredentialCheckPath('/api/v1/auth/device-request'), isTrue);
      expect(isCredentialCheckPath('/api/v1/auth/device-request/status'), isTrue);
    });

    test('existing public auth endpoints are still covered', () {
      expect(isCredentialCheckPath('/api/v1/auth/login'), isTrue);
      expect(isCredentialCheckPath('/api/v1/auth/logout'), isTrue);
      expect(isCredentialCheckPath('/api/v1/auth/password-reset/request'), isTrue);
      expect(isCredentialCheckPath('/api/v1/auth/password-reset/confirm'), isTrue);
    });

    test('authenticated endpoints still go through refresh / session expiry', () {
      expect(isCredentialCheckPath('/api/v1/attendance/checkin'), isFalse);
      expect(isCredentialCheckPath('/api/v1/attendance/status'), isFalse);
      expect(isCredentialCheckPath('/api/v1/leaves'), isFalse);
      expect(isCredentialCheckPath('/api/v1/auth/refresh'), isFalse);
    });
  });
}
