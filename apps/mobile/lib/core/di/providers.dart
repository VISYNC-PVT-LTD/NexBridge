import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import '../network/api_client.dart';
import '../network/interceptors/auth_interceptor.dart';
import '../network/interceptors/idempotency_interceptor.dart';
import '../network/interceptors/logging_interceptor.dart';
import '../../features/attendance/data/sources/location_snapshot_source.dart';
import '../../features/notifications/data/services/fcm_service.dart';

// Fires true when refresh token fails — consumed by router to push /session-expired
final sessionExpiredProvider = StateProvider<bool>((ref) => false);

// Cold-start notification route — overridden in main.dart when app launched from tapped notification
final initialNotificationRouteProvider = StateProvider<String?>((ref) => null);

// Whether Firebase/FCM start-up succeeded — overridden in main.dart. When false
// the app runs without push and skips every FirebaseMessaging call.
final pushAvailableProvider = Provider<bool>((ref) => false);

// Background-tap notification route — set by main.dart onMessageOpenedApp listener, consumed by MainShell
final pendingNotificationRouteProvider = StateProvider<String?>((ref) => null);

final dioProvider = Provider<Dio>((ref) {
  // Separate plain Dio for refresh calls only (no auth interceptor — avoids loop)
  final refreshDio = createDioClient();

  final authInterceptor = AuthInterceptor(refreshDio);
  authInterceptor.onSessionExpired = () {
    ref.read(sessionExpiredProvider.notifier).state = true;
  };

  final dio = createDioClient();
  dio.interceptors.addAll([
    authInterceptor,
    IdempotencyInterceptor(),
    LoggingInterceptor(),
  ]);
  return dio;
});

final fcmServiceProvider = Provider<FcmService>((ref) {
  return FcmService(ref.watch(dioProvider));
});

final locationSnapshotSourceProvider = Provider<LocationSnapshotSource>((ref) {
  return LocationSnapshotSource(ref.watch(dioProvider));
});
