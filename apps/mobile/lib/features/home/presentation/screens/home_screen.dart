import 'dart:async';
import '../../../attendance/domain/session_timer.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/constants/api_endpoints.dart';
import '../../../../core/di/providers.dart';
import '../../../../core/models/attendance.dart';
import '../../../../core/models/notification.dart';
import '../../../../core/router/route_names.dart';
import '../../../../shared/widgets/loading_overlay.dart';
import '../../../attendance/presentation/providers/attendance_provider.dart';
import '../../../auth/presentation/providers/auth_provider.dart';
import '../../../notifications/data/services/shift_reminder_service.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> with WidgetsBindingObserver {
  ({String shiftStart, String shiftEnd, int requiredDailyMinutes, int gracePeriodMinutes})? _shiftSettings;
  final _reminderService = ShiftReminderService();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _reconcile();
      await _loadShiftSettings();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _reconcile();
  }

  @override
  void dispose() {
    _reminderService.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _reconcile() async {
    try {
      await ref.read(attendanceProvider.notifier).reconcile();
    } catch (_) {
      // reconcile() captures errors into AsyncValue.error — this is a safety net
      // so pull-to-refresh and lifecycle callbacks never throw past Flutter's boundary
    }
  }

  Future<void> _loadShiftSettings() async {
    try {
      final dio = ref.read(dioProvider);
      final r = await dio.get(ApiEndpoints.attendanceShift);
      final data = (r.data as Map<String, dynamic>)['data'] as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _shiftSettings = (
            shiftStart: data['shiftStart'] as String? ?? '09:00',
            shiftEnd: data['shiftEnd'] as String? ?? '18:00',
            requiredDailyMinutes: data['requiredDailyMinutes'] as int? ?? CompanySettings.defaults.requiredDailyMinutes,
            gracePeriodMinutes: data['gracePeriodMinutes'] as int? ?? 0,
          );
        });
        _updateReminders(ref.read(checkInStateProvider));
      }
    } catch (_) {
      // Non-fatal — reminders unavailable if shift settings unreachable
    }
  }

  void _updateReminders(CheckInState state) {
    final settings = _shiftSettings;
    if (settings == null) return;

    if (state == CheckInState.checkedIn) {
      _reminderService.cancelCheckinReminder();
      final endParts = settings.shiftEnd.split(':');
      if (endParts.length == 2) {
        final endHH = int.tryParse(endParts[0]) ?? 18;
        final endMM = int.tryParse(endParts[1]) ?? 0;
        _reminderService.scheduleCheckoutReminder(shiftEndHH: endHH, shiftEndMM: endMM);
      }
    } else if (state == CheckInState.idle || state == CheckInState.checkedOutPartial) {
      _reminderService.cancelCheckoutReminder();
      final parts = settings.shiftStart.split(':');
      if (parts.length == 2) {
        final hh = int.tryParse(parts[0]) ?? 9;
        final mm = int.tryParse(parts[1]) ?? 0;
        _reminderService.scheduleCheckinReminder(shiftStartHH: hh, shiftStartMM: mm);
      }
    } else if (state == CheckInState.checkedOutComplete) {
      _reminderService.cancelAll();
    }
  }

  Future<void> _handleCheckIn() async {
    final notifier = ref.read(attendanceProvider.notifier);
    notifier.setGpsRequesting();

    LocationPermission permission;
    try {
      permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
    } catch (_) {
      notifier.setGpsRequesting();
      if (mounted) _showGpsSheet(_GpsError.permissionDenied);
      return;
    }

    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      if (mounted) _showGpsSheet(_GpsError.permissionDenied, permanent: permission == LocationPermission.deniedForever);
      return;
    }

    final isEnabled = await Geolocator.isLocationServiceEnabled();
    if (!isEnabled) {
      if (mounted) _showGpsSheet(_GpsError.disabled);
      return;
    }

    notifier.setGpsAcquiring();

    Position pos;
    try {
      pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
      ).timeout(const Duration(seconds: 15));
    } catch (_) {
      if (mounted) _showGpsSheet(_GpsError.noNetwork);
      return;
    }

    if (pos.accuracy > 100) {
      if (mounted) _showGpsSheet(_GpsError.lowAccuracy, accuracy: pos.accuracy);
      return;
    }

    try {
      await notifier.checkIn(lat: pos.latitude, lng: pos.longitude, accuracy: pos.accuracy);
    } catch (e) {
      if (!mounted) return;
      if (e is DioException) {
        final code = (e.response?.data as Map<String, dynamic>?)?['error']?['code'] as String? ?? '';
        if (code == 'ATT_001') {
          _showGpsSheet(_GpsError.outsideGeofence);
          return;
        }
        // ATT_009 = not on the approved office network (ATT_004 means the
        // request was a replay/duplicate and falls through to the server message).
        if (code == 'ATT_009') {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Check-in failed: you are not connected to the approved office network.'),
              duration: Duration(seconds: 5),
            ),
          );
          return;
        }
        if (e.type == DioExceptionType.connectionTimeout ||
            e.type == DioExceptionType.receiveTimeout ||
            e.type == DioExceptionType.sendTimeout ||
            e.type == DioExceptionType.connectionError) {
          _showGpsSheet(_GpsError.noNetwork);
          return;
        }
        final msg = (e.response?.data as Map<String, dynamic>?)?['error']?['message'] as String?;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg?.isNotEmpty == true ? msg! : 'Check-in failed. Please try again.')),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Check-in failed. Please try again.')),
        );
      }
    }
  }

  Future<void> _handleCheckOut() async {
    final today = ref.read(attendanceProvider).value;
    if (today?.isCheckedIn == true) {
      final elapsed = _calcElapsedMinutes(today);
      final requiredMinutes = _shiftSettings?.requiredDailyMinutes ?? CompanySettings.defaults.requiredDailyMinutes;
      final remaining = requiredMinutes - elapsed;
      if (remaining > 120) {
        final confirm = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: const Text('Checking Out Early?'),
            content: Text('You have ${_formatMinutes(remaining)} remaining today.'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('Keep Working'),
              ),
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: const Text('Check Out'),
              ),
            ],
          ),
        );
        if (confirm != true) return;
      }
    }

    try {
      await ref.read(attendanceProvider.notifier).checkOut();
    } catch (e) {
      if (!mounted) return;
      if (e is DioException) {
        final code = (e.response?.data as Map<String, dynamic>?)?['error']?['code'] as String? ?? '';
        if (code == 'ATT_001') {
          _showGpsSheet(_GpsError.outsideGeofence);
          return;
        }
        // ATT_011 = the 24-hour check-out window has passed (missed check-out).
        if (code == 'ATT_011') {
          final msg = (e.response?.data as Map<String, dynamic>?)?['error']?['message'] as String?;
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(msg ?? 'The 24-hour check-out window has passed. Please submit a regularization or leave request.'),
            duration: const Duration(seconds: 6),
          ));
          await ref.read(attendanceProvider.notifier).reconcile();
          return;
        }
                // ATT_010 = location is required to check out (GPS off/denied/unavailable).
        if (code == 'ATT_010') {
          final permission = await Geolocator.checkPermission();
          if (!mounted) return;
          if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
            _showGpsSheet(_GpsError.permissionDenied);
          } else {
            _showGpsSheet(_GpsError.disabled);
          }
          return;
        }
        if (code == 'ATT_002') {
          _showGpsSheet(_GpsError.lowAccuracy);
          return;
        }
        if (code == 'ATT_009') {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Check-out failed: you are not connected to the approved office network.'),
              duration: Duration(seconds: 5),
            ),
          );
          return;
        }
        final msg = (e.response?.data as Map<String, dynamic>?)?['error']?['message'] as String?;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg?.isNotEmpty == true ? msg! : 'Check-out failed. Please try again.')),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Check-out failed. Please try again.')),
        );
      }
    }
  }

  int _calcElapsedMinutes(TodayAttendance? today) {
    if (today?.currentSessionStart == null) return today?.totalMinutesToday ?? 0;
    final start = DateTime.tryParse(today!.currentSessionStart!)?.toLocal();
    if (start == null) return today.totalMinutesToday;
    if (missedCheckoutDeadlinePassed(today.currentSessionDeadline, DateTime.now())) {
      return today.totalMinutesToday; // 24-hour window over: no running time
    }
    return today.totalMinutesToday + DateTime.now().difference(start).inMinutes;
  }

  String? _isoToHHMM(String? iso) {
    if (iso == null) return null;
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return null;
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  String _formatMinutes(int minutes) {
    final h = minutes ~/ 60;
    final m = minutes % 60;
    return h > 0 ? '${h}h ${m}m' : '${m}m';
  }

  void _showGpsSheet(_GpsError error, {bool permanent = false, double? accuracy}) {
    showModalBottomSheet(
      context: context,
      builder: (_) => _GpsErrorSheet(error: error, permanent: permanent, accuracy: accuracy),
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);
    final attendanceAsync = ref.watch(attendanceProvider);
    final checkInState = ref.watch(checkInStateProvider);

    // React to checkInState changes for reminder scheduling
    ref.listen<CheckInState>(checkInStateProvider, (_, next) => _updateReminders(next));

    final now = DateTime.now();
    final hour = now.hour;
    final greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Genesis Workforce'),
        actions: [
          IconButton(
            icon: const Icon(Icons.notifications_outlined),
            onPressed: () => context.go(RouteNames.notifications),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _reconcile,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('$greeting, ${authState.user?.firstName ?? ''}!', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
              Text(_formatDate(now), style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey[600])),
              const SizedBox(height: 20),

              // Status card
              attendanceAsync.when(
                loading: () => const _ShimmerStatusCard(),
                error: (_, __) => _ErrorStatusCard(onRetry: () => ref.read(attendanceProvider.notifier).reconcile()),
                data: (today) => _StatusCard(
                  today: today,
                  checkInState: checkInState,
                  forgotCheckout: today?.forgotCheckout ?? false,
                  elapsedMinutes: _calcElapsedMinutes(today),
                  requiredDailyMinutes: _shiftSettings?.requiredDailyMinutes ?? CompanySettings.defaults.requiredDailyMinutes,
                  shiftStart: _shiftSettings?.shiftStart,
                  shiftEnd: _shiftSettings?.shiftEnd,
                  gracePeriodMinutes: _shiftSettings?.gracePeriodMinutes,
                ),
              ),
              const SizedBox(height: 16),

              // Elapsed timer — prominent above action button
              attendanceAsync.when(
                loading: () => const SizedBox.shrink(),
                error: (_, __) => const SizedBox.shrink(),
                data: (today) => _AttendanceTimerWidget(
                  sessionStart: today?.currentSessionStart,
                  deadline: today?.currentSessionDeadline,
                  isActive: checkInState == CheckInState.checkedIn,
                  // 24-hour deadline reached while the app is open: re-sync so
                  // the server records the missed check-out and the UI resets.
                  onDeadlineReached: () => ref.read(attendanceProvider.notifier).reconcile(),
                ),
              ),

              // Missed checkout banner — optional regularise, shown when stale session detected
              attendanceAsync.when(
                loading: () => const SizedBox.shrink(),
                error: (_, __) => const SizedBox.shrink(),
                data: (today) {
                  if (today == null) return const SizedBox.shrink();
                  // One banner per unresolved missed check-out date (there can be several).
                  final dates = today.missedCheckoutDates;
                  if (dates.isEmpty) return const SizedBox.shrink();
                  return Column(
                    children: [
                      for (final dateStr in dates)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: _MissedCheckoutBanner(
                            dateString: dateStr,
                            onRegularise: () {
                              final stale = today.staleSession;
                              // The check-in time is only known for the stale session's own date.
                              final ci = (stale != null && stale.dateString == dateStr && stale.checkInTimestamp.isNotEmpty)
                                  ? _isoToHHMM(stale.checkInTimestamp)
                                  : null;
                              final uri = '${RouteNames.regularizationCreate}?type=forgotCheckOut&date=$dateStr'
                                  '${ci != null ? '&checkIn=$ci' : ''}';
                              context.push(uri);
                            },
                          ),
                        ),
                    ],
                  );
                },
              ),

              // Action button
              attendanceAsync.when(
                loading: () => ElevatedButton(
                  onPressed: null,
                  child: const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
                ),
                error: (_, __) => const SizedBox.shrink(),
                data: (today) => _ActionButton(
                  checkInState: checkInState,
                  forgotCheckout: today?.forgotCheckout ?? false,
                  onCheckIn: _handleCheckIn,
                  onCheckOut: _handleCheckOut,
                  onRegularise: () {
                    final ci = _isoToHHMM(today?.currentSessionStart);
                    final uri = '${RouteNames.regularizationCreate}?type=forgotCheckOut&date=${today?.date ?? ''}'
                        '${ci != null ? '&checkIn=$ci' : ''}';
                    context.push(uri);
                  },
                ),
              ),
              const SizedBox(height: 20),

              // Today's sessions
              attendanceAsync.when(
                loading: () => const ShimmerListTile(),
                error: (_, __) => const SizedBox.shrink(),
                data: (today) {
                  if (today == null || today.sessions.isEmpty) return const SizedBox.shrink();
                  return _TodaysSessions(sessions: today.sessions);
                },
              ),

              const SizedBox(height: 20),
              Text('Quick Actions', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(child: OutlinedButton(onPressed: () => context.push(RouteNames.leaveApply), child: const Text('Apply Leave'))),
                const SizedBox(width: 12),
                Expanded(child: OutlinedButton(onPressed: () => context.push(RouteNames.regularization), child: const Text('My Reg.'))),
              ]),
              // "This Month" summary card intentionally removed: it showed
              // hard-coded placeholders ("—", "WFH 0") and was never wired to
              // data. Re-introduce it only with a real monthly-summary source.
            ],
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime d) {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return '${days[d.weekday - 1]}, ${d.day} ${months[d.month - 1]} ${d.year}';
  }
}

