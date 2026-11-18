import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/router/route_names.dart';
import '../../../../shared/widgets/app_button.dart';

class NotificationPermissionScreen extends StatelessWidget {
  const NotificationPermissionScreen({super.key});

  Future<void> _requestAndContinue(BuildContext context) async {
    try {
      await FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
    } catch (_) {
      // Push unavailable — continue without it rather than leave the user stuck here.
    }
    if (context.mounted) context.go(RouteNames.home);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.notifications_active_outlined, size: 80, color: Color(0xFF2563EB)),
              const SizedBox(height: 24),
              Text(
                'Stay Informed',
                style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.bold),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              Text(
                'Enable notifications to receive real-time updates on leave approvals, regularization status, and attendance reminders.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600]),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 40),
              AppButton(
                label: 'Enable Notifications',
                onPressed: () => _requestAndContinue(context),
              ),
              const SizedBox(height: 12),
              AppButton(
                label: 'Not Now',
                variant: AppButtonVariant.ghost,
                onPressed: () => context.go(RouteNames.home),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
