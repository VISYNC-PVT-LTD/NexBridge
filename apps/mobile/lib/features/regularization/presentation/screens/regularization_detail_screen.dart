import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../../../core/models/regularization.dart';
import '../../../../shared/widgets/app_button.dart';
import '../../../../shared/widgets/confirm_dialog.dart';
import '../../../../shared/widgets/error_widget.dart';
import '../../../../shared/widgets/loading_overlay.dart';
import '../providers/regularization_provider.dart';

class RegularizationDetailScreen extends ConsumerWidget {
  const RegularizationDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(regularizationDetailProvider(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Regularization')),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => const AppErrorWidget(message: 'Could not load details. Go back and try again.'),
        data: (data) {
          final reg = data as RegularizationRequest;
          final fmt = DateFormat('dd MMM yyyy');
          return SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Card(child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    StatusChip(status: reg.status),
                    const SizedBox(height: 12),
                    _Row(label: 'Date', value: fmt.format(DateTime.parse(reg.date))),
                    _Row(label: 'Type', value: regularizationTypeLabel(reg.type)),
                    if (reg.requestedCheckIn != null) _Row(label: 'Check-In', value: formatRequestedTime(reg.requestedCheckIn!)),
                    if (reg.requestedCheckOut != null) _Row(label: 'Check-Out', value: formatRequestedTime(reg.requestedCheckOut!)),
                    _Row(label: 'Applied', value: fmt.format(DateTime.parse(reg.createdAt))),
                  ]),
                )),
                const SizedBox(height: 12),
                Card(child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Reason', style: TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    Text(reg.reason),
                  ]),
                )),
                if (reg.reviewRemark != null) ...[
                  const SizedBox(height: 12),
                  Card(child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const Text('Review Remark', style: TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 8),
                      Text(reg.reviewRemark!),
                    ]),
                  )),
                ],
                if (reg.isCancellable) ...[
                  const SizedBox(height: 24),
                  _CancelBtn(id: id),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

class _CancelBtn extends ConsumerStatefulWidget {
  const _CancelBtn({required this.id});
  final String id;

  @override
  ConsumerState<_CancelBtn> createState() => _CancelBtnState();
}

class _CancelBtnState extends ConsumerState<_CancelBtn> {
  bool _loading = false;

  @override
  Widget build(BuildContext context) {
    return AppButton(
      label: 'Withdraw Request',
      variant: AppButtonVariant.destructive,
      loading: _loading,
      onPressed: () async {
        final messenger = ScaffoldMessenger.of(context);
        final confirm = await showConfirmDialog(
          context,
          title: 'Withdraw?',
          message: 'Cancel this regularization request?',
          confirmLabel: 'Yes, Withdraw',
        );
        if (confirm != true) return;
        setState(() => _loading = true);
        try {
          await ref.read(regularizationSourceProvider).cancel(widget.id);
          ref.invalidate(regularizationDetailProvider(widget.id));
          ref.invalidate(regularizationHistoryProvider);
          if (mounted) messenger.showSnackBar(const SnackBar(content: Text('Request withdrawn.')));
        } catch (_) {
          if (mounted) messenger.showSnackBar(const SnackBar(content: Text('Failed to withdraw. Try again.')));
        } finally {
          if (mounted) setState(() => _loading = false);
        }
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(children: [
      SizedBox(width: 90, child: Text(label, style: const TextStyle(color: Colors.grey))),
      Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w500))),
    ]),
  );
}