// ─── Attendance timer widget ────────────────────────────────────────────────

class _AttendanceTimerWidget extends StatefulWidget {
  const _AttendanceTimerWidget({required this.sessionStart, required this.isActive, this.deadline, this.onDeadlineReached});
  final String? sessionStart;
  final String? deadline;
  final bool isActive;
  final VoidCallback? onDeadlineReached;

  @override
  State<_AttendanceTimerWidget> createState() => _AttendanceTimerWidgetState();
}

class _AttendanceTimerWidgetState extends State<_AttendanceTimerWidget> {
  Timer? _timer;
  bool _deadlineNotified = false;

  @override
  void initState() {
    super.initState();
    if (widget.isActive) _startTimer();
  }

  @override
  void didUpdateWidget(_AttendanceTimerWidget old) {
    super.didUpdateWidget(old);
    if (widget.sessionStart != old.sessionStart) _deadlineNotified = false;
    if (widget.isActive && !old.isActive) _startTimer();
    if (!widget.isActive && old.isActive) _stopTimer();
  }

  @override
  void dispose() {
    _stopTimer();
    super.dispose();
  }

  void _startTimer() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (!_deadlineNotified && missedCheckoutDeadlinePassed(widget.deadline, DateTime.now())) {
        _deadlineNotified = true;
        widget.onDeadlineReached?.call();
      }
      setState(() {});
    });
  }

  void _stopTimer() {
    _timer?.cancel();
    _timer = null;
  }

  @override
  Widget build(BuildContext context) {
    final elapsed = sessionTimerElapsed(
      sessionStart: widget.sessionStart,
      deadline: widget.deadline,
      isActive: widget.isActive,
      now: DateTime.now(),
    );
    final running = widget.isActive && elapsed != Duration.zero;
    final timerColor = running ? const Color(0xFF16A34A) : Colors.grey[300];

    return Column(
      children: [
        Text(
          running ? 'Current session' : 'Session time',
          style: TextStyle(fontSize: 12, color: Colors.grey[600]),
        ),
        const SizedBox(height: 6),
        Text(
          formatSessionTimer(elapsed),
          style: TextStyle(
            fontSize: 38,
            fontWeight: FontWeight.bold,
            letterSpacing: 3,
            color: timerColor,
            fontFamily: 'monospace',
          ),
        ),
        const SizedBox(height: 16),
      ],
    );
  }
}

