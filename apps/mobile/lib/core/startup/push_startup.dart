import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';

import '../router/route_names.dart';

/// Push notifications are optional: sign-in, attendance and leave do not need
/// Firebase. Regression: an exception (or a hang) in Firebase/FCM start-up ran
/// before `runApp`, so the app stayed on the native splash screen forever.

/// Runs [setup] with a time limit. Returns true when push is usable; never
/// throws. [onError] receives the failure (callers log the type only).
Future<bool> runPushSetup(
  Future<void> Function() setup, {
  Duration timeout = const Duration(seconds: 10),
  void Function(Object error)? onError,
}) async {
  try {
    await setup().timeout(timeout);
    return true;
  } catch (e) {
    onError?.call(e);
    return false;
  }
}

/// Where to go after a successful sign-in or session restore: the
/// notification-permission screen only when push works and the user has not
/// been asked yet; otherwise home. A failing or hanging permission lookup must
/// not turn a successful sign-in into an error.
Future<String> routeAfterSignIn({
  required bool pushAvailable,
  required Future<AuthorizationStatus> Function() permissionStatus,
  Duration timeout = const Duration(seconds: 5),
}) async {
  if (!pushAvailable) return RouteNames.home;
  try {
    final status = await permissionStatus().timeout(timeout);
    return status == AuthorizationStatus.notDetermined ? RouteNames.notificationPermission : RouteNames.home;
  } catch (_) {
    return RouteNames.home;
  }
}
