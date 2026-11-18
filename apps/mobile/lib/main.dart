import 'dart:async';
import 'dart:ui';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:hive_flutter/hive_flutter.dart';
import 'core/di/providers.dart';
import 'core/startup/push_startup.dart';
import 'core/storage/local_storage.dart';
import 'features/notifications/data/services/fcm_service.dart';
import 'firebase_options.dart';
import 'app.dart';

@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
}

final FlutterLocalNotificationsPlugin flutterLocalNotificationsPlugin =
    FlutterLocalNotificationsPlugin();

void main() async {
  runZonedGuarded(() async {
    await _bootstrap();
  }, (error, stack) {
    // ignore: avoid_print
    print('[ERR][ZONE] $error');
  });
}

Future<void> _bootstrap() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Log Flutter framework errors without re-presenting them.
  FlutterError.onError = (details) {
    // ignore: avoid_print
    print('[ERR][FLUTTER] ${details.exceptionAsString()}');
  };

  // Return true = we handled it; prevents Flutter's default red debug overlay
  // for unhandled async errors that escape try/catch in timer or notification callbacks.
  PlatformDispatcher.instance.onError = (error, stack) {
    // ignore: avoid_print
    print('[ERR][PLATFORM] $error');
    return true;
  };

  // Safety net: replace any widget-subtree ErrorWidget with a friendly card.
  // Prevents raw DioException / SocketException text from ever reaching the user.
  ErrorWidget.builder = (FlutterErrorDetails details) {
    // ignore: avoid_print
    print('[ERR][WIDGET] ${details.exceptionAsString()}');
    return const Material(
      color: Colors.transparent,
      child: Padding(
        padding: EdgeInsets.all(16),
        child: Card(
          child: Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              'Something went wrong. Please try again.',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      ),
    );
  };

  await Hive.initFlutter();
  await LocalStorageService.init();

  // Push is optional. A Firebase/FCM failure or hang must not keep the app on
  // the splash screen: start without push instead (see push_startup.dart).
  String? initialRoute;
  final pushAvailable = await runPushSetup(() async {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);

    const androidChannel = AndroidNotificationChannel(
      'high_importance_channel',
      'High Importance Notifications',
      importance: Importance.max,
    );
    await flutterLocalNotificationsPlugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(androidChannel);

    await FirebaseMessaging.instance.setForegroundNotificationPresentationOptions(
      alert: true,
      badge: true,
      sound: true,
    );

    // Cold-start: capture launch notification before runApp
    final initialMessage = await FcmService.getInitialMessage();
    initialRoute = initialMessage != null ? FcmService.routeFromMessage(initialMessage) : null;
  }, onError: (e) {
    // ignore: avoid_print
    print('[ERR][PUSH] start-up failed, continuing without push: ${e.runtimeType}');
  });

  final launchRoute = initialRoute;
  final container = ProviderContainer(
    overrides: [
      pushAvailableProvider.overrideWithValue(pushAvailable),
      if (launchRoute != null)
        initialNotificationRouteProvider.overrideWith((ref) => launchRoute),
    ],
  );

  if (pushAvailable) {
    // Wire foreground + tap handlers immediately after Firebase init
    await runPushSetup(() => container.read(fcmServiceProvider).initialize(), onError: (e) {
      // ignore: avoid_print
      print('[ERR][PUSH] handler set-up failed: ${e.runtimeType}');
    });

    // Background-tap routing: FcmService._handleMessageOpenedApp ignores the route return value,
    // so we add a second listener here where we have container access to set the provider.
    FirebaseMessaging.onMessageOpenedApp.listen((message) {
      final route = FcmService.routeFromMessage(message);
      if (route != null) {
        container.read(pendingNotificationRouteProvider.notifier).state = route;
      }
    });
  }

  runApp(UncontrolledProviderScope(
    container: container,
    child: const GenesisApp(),
  ));
}