// ─── Status card ─────────────────────────────────────────────────────────────

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.today, required this.checkInState, required this.forgotCheckout, required this.elapsedMinutes, required this.requiredDailyMinutes, this.shiftStart, this.shiftEnd, this.gracePeriodMinutes});
  final TodayAttendance? today;
  final CheckInState checkInState;
  final bool forgotCheckout;
  final int elapsedMinutes;
  final int requiredDailyMinutes;
  final String? shiftStart;
  final String? shiftEnd;
  final int? gracePeriodMinutes;

  @override
  Widget build(BuildContext context) {
    final activeSession = today?.sessions.where((s) => s.checkOut == null).firstOrNull;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: switch (checkInState) {
          CheckInState.reconciling => const Center(child: CircularProgressIndicator()),
          CheckInState.checkedIn => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Container(width: 10, height: 10, decoration: const BoxDecoration(color: Color(0xFF16A34A), shape: BoxShape.circle)),
                  const SizedBox(width: 8),
                  const Text('Checked In', style: TextStyle(fontWeight: FontWeight.w600, color: Color(0xFF16A34A))),
                  if (activeSession?.isRemote == true) ...[
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(color: const Color(0xFF6366F1).withOpacity(0.12), borderRadius: BorderRadius.circular(4)),
                      child: const Text('Remote', style: TextStyle(fontSize: 11, color: Color(0xFF6366F1), fontWeight: FontWeight.w600)),
                    ),
                  ],
                ]),
                if (today?.currentSessionStart != null) ...[
                  const SizedBox(height: 4),
                  Text('Since ${_formatTime(today!.currentSessionStart!)}', style: const TextStyle(color: Colors.grey)),
                ],
                Builder(builder: (_) {
                  final addr = today?.sessions.where((s) => s.checkOut == null).firstOrNull?.checkInAddress;
                  if (addr == null) return const SizedBox.shrink();
                  return Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const Icon(Icons.location_on_outlined, size: 12, color: Colors.grey),
                      const SizedBox(width: 3),
                      Expanded(child: Text(addr, style: const TextStyle(fontSize: 11, color: Colors.grey))),
                    ]),
                  );
                }),
                const Divider(height: 16),
                if (elapsedMinutes < requiredDailyMinutes)
                  Text('${_fmtMin(requiredDailyMinutes - elapsedMinutes)} remaining', style: TextStyle(fontSize: 14, color: elapsedMinutes >= requiredDailyMinutes - 30 ? const Color(0xFF16A34A) : const Color(0xFFD97706)))
                else ...[
                  const Text('Shift completed', style: TextStyle(fontSize: 14, color: Color(0xFF16A34A))),
                  Text('Overtime: ${_fmtMin(elapsedMinutes - requiredDailyMinutes)}', style: const TextStyle(fontSize: 12, color: Colors.grey)),
                ],
                if (activeSession?.isRemote == true) ...[
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                    decoration: BoxDecoration(
                      color: const Color(0xFF6366F1).withOpacity(0.08),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: const Color(0xFF6366F1).withOpacity(0.25)),
                    ),
                    child: Row(children: [
                      const Icon(Icons.location_on_outlined, size: 14, color: Color(0xFF6366F1)),
                      const SizedBox(width: 6),
                      const Expanded(
                        child: Text(
                          'Remote session active. Location will be recorded periodically while checked in.',
                          style: TextStyle(fontSize: 11, color: Color(0xFF6366F1)),
                        ),
                      ),
                    ]),
                  ),
                ],
              ],
            ),
          CheckInState.checkedOutComplete => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  const Icon(Icons.check_circle, color: Color(0xFF16A34A), size: 18),
                  const SizedBox(width: 8),
                  const Text('Day Complete', style: TextStyle(fontWeight: FontWeight.w600, color: Color(0xFF16A34A))),
                ]),
                Text('${_fmtMin(today?.totalMinutesToday ?? 0)} recorded today'),
              ],
            ),
          CheckInState.checkedOutPartial => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  const Icon(Icons.circle_outlined, color: Color(0xFFD97706), size: 18),
                  const SizedBox(width: 8),
                  const Text('Partial Day', style: TextStyle(fontWeight: FontWeight.w600, color: Color(0xFFD97706))),
                ]),
                Text('${_fmtMin(today?.totalMinutesToday ?? 0)} recorded'),
                Text('${_fmtMin(requiredDailyMinutes - (today?.totalMinutesToday ?? 0))} remaining', style: const TextStyle(color: Color(0xFFD97706))),
              ],
            ),
          _ => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Container(width: 10, height: 10, decoration: BoxDecoration(color: Colors.grey[300], shape: BoxShape.circle)),
                  const SizedBox(width: 8),
                  Text('Not Checked In', style: TextStyle(fontWeight: FontWeight.w600, color: Colors.grey[600])),
                ]),
                if (shiftStart != null && shiftEnd != null) ...[
                  const SizedBox(height: 4),
                  Text('Shift: $shiftStart–$shiftEnd', style: TextStyle(color: Colors.grey[500])),
                ],
                Text('Required: ${_fmtMin(requiredDailyMinutes)} today', style: TextStyle(color: Colors.grey[500])),
                if (shiftStart != null && gracePeriodMinutes != null && gracePeriodMinutes! > 0)
                  Text('On-time until: ${_onTimeDeadline(shiftStart!, gracePeriodMinutes!)}', style: TextStyle(color: Colors.grey[500])),
              ],
            ),
        },
      ),
    );
  }

  String _fmtMin(int m) => '${m ~/ 60}h ${m % 60}m';

  String _onTimeDeadline(String shiftStart, int graceMinutes) {
    try {
      final parts = shiftStart.split(':');
      final totalMin = int.parse(parts[0]) * 60 + int.parse(parts[1]) + graceMinutes;
      final h = totalMin ~/ 60;
      final m = totalMin % 60;
      return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';
    } catch (_) { return shiftStart; }
  }
  String _formatTime(String iso) {
    try {
      final dt = DateTime.parse(iso).toLocal();
      return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) { return iso; }
  }
}

