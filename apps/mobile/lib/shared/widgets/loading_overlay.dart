import 'package:flutter/material.dart';

class LoadingOverlay extends StatelessWidget {
  const LoadingOverlay({super.key, this.label});
  final String? label;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black26,
      child: Center(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const CircularProgressIndicator(),
                if (label != null) ...[
                  const SizedBox(height: 16),
                  Text(label!),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ShimmerBox extends StatelessWidget {
  const ShimmerBox({super.key, required this.width, required this.height, this.borderRadius = 8});
  final double width;
  final double height;
  final double borderRadius;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: const Color(0xFFE5E7EB),
        borderRadius: BorderRadius.circular(borderRadius),
      ),
    );
  }
}

class ShimmerListTile extends StatelessWidget {
  const ShimmerListTile({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          const ShimmerBox(width: 40, height: 40, borderRadius: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: const [
                ShimmerBox(width: double.infinity, height: 14),
                SizedBox(height: 6),
                ShimmerBox(width: 120, height: 12),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, label) = _resolve(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(100)),
      child: Text(label, style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w500)),
    );
  }

  (Color, Color, String) _resolve(String status) => switch (status.toLowerCase()) {
    'present' => (const Color(0xFFDCFCE7), const Color(0xFF15803D), 'Present'),
    'absent' => (const Color(0xFFFEE2E2), const Color(0xFFB91C1C), 'Absent'),
    'checked-in' => (const Color(0xFFDBEAFE), const Color(0xFF1D4ED8), 'Active'),
    'half_day' || 'half-day' => (const Color(0xFFFEF3C7), const Color(0xFFB45309), 'Half Day'),
    'leave' => (const Color(0xFFDBEAFE), const Color(0xFF1D4ED8), 'Leave'),
    'holiday' => (const Color(0xFFEDE9FE), const Color(0xFF6D28D9), 'Holiday'),
    'weekend' => (const Color(0xFFF3F4F6), const Color(0xFF6B7280), 'Weekend'),
    'pending' => (const Color(0xFFFEF3C7), const Color(0xFFB45309), 'Pending'),
    'approved' => (const Color(0xFFDCFCE7), const Color(0xFF15803D), 'Approved'),
    'rejected' => (const Color(0xFFFEE2E2), const Color(0xFFB91C1C), 'Rejected'),
    'cancelled' => (const Color(0xFFF3F4F6), const Color(0xFF6B7280), 'Cancelled'),
    'withdrawn' => (const Color(0xFFF3F4F6), const Color(0xFF6B7280), 'Withdrawn'),
    'revoked' => (const Color(0xFFFFEDD5), const Color(0xFFC2410C), 'Revoked'),
    'finalised' || 'finalized' => (const Color(0xFFDCFCE7), const Color(0xFF15803D), 'Finalised'),
    'draft' => (const Color(0xFFF3F4F6), const Color(0xFF374151), 'Draft'),
    _ => (const Color(0xFFF3F4F6), const Color(0xFF374151), status),
  };
}
