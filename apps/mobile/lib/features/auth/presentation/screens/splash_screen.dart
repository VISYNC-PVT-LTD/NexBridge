import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/constants/storage_keys.dart';
import '../../../../core/di/providers.dart';
import '../../../../core/router/route_names.dart';
import '../../../../core/startup/push_startup.dart';
import '../../../../core/storage/secure_storage.dart';
import '../providers/auth_provider.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    // Max 2s allowed; check tokens first
    final accessToken = await SecureStorageService.read(StorageKeys.accessToken);
    final refreshToken = await SecureStorageService.read(StorageKeys.refreshToken);

    if (accessToken == null || refreshToken == null) {
      if (mounted) context.go(RouteNames.login);
      return;
    }

    try {
      final requiresChange = await ref.read(authProvider.notifier).initialize();
      if (!mounted) return;
      if (requiresChange) {
        context.go(RouteNames.changePassword);
      } else {
        final notifRoute = ref.read(initialNotificationRouteProvider);
        if (notifRoute != null) {
          // Cold-start from notification tap — permission already granted
          context.go(notifRoute);
        } else {
          final route = await routeAfterSignIn(
            pushAvailable: ref.read(pushAvailableProvider),
            permissionStatus: () async =>
                (await FirebaseMessaging.instance.getNotificationSettings()).authorizationStatus,
          );
          if (!mounted) return;
          context.go(route);
        }
      }
    } catch (_) {
      // Network failure — offline mode with cached data
      if (mounted) context.go(RouteNames.home);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF2563EB),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.hexagon_outlined, size: 72, color: Colors.white),
            const SizedBox(height: 16),
            const Text('Genesis Workforce', style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
            const SizedBox(height: 40),
            const SizedBox(width: 200, child: LinearProgressIndicator(backgroundColor: Colors.white24, color: Colors.white)),
          ],
        ),
      ),
    );
  }
}