// ─── Missed checkout banner ───────────────────────────────────────────────────

class _MissedCheckoutBanner extends StatelessWidget {
  const _MissedCheckoutBanner({required this.onRegularise, this.dateString});
  final VoidCallback onRegularise;
  final String? dateString;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFBEB),
        border: Border.all(color: const Color(0xFFFCD34D)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: Color(0xFFD97706), size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Missed check-out', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFF92400E))),
                const SizedBox(height: 2),
                Text(
                  'No check-out was recorded within 24 hours${dateString != null && dateString!.isNotEmpty ? ' for $dateString' : ''}. '
                  'That day is marked absent until you submit a regularization (with your actual check-out time) or a leave request for that date.',
                  style: const TextStyle(fontSize: 12, color: Color(0xFF92400E)),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          TextButton(
            onPressed: onRegularise,
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              foregroundColor: const Color(0xFFD97706),
              textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
            ),
            child: const Text('Regularise'),
          ),
        ],
      ),
    );
  }
}

// ─── Action button ────────────────────────────────────────────────────────────

class _ActionButton extends StatelessWidget {
  const _ActionButton({required this.checkInState, required this.forgotCheckout, required this.onCheckIn, required this.onCheckOut, required this.onRegularise});
  final CheckInState checkInState;
  final bool forgotCheckout;
  final VoidCallback onCheckIn;
  final VoidCallback onCheckOut;
  final VoidCallback onRegularise;

