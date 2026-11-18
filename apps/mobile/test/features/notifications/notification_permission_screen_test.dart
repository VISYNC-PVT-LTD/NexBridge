import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/router/route_names.dart';
import 'package:genesis_workforce/features/notifications/presentation/screens/notification_permission_screen.dart';
import 'package:go_router/go_router.dart';

// Regression: with Firebase unavailable (or the permission request failing),
// "Enable Notifications" threw and left the user stuck on this screen.
// Firebase is never initialised in widget tests, so the request fails here
// exactly as it does on a device whose Firebase start-up failed.

Widget _app() => MaterialApp.router(
      routerConfig: GoRouter(
        initialLocation: RouteNames.notificationPermission,
        routes: [
          GoRoute(path: RouteNames.notificationPermission, builder: (_, __) => const NotificationPermissionScreen()),
          GoRoute(path: RouteNames.home, builder: (_, __) => const Scaffold(body: Text('HOME'))),
        ],
      ),
    );

void main() {
  testWidgets('Enable Notifications continues to home when the request fails', (tester) async {
    await tester.pumpWidget(_app());
    await tester.tap(find.text('Enable Notifications'));
    await tester.pumpAndSettle();
    expect(find.text('HOME'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Not Now continues to home without touching Firebase', (tester) async {
    await tester.pumpWidget(_app());
    await tester.tap(find.text('Not Now'));
    await tester.pumpAndSettle();
    expect(find.text('HOME'), findsOneWidget);
  });
}
