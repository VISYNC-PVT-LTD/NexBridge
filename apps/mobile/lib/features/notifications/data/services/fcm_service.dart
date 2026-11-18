import 'dart:io';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:dio/dio.dart';
import '../../../../core/constants/api_endpoints.dart';
import '../../../../core/constants/storage_keys.dart';
import '../../../../core/storage/secure_storage.dart';

class FcmService {
  final Dio _dio;
  FcmService(this._dio);

  static final _localNotifications = FlutterLocalNotificationsPlugin();
  static const _channelId = 'high_importance_channel';

  Future<void> initialize() async {
    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    await _localNotifications.initialize(
      const InitializationSettings(android: androidInit),
    );

    FirebaseMessaging.onMessage.listen(_handleForegroundMessage);
    FirebaseMessaging.onMessageOpenedApp.listen(_handleMessageOpenedApp);
  }

  Future<String?> getToken() => FirebaseMessaging.instance.getToken();

  /// Called without `await` after sign-in, so it must never throw: a Firebase
  /// failure here used to surface as an unhandled async error.
  Future<void> registerToken() async {
    try {
      final token = await getToken();
      if (token == null) return;
      await _postToken(token);
      FirebaseMessaging.instance.onTokenRefresh.listen((newToken) async {
        await _postToken(newToken);
      });
    } catch (_) {
      // Non-fatal — push stays off for this session; retried on next sign-in.
    }
  }

  Future<void> _postToken(String token) async {
    // Spec 9.4: POST /api/v1/notifications/fcm-token { token, deviceId, platform }
    final deviceId = await SecureStorageService.read(StorageKeys.deviceHash) ?? '';
    try {
      await _dio.post(ApiEndpoints.fcmToken, data: {
        'token': token,
        'deviceId': deviceId,
        'platform': Platform.isAndroid ? 'android' : 'ios',
      });
    } catch (_) {
      // Non-fatal — retry on next launch
    }
  }

  Future<void> clearToken() async {
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {
      // Non-fatal — token may already be invalid or Firebase unavailable
    }
  }

  Future<NotificationSettings> requestPermission() =>
      FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );

  Future<AuthorizationStatus> getPermissionStatus() async {
    final settings = await FirebaseMessaging.instance.getNotificationSettings();
    return settings.authorizationStatus;
  }

  void _handleForegroundMessage(RemoteMessage message) {
    final notification = message.notification;
    if (notification == null) return;
    _localNotifications.show(
      notification.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'High Importance Notifications',
          importance: Importance.max,
          priority: Priority.high,
        ),
      ),
    );
  }

  void _handleMessageOpenedApp(RemoteMessage message) {
    _routeFromMessage(message);
  }

  static Future<RemoteMessage?> getInitialMessage() =>
      FirebaseMessaging.instance.getInitialMessage();

  static String? routeFromMessage(RemoteMessage message) =>
      _routeFromMessage(message);

  static String? _routeFromMessage(RemoteMessage message) {
    final data = message.data;
    final type = data['type'] as String?;
    final id = data['referenceId'] as String?;
    switch (type) {
      case 'leave-approved':
      case 'leave-rejected':
        return id != null ? '/leave/$id' : '/leave';
      case 'regularization-approved':
      case 'regularization-rejected':
        return id != null ? '/regularization/$id' : '/regularization';
      case 'payroll-finalised':
        return '/payslip';
      case 'attendance-reminder':
        return '/home';
      default:
        final notifId = data['notificationId'] as String?;
        return notifId != null ? '/notifications/$notifId' : '/notifications';
    }
  }
}