  @override
  Widget build(BuildContext context) {
    return switch (checkInState) {
      CheckInState.gpsRequesting || CheckInState.gpsAcquiring || CheckInState.submitting =>
        ElevatedButton(onPressed: null, child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)), const SizedBox(width: 10), Text(checkInState == CheckInState.submitting ? 'CHECKING IN…' : 'GETTING LOCATION…')])),
      CheckInState.checkoutSubmitting =>
        ElevatedButton(style: ElevatedButton.styleFrom(backgroundColor: Colors.red), onPressed: null, child: const Text('CHECKING OUT…')),
      CheckInState.checkedIn =>
        ElevatedButton(style: ElevatedButton.styleFrom(backgroundColor: Colors.red), onPressed: onCheckOut, child: const Text('CHECK OUT')),
      CheckInState.checkedOutPartial =>
        ElevatedButton(style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFD97706)), onPressed: onCheckIn, child: const Text('CHECK IN AGAIN')),
      CheckInState.checkedOutComplete =>
        ElevatedButton(style: ElevatedButton.styleFrom(backgroundColor: Colors.grey), onPressed: null, child: const Text('DAILY HOURS COMPLETE')),
      _ =>
        ElevatedButton(onPressed: onCheckIn, child: const Text('CHECK IN')),
    };
  }
}

