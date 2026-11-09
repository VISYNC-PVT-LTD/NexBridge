import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../../../shared/widgets/app_button.dart';
import '../../../../shared/widgets/confirm_dialog.dart';
import '../../../../core/models/leave.dart';
import '../../../../shared/widgets/error_widget.dart';
import '../../../../shared/widgets/loading_overlay.dart';
import '../providers/leave_provider.dart';

class LeaveDetailScreen extends ConsumerWidget {
  const LeaveDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(leaveDetailProvider(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Leave Request')),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => const AppErrorWidget(message: 'Could not load leave details. Go back and try again.'),
        data: (leave) {
          final fmt = DateFormat('dd MMM yyyy');
          return SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Card(child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    StatusChip(status: leave.status),
                    const SizedBox(height: 12),
                    _Row(label: 'Type', value: leaveTypeLabel(leave.leaveType)),
                    _Row(label: 'From', value: fmt.format(DateTime.parse(leave.startDate))),
                    _Row(label: 'To', value: fmt.format(DateTime.parse(leave.endDate))),
                    _Row(label: 'Days', value: '${leave.days}'),
                    _Row(label: 'Applied', value: fmt.format(DateTime.parse(leave.createdAt))),
                  ]),
                )),
                const SizedBox(height: 12),
                Card(child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Reason', style: TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    Text(leave.reason),
                  ]),
                )),
                if (leave.reviewRemark != null) ...[
                  const SizedBox(height: 12),
                  Card(child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const Text('Review Remark', style: TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 8),
                      Text(leave.reviewRemark!),
                    ]),
                  )),
                ],
                if (leave.isCancellable) ...[
                  const SizedBox(height: 24),
                  _CancelButton(id: id, ref: ref),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

class _CancelButton extends ConsumerStatefulWidget {
  const _CancelButton({required this.id, required this.ref});
  final String id;
  final WidgetRef ref;

  @override
  ConsumerState<_CancelButton> createState() => _CancelButtonState();
}

class _CancelButtonState extends ConsumerState<_CancelButton> {
  bool _loading = false;

  @override
  Widget build(BuildContext context) {
    return AppButton(
      label: 'Cancel Request',
      variant: AppButtonVariant.destructive,
      loading: _loading,
      onPressed: () async {
        final messenger = ScaffoldMessenger.of(context);
        final confirm = await showConfirmDialog(
          context,
          title: 'Cancel Leave?',
          message: 'Are you sure you want to cancel this leave request?',
          confirmLabel: 'Yes, Cancel',
        );
        if (confirm != true) return;
        setState(() => _loading = true);
        try {
          await ref.read(leaveSourceProvider).cancel(widget.id);
          ref.invalidate(leaveDetailProvider(widget.id));
          ref.invalidate(leaveHistoryProvider);
          ref.invalidate(leaveBalanceProvider);
          if (mounted) messenger.showSnackBar(const SnackBar(content: Text('Leave request cancelled.')));
        } catch (_) {
          if (mounted) messenger.showSnackBar(const SnackBar(content: Text('Failed to cancel. Try again.')));
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
      SizedBox(width: 80, child: Text(label, style: const TextStyle(color: Colors.grey))),
      Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w500))),
    ]),
  );
}
