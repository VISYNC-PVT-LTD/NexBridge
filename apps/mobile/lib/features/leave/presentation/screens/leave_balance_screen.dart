import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/models/leave.dart';
import '../../../../core/router/route_names.dart';
import '../../../../shared/widgets/error_widget.dart';
import '../providers/leave_provider.dart';

class LeaveScreen extends ConsumerStatefulWidget {
  const LeaveScreen({super.key});

  @override
  ConsumerState<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends ConsumerState<LeaveScreen> with SingleTickerProviderStateMixin {
  late TabController _tab;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Leave'),
        bottom: TabBar(controller: _tab, tabs: const [Tab(text: 'Balance'), Tab(text: 'History')]),
        actions: [IconButton(icon: const Icon(Icons.add), onPressed: () => context.push(RouteNames.leaveApply))],
      ),
      body: TabBarView(controller: _tab, children: const [_BalanceTab(), _HistoryTab()]),
    );
  }
}

class _BalanceTab extends ConsumerWidget {
  const _BalanceTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(leaveBalanceProvider);
    return async.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (_, __) => AppErrorWidget(message: 'Could not load leave balance. Check your connection.', onRetry: () => ref.refresh(leaveBalanceProvider.future)),
      data: (balances) {
        if (balances.isEmpty) return const Center(child: Text('No leave balance data.'));
        return RefreshIndicator(
          onRefresh: () => ref.refresh(leaveBalanceProvider.future),
          child: ListView.builder(
            padding: const EdgeInsets.all(16),
            itemCount: balances.length,
            itemBuilder: (_, i) => _BalanceCard(balance: balances[i]),
          ),
        );
      },
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.balance});
  final LeaveBalance balance;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(balance.leaveTypeName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                _Stat(label: 'Entitled', value: '${balance.entitled}'),
                _Stat(label: 'Used', value: '${balance.used}'),
                _Stat(label: 'Carry Fwd', value: '${balance.carriedForward}'),
                _Stat(label: 'Remaining', value: '${balance.remaining}', highlight: true),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, this.highlight = false});
  final String label;
  final String value;
  final bool highlight;

  @override
  Widget build(BuildContext context) => Column(children: [
    Text(value, style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: highlight ? const Color(0xFF2563EB) : null)),
    Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
  ]);
}

class _HistoryTab extends ConsumerWidget {
  const _HistoryTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(leaveHistoryProvider(null));
    return async.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (_, __) => AppErrorWidget(message: 'Could not load leave history. Check your connection.', onRetry: () => ref.refresh(leaveHistoryProvider(null).future)),
      data: (leaves) {
        if (leaves.isEmpty) return const Center(child: Text('No leave requests.'));
        return RefreshIndicator(
          onRefresh: () => ref.refresh(leaveHistoryProvider(null).future),
          child: ListView.separated(
            itemCount: leaves.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (_, i) {
              final l = leaves[i];
              return ListTile(
                onTap: () => context.push(RouteNames.leaveDetail(l.id)),
                title: Text(leaveTypeLabel(l.leaveType)),
                subtitle: Text('${l.startDate.substring(0, 10)} → ${l.endDate.substring(0, 10)} · ${l.days} day${l.days != 1 ? 's' : ''}'),
                trailing: _StatusChipSmall(status: l.status),
              );
            },
          ),
        );
      },
    );
  }
}

class _StatusChipSmall extends StatelessWidget {
  const _StatusChipSmall({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (status) {
      'pending' => (const Color(0xFFFEF3C7), const Color(0xFFB45309)),
      'approved' => (const Color(0xFFDCFCE7), const Color(0xFF15803D)),
      'rejected' => (const Color(0xFFFEE2E2), const Color(0xFFB91C1C)),
      'cancelled' => (const Color(0xFFF3F4F6), const Color(0xFF6B7280)),
      _ => (const Color(0xFFF3F4F6), const Color(0xFF374151)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(100)),
      child: Text(status[0].toUpperCase() + status.substring(1), style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w500)),
    );
  }
}
