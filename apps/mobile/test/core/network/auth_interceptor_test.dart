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
}
