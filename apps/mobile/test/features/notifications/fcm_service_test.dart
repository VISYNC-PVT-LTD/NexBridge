import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/features/notifications/data/services/fcm_service.dart';

// Regression: AuthNotifier.login calls registerToken() without awaiting it.
// With Firebase unavailable, getToken() threw and the error escaped as an
// unhandled async error. It must now complete quietly.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('registerToken completes without throwing when Firebase is not initialised', () async {
    final service = FcmService(Dio(BaseOptions(baseUrl: 'http://fixture.invalid')));
    await expectLater(service.registerToken(), completes);
  });

  test('clearToken completes without throwing when Firebase is not initialised', () async {
    final service = FcmService(Dio(BaseOptions(baseUrl: 'http://fixture.invalid')));
    await expectLater(service.clearToken(), completes);
  });
}
