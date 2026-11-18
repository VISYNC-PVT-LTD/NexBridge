import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/router/route_names.dart';
import 'package:genesis_workforce/core/startup/push_startup.dart';

// Regression: Firebase/FCM start-up ran unguarded before runApp, so a failure
// (or a hang) left the app on the native splash screen forever, and a failing
// permission lookup after a successful sign-in showed "No connection".

void main() {
  group('runPushSetup', () {
    test('success → push available', () async {
      expect(await runPushSetup(() async {}), isTrue);
    });

    test('a throwing Firebase init does not escape; push unavailable', () async {
      Object? reported;
      final ok = await runPushSetup(
        () async => throw StateError('firebase init failed'),
        onError: (e) => reported = e,
      );
      expect(ok, isFalse);
      expect(reported, isA<StateError>());
    });

    test('a hanging Firebase init is abandoned after the timeout', () async {
      final never = Completer<void>();
      final sw = Stopwatch()..start();
      final ok = await runPushSetup(() => never.future, timeout: const Duration(milliseconds: 50));
      expect(ok, isFalse);
      expect(sw.elapsed, lessThan(const Duration(seconds: 2)));
    });
  });

  group('routeAfterSignIn', () {
    test('push unavailable → home, without touching FirebaseMessaging', () async {
      var called = false;
      final route = await routeAfterSignIn(
        pushAvailable: false,
        permissionStatus: () async { called = true; return AuthorizationStatus.notDetermined; },
      );
      expect(route, RouteNames.home);
      expect(called, isFalse);
    });

    test('not yet asked → permission screen; otherwise home', () async {
      expect(
        await routeAfterSignIn(pushAvailable: true, permissionStatus: () async => AuthorizationStatus.notDetermined),
        RouteNames.notificationPermission,
      );
      for (final s in [AuthorizationStatus.authorized, AuthorizationStatus.denied, AuthorizationStatus.provisional]) {
        expect(await routeAfterSignIn(pushAvailable: true, permissionStatus: () async => s), RouteNames.home);
      }
    });

    test('a throwing permission lookup → home (sign-in already succeeded)', () async {
      expect(
        await routeAfterSignIn(pushAvailable: true, permissionStatus: () async => throw Exception('no firebase app')),
        RouteNames.home,
      );
    });

    test('a hanging permission lookup → home after the timeout', () async {
      final never = Completer<AuthorizationStatus>();
      expect(
        await routeAfterSignIn(
          pushAvailable: true,
          permissionStatus: () => never.future,
          timeout: const Duration(milliseconds: 50),
        ),
        RouteNames.home,
      );
    });
  });
}