// ─── Sessions list ────────────────────────────────────────────────────────────

class _TodaysSessions extends StatelessWidget {
  const _TodaysSessions({required this.sessions});
  final List<AttendanceSession> sessions;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text("Today's Sessions", style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        ...sessions.asMap().entries.map((e) => Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
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
                Text('In: ${_fmt(e.value.checkIn)} · Out: ${e.value.checkOut != null ? _fmt(e.value.checkOut) : '—'}'),
                if (e.value.durationMinutes != null) Text('Duration: ${e.value.durationMinutes! ~/ 60}h ${e.value.durationMinutes! % 60}m', style: const TextStyle(color: Colors.grey)),
              ],
            ),
          ),
        )),
      ],
    );
  }

  String _fmt(String? iso) {
    if (iso == null) return '—';
    try {
      final dt = DateTime.parse(iso).toLocal();
      return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) { return iso; }
  }
}

// ─── Shimmer / error cards ────────────────────────────────────────────────────

class _ShimmerStatusCard extends StatelessWidget {
  const _ShimmerStatusCard();
  @override
  Widget build(BuildContext context) => const Card(child: Padding(padding: EdgeInsets.all(16), child: Column(children: [ShimmerBox(width: double.infinity, height: 16), SizedBox(height: 8), ShimmerBox(width: 160, height: 14)])));
}

