import 'package:flutter/material.dart';

/// Yes/No confirmation that always closes ITSELF.
///
/// Regression: the leave-cancel and regularization-withdraw dialogs called
/// `Navigator.pop(context, …)` with the SCREEN's context. Under go_router's
/// nested navigators that popped the page instead of the dialog, so the
/// confirmation never resolved, no request was sent and the dialog stayed on
/// screen. Popping with the dialog's own context fixes it.
Future<bool> showConfirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'No',
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(cancelLabel)),
        TextButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: Text(confirmLabel)),
      ],
    ),
  );
  return result ?? false;
}
