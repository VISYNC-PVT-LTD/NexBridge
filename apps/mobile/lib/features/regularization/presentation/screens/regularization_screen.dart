import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../../core/models/regularization.dart';
import '../../../../core/router/route_names.dart';
import '../../../../shared/widgets/error_widget.dart';
import '../../../../shared/widgets/loading_overlay.dart';
import '../providers/regularization_provider.dart';

class RegularizationScreen extends ConsumerWidget {
  const RegularizationScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(regularizationHistoryProvider(null));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Regularizations'),
        actions: [IconButton(icon: const Icon(Icons.add), onPressed: () => context.push(RouteNames.regularizationCreate))],
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => AppErrorWidget(message: 'Could not load regularizations. Check your connection.', onRetry: () => ref.refresh(regularizationHistoryProvider(null).future)),
        data: (regs) {
          final list = regs as List<RegularizationRequest>;
          if (list.isEmpty) return const Center(child: Text('No regularization requests.'));
          return RefreshIndicator(
            onRefresh: () => ref.refresh(regularizationHistoryProvider(null).future),
            child: ListView.separated(
              itemCount: list.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) {
                final r = list[i];
                final date = DateTime.tryParse(r.date);
                return ListTile(
                  onTap: () => context.push(RouteNames.regularizationDetail(r.id)),
                  title: Text(date != null ? DateFormat('dd MMM yyyy').format(date) : r.date),
                  subtitle: Text(regularizationTypeLabel(r.type)),
                  trailing: StatusChip(status: r.status),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
