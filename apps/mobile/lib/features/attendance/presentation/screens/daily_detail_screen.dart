import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../../core/models/attendance.dart';
import '../../../../core/router/route_names.dart';
import '../../../../shared/widgets/loading_overlay.dart';
import '../providers/attendance_provider.dart';

class DailyDetailScreen extends ConsumerWidget {
  const DailyDetailScreen({super.key, required this.dateStr});
  final String dateStr;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final histAsync = ref.watch(attendanceHistoryProvider((startDate: dateStr, endDate: dateStr)));
    DateTime? date;
    try { date = DateTime.parse(dateStr); } catch (_) {}

    return Scaffold(
      appBar: AppBar(title: Text(date != null ? DateFormat('EEE, d MMMM yyyy').format(date) : dateStr)),
      body: histAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => const Center(child: Text('Could not load details. Go back and try again.', style: TextStyle(color: Colors.grey))),
        data: (records) {
          final rec = records.isNotEmpty ? records.first : null;
          return SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (rec != null) ...[
                  StatusChip(status: rec.status),
                  const SizedBox(height: 8),
                  if (rec.workHours != null)
                    Text('${(rec.workHours! * 60).toInt() ~/ 60} hours ${(rec.workHours! * 60).toInt() % 60} minutes',
                        style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 16),
                  if (rec.sessions.isNotEmpty) ...[
                    Text('Sessions', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    ...rec.sessions.asMap().entries.map((e) => Card(
                      margin: const EdgeInsets.only(bottom: 8),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Row(children: [
                            Text('Session ${e.key + 1}', style: const TextStyle(fontWeight: FontWeight.w500)),
                            if (e.value.isRemote) ...[
                              const SizedBox(width: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(color: const Color(0xFF6366F1).withOpacity(0.12), borderRadius: BorderRadius.circular(4)),
                                child: const Text('Remote', style: TextStyle(fontSize: 11, color: Color(0xFF6366F1), fontWeight: FontWeight.w600)),
                              ),
                            ],
                          ]),
                          if (e.value.checkIn != null) Text('In:  ${_fmtFull(e.value.checkIn)}'),
                          if (e.value.checkOut != null) Text('Out: ${_fmtFull(e.value.checkOut)}'),
                          if (e.value.checkOut == null && e.value.missedCheckout)
                            const Text('Out: — missed (no check-out within 24 h)', style: TextStyle(color: Color(0xFFDC2626))),
                          if (e.value.durationMinutes != null) Text('Duration: ${e.value.durationMinutes! ~/ 60}h ${e.value.durationMinutes! % 60}m', style: const TextStyle(color: Colors.grey)),
                          if (e.value.checkInLocation != null) ...[
                            const SizedBox(height: 4),
                            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              const Icon(Icons.location_on_outlined, size: 14, color: Colors.grey),
                              const SizedBox(width: 4),
                              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                if (e.value.checkInAddress != null)
                                  Text(e.value.checkInAddress!, style: const TextStyle(fontSize: 12, color: Colors.grey))
                                else
                                  Text(
                                    '${e.value.checkInLocation!.latitude.toStringAsFixed(5)}, ${e.value.checkInLocation!.longitude.toStringAsFixed(5)}',
                                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                                  ),
                              ])),
                            ]),
                          ],
                        ]),
                      ),
                    )),
                  ],
                  const SizedBox(height: 16),
                  if (rec.isRegularized)
                    const Card(child: Padding(padding: EdgeInsets.all(12), child: Text('Regularization applied for this date.')))
                  else
                    Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Regularization', style: Theme.of(context).textTheme.titleSmall),
                      const SizedBox(height: 4),
                      const Text('No regularization for this date.', style: TextStyle(color: Colors.grey)),
                    ]))),
                  const SizedBox(height: 16),
                  if (!rec.isRegularized && _isWithinLookback(dateStr)) ...[
                    if (_hasMissedCheckout(rec))
                      OutlinedButton(
                        onPressed: () {
                          final missed = rec.sessions.firstWhere((s) => s.closedBySystem);
                          final ci = _isoToHHMM(missed.checkIn);
                          final uri = '${RouteNames.regularizationCreate}?type=forgotCheckOut&date=$dateStr'
                              '${ci != null ? '&checkIn=$ci' : ''}';
                          context.push(uri);
                        },
                        child: const Text('Apply Regularisation'),
                      )
                    else if (!_hasCompletedSession(rec) && rec.sessions.isEmpty && rec.status == 'absent')
                      OutlinedButton(
                        onPressed: () => context.push(RouteNames.leaveApply),
                        child: const Text('Apply Leave'),
                      ),
                  ],
                ] else ...[
                  const Center(child: Text('No attendance record for this date.')),
                  if (_isWithinLookback(dateStr) && !_isWeekend(dateStr)) ...[
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: () => context.push(RouteNames.leaveApply),
                      child: const Text('Apply Leave'),
                    ),
                  ],
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  bool _isWithinLookback(String dateStr) {
    try {
      final date = DateTime.parse(dateStr);
      return DateTime.now().difference(date).inDays <= 30;
    } catch (_) { return false; }
  }

  bool _isWeekend(String dateStr) {
    try {
      final date = DateTime.parse(dateStr);
      return date.weekday == DateTime.saturday || date.weekday == DateTime.sunday;
    } catch (_) { return false; }
  }

  // Session closed by system (midnight rollover) — no real employee checkout
  bool _hasMissedCheckout(AttendanceRecord rec) =>
      rec.sessions.any((s) => s.closedBySystem);

  // Session with a real employee checkout (employee checked out voluntarily)
  bool _hasCompletedSession(AttendanceRecord rec) =>
      rec.sessions.any((s) => !s.closedBySystem && s.checkOut != null);

  String? _isoToHHMM(String? iso) {
    if (iso == null) return null;
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return null;
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  String _fmtFull(String? iso) {
    if (iso == null) return '—';
    try {
      final dt = DateTime.parse(iso).toLocal();
      return DateFormat('hh:mm:ss a').format(dt);
    } catch (_) { return iso; }
  }
}
