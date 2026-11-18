import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../../core/models/attendance.dart';
import '../../../../core/router/route_names.dart';
import '../../../../shared/widgets/loading_overlay.dart';
import '../../domain/attendance_display.dart';
import '../providers/attendance_provider.dart';

class WeeklyAttendanceScreen extends ConsumerStatefulWidget {
  const WeeklyAttendanceScreen({super.key});

  @override
  ConsumerState<WeeklyAttendanceScreen> createState() => _WeeklyAttendanceScreenState();
}

class _WeeklyAttendanceScreenState extends ConsumerState<WeeklyAttendanceScreen> {
  late DateTime _weekStart;

  @override
  void initState() {
    super.initState();
    _weekStart = _getMonday(DateTime.now());
  }

  DateTime _getMonday(DateTime d) => d.subtract(Duration(days: d.weekday - 1));

  bool get _isCurrentWeek {
    final thisMonday = _getMonday(DateTime.now());
    return _weekStart.isAtSameMomentAs(thisMonday);
  }

  List<DateTime> get _weekDays => List.generate(6, (i) => _weekStart.add(Duration(days: i)));

  String get _weekLabel {
    final end = _weekStart.add(const Duration(days: 5));
    final fmt = DateFormat('MMM d');
    return '${fmt.format(_weekStart)}–${end.day}';
  }

  @override
  Widget build(BuildContext context) {
    final startStr = DateFormat('yyyy-MM-dd').format(_weekStart);
    final endStr = DateFormat('yyyy-MM-dd').format(_weekStart.add(const Duration(days: 5)));
    final histAsync = ref.watch(attendanceHistoryProvider((startDate: startStr, endDate: endStr)));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance'),
        actions: [IconButton(icon: const Icon(Icons.list_alt), onPressed: () => context.push(RouteNames.attendanceHistory))],
      ),
      body: Column(
        children: [
          // Week navigator
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                IconButton(icon: const Icon(Icons.chevron_left), onPressed: () => setState(() => _weekStart = _weekStart.subtract(const Duration(days: 7)))),
                Expanded(child: Text(_weekLabel, textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w600))),
                IconButton(icon: const Icon(Icons.chevron_right), onPressed: _isCurrentWeek ? null : () => setState(() => _weekStart = _weekStart.add(const Duration(days: 7)))),
              ],
            ),
          ),
          histAsync.when(
            loading: () => const Expanded(child: Center(child: CircularProgressIndicator())),
            error: (_, __) => const Expanded(child: Center(child: Text('Could not load attendance. Pull to refresh.', style: TextStyle(color: Colors.grey)))),
            data: (records) {
              final byDate = {for (final r in records) r.date.substring(0, 10): r};
              return Expanded(
                child: RefreshIndicator(
                  onRefresh: () => ref.refresh(attendanceHistoryProvider((startDate: startStr, endDate: endStr)).future),
                  child: ListView(
                    children: [
                      // Week grid
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Row(
                          children: _weekDays.map((day) {
                            final key = DateFormat('yyyy-MM-dd').format(day);
                            final rec = byDate[key];
                            return Expanded(child: _DayCell(date: day, record: rec, onTap: () => context.push(RouteNames.attendanceDay(key))));
                          }).toList(),
                        ),
                      ),
                      const SizedBox(height: 16),
                      // Summary
                      _WeekSummary(records: records),
                      const Divider(),
                      // Daily list
                      ..._weekDays.map((day) {
                        final key = DateFormat('yyyy-MM-dd').format(day);
                        final rec = byDate[key];
                        return _DayListTile(date: day, record: rec, onTap: () => context.push(RouteNames.attendanceDay(key)));
                      }),
                    ],
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

class _DayCell extends StatelessWidget {
  const _DayCell({required this.date, this.record, required this.onTap});
  final DateTime date;
  final AttendanceRecord? record;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final (symbol, color) = _resolve(record?.status);
    final isFuture = date.isAfter(DateTime.now());

    return GestureDetector(
      onTap: isFuture ? null : onTap,
      child: Column(children: [
        Text(DateFormat('E').format(date)[0], style: const TextStyle(fontSize: 12, color: Colors.grey)),
        const SizedBox(height: 4),
        Container(
          width: 36, height: 36,
          decoration: BoxDecoration(
            border: Border.all(color: isFuture ? Colors.grey[300]! : color.withAlpha(128)),
            borderRadius: BorderRadius.circular(8),
            color: isFuture ? null : color.withAlpha(26),
          ),
          child: Center(child: Text(symbol, style: TextStyle(color: isFuture ? Colors.grey[300] : color, fontWeight: FontWeight.bold, fontSize: 13))),
        ),
        const SizedBox(height: 2),
        Text('${date.day}', style: const TextStyle(fontSize: 11)),
      ]),
    );
  }

  (String, Color) _resolve(String? status) => switch (status) {
    'present' => ('✓', const Color(0xFF16A34A)),
    'half_day' || 'half-day' => ('½', const Color(0xFFD97706)),
    'absent' => ('✗', const Color(0xFFDC2626)),
    'checked-in' => ('▶', const Color(0xFF2563EB)),
    'leave' => ('L', const Color(0xFF2563EB)),
    'holiday' => ('H', const Color(0xFF7C3AED)),
    'weekend' => ('—', const Color(0xFF9CA3AF)),
    _ => ('·', const Color(0xFFD1D5DB)),
  };
}

class _WeekSummary extends StatelessWidget {
  const _WeekSummary({required this.records});
  final List<AttendanceRecord> records;

  @override
  Widget build(BuildContext context) {
    final present = records.where((r) => r.status == 'present').length;
    final half = records.where((r) => r.status == 'half_day' || r.status == 'half-day').length;
    final leave = records.where((r) => r.status == 'leave').length;
    final absent = records.where((r) => r.status == 'absent').length;
    final totalHours = records.fold(0, (s, r) => s + (r.totalMinutes ?? 0)) / 60;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Week Summary', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              Text('Present: $present · Half: $half · Leave: $leave · Absent: $absent'),
              Text('Hours: ${totalHours.toStringAsFixed(1)}h'),
            ],
          ),
        ),
      ),
    );
  }
}

class _DayListTile extends StatelessWidget {
  const _DayListTile({required this.date, this.record, required this.onTap});
  final DateTime date;
  final AttendanceRecord? record;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isFuture = date.isAfter(DateTime.now());
    return ListTile(
      onTap: isFuture ? null : onTap,
      title: Text(DateFormat('EEE d MMM').format(date)),
      trailing: record != null
          ? StatusChip(status: record!.status)
          : Text(isFuture ? '' : '—', style: const TextStyle(color: Colors.grey)),
      subtitle: _subtitle(),
    );
  }

  Widget? _subtitle() {
    final r = record;
    if (r == null) return null;
    final now = DateTime.now();
    final text = historySubtitle(
      checkInIso: r.checkIn,
      checkOutIso: r.checkOut,
      totalMinutes: r.totalMinutes,
      missedCheckout: r.missedCheckout,
      unresolvedMissedCheckout: r.hasUnresolvedMissedCheckout,
      // Today's status is provisional until the day ends.
      isToday: date.year == now.year && date.month == now.month && date.day == now.day,
    );
    return text.isEmpty ? null : Text(text);
  }
}