class _ErrorStatusCard extends StatelessWidget {
  const _ErrorStatusCard({this.onRetry});
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('Unable to load attendance.\nCheck your connection and try again.', textAlign: TextAlign.center),
          if (onRetry != null) ...[
            const SizedBox(height: 8),
            TextButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh, size: 16), label: const Text('Retry')),
          ],
        ],
      ),
    ),
  );
}

// ─── GPS error sheet ──────────────────────────────────────────────────────────

enum _GpsError { permissionDenied, disabled, lowAccuracy, outsideGeofence, noNetwork }

class _GpsErrorSheet extends StatelessWidget {
  const _GpsErrorSheet({required this.error, this.permanent = false, this.accuracy});
  final _GpsError error;
  final bool permanent;
  final double? accuracy;

  @override
  Widget build(BuildContext context) {
    final (title, body, primary, onPrimary) = switch (error) {
      _GpsError.permissionDenied => ('Location Permission Required', permanent ? "Go to Settings → Permissions → Location and select 'Allow while using app'." : 'This app needs location access to verify your workplace when you check in or out.', 'Open Settings', () async { await Geolocator.openAppSettings(); if (context.mounted) Navigator.pop(context); }),
      _GpsError.disabled => ('Location Services Disabled', 'Enable Location Services in your Android settings to check in or out.', 'Open Location Settings', () async { await Geolocator.openLocationSettings(); if (context.mounted) Navigator.pop(context); }),
      _GpsError.lowAccuracy => ('Poor GPS Signal', 'GPS accuracy: ${accuracy?.toStringAsFixed(0) ?? '?'}m (need < 100m)\n\nTry: Move near a window, enable Wi-Fi for network location, or wait for GPS signal.', 'Try Again', () => Navigator.pop(context)),
      _GpsError.outsideGeofence => ('Outside Office Location', "You're outside the required office radius. Use 'Request Work Away' if you are working away from the office today.", 'Try Again', () => Navigator.pop(context)),
      _GpsError.noNetwork => ('No Internet Connection', 'Checking in or out requires an internet connection to verify your location.', 'Retry', () => Navigator.pop(context)),
    };

    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 12),
          Text(body),
          const SizedBox(height: 20),
          Row(children: [
            Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel'))),
            const SizedBox(width: 12),
            Expanded(child: ElevatedButton(onPressed: onPrimary, child: Text(primary))),
          ]),
          if (error == _GpsError.outsideGeofence) ...[
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: () {
                  Navigator.pop(context);
                  final today = DateTime.now();
                  final dateStr = '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
                  context.push('${RouteNames.regularizationCreate}?type=workAwayFromOffice&date=$dateStr');
                },
                child: const Text('Request Work Away'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
