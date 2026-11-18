import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:uuid/uuid.dart';
import '../../../../core/di/providers.dart';
import '../../../../core/models/attendance.dart';
import '../../../../core/models/notification.dart';
import '../../data/sources/attendance_remote_source.dart';

final attendanceSourceProvider = Provider<AttendanceRemoteSource>((ref) {
  return AttendanceRemoteSource(ref.watch(dioProvider));
});

// Separate StateProvider so every checkInState transition triggers a reactive rebuild,
// independently of whether TodayAttendance data itself changed.
final checkInStateProvider = StateProvider<CheckInState>((ref) => CheckInState.reconciling);

enum CheckInState { reconciling, idle, gpsRequesting, gpsAcquiring, submitting, checkedIn, checkoutSubmitting, checkedOutPartial, checkedOutComplete }

class AttendanceNotifier extends StateNotifier<AsyncValue<TodayAttendance?>> {
  final AttendanceRemoteSource _source;
  final CompanySettings settings;
  final Ref _ref;
  CheckInState _checkInState = CheckInState.reconciling;
  Timer? _syncTimer;
  Timer? _locationTimer;

  AttendanceNotifier(this._source, this.settings, this._ref) : super(const AsyncValue.loading());

  CheckInState get checkInState => _checkInState;

  void _setCheckInState(CheckInState s) {
    _checkInState = s;
    _ref.read(checkInStateProvider.notifier).state = s;
  }

  Future<void> reconcile() async {
    _setCheckInState(CheckInState.reconciling);
    try {
      final today = await _source.getToday();
      state = AsyncValue.data(today);
      _refreshHistoryIfChanged(today);
      _resolveState(today);
    } catch (e) {
      state = AsyncValue.error(e, StackTrace.current);
      _setCheckInState(CheckInState.idle);
    }
  }

  String? _lastHistoryKey;

  /// History is cached per date range; refetch it whenever the server's view
  /// of attendance changes (check-in/out, 24-hour cutoff, an approved
  /// regularization or leave). Regression: after the cutoff, History still
  /// showed the missed day as "Active" until the app was restarted.
  void _refreshHistoryIfChanged(TodayAttendance today) {
    final key = attendanceHistoryKey(today);
    if (_lastHistoryKey != null && _lastHistoryKey != key) {
      _ref.invalidate(attendanceHistoryProvider);
    }
    _lastHistoryKey = key;
  }

  void _resolveState(TodayAttendance today) {
    if (today.isCheckedIn) {
      _setCheckInState(CheckInState.checkedIn);
      _startSyncTimer();
      final activeSession = today.sessions.where((s) => s.checkOut == null).firstOrNull;
      if (activeSession?.isRemote == true) {
        _startLocationTracking();
      } else {
        _stopLocationTracking();
      }
    } else {
      _stopSyncTimer();
      _stopLocationTracking();
      if (today.sessions.isNotEmpty) {
        final threshold = settings.requiredDailyMinutes - 30;
        _setCheckInState(today.totalMinutesToday >= threshold
            ? CheckInState.checkedOutComplete
            : CheckInState.checkedOutPartial);
      } else {
        _setCheckInState(CheckInState.idle);
      }
    }
  }

  void setGpsRequesting() => _setCheckInState(CheckInState.gpsRequesting);
  void setGpsAcquiring() => _setCheckInState(CheckInState.gpsAcquiring);

  Future<void> checkIn({required double lat, required double lng, required double accuracy}) async {
    _setCheckInState(CheckInState.submitting);
    try {
      final nonce = const Uuid().v4();
      final today = await _source.checkIn(lat: lat, lng: lng, accuracy: accuracy, nonce: nonce);
      state = AsyncValue.data(today);
      _refreshHistoryIfChanged(today);
      _resolveState(today);
    } catch (e) {
      _setCheckInState(CheckInState.idle);
      rethrow;
    }
  }

  Future<void> checkOut() async {
    _setCheckInState(CheckInState.checkoutSubmitting);
    try {
      // Attempt GPS for geofence validation; non-fatal if unavailable (office IP mode doesn't need it).
      double? lat, lng, acc;
      try {
        final permission = await Geolocator.checkPermission();
        if (permission != LocationPermission.denied && permission != LocationPermission.deniedForever) {
          if (await Geolocator.isLocationServiceEnabled()) {
            final pos = await Geolocator.getCurrentPosition(
              locationSettings: const LocationSettings(
                accuracy: LocationAccuracy.high,
                timeLimit: Duration(seconds: 10),
              ),
            );
            lat = pos.latitude;
            lng = pos.longitude;
            acc = pos.accuracy;
          }
        }
      } catch (_) {
        // GPS unavailable — backend validates IP mode regardless
      }
      final today = await _source.checkOut(latitude: lat, longitude: lng, accuracy: acc);
      _stopSyncTimer();
      _stopLocationTracking();
      state = AsyncValue.data(today);
      _refreshHistoryIfChanged(today);
      _resolveState(today);
    } catch (e) {
      _setCheckInState(CheckInState.checkedIn);
      rethrow;
    }
  }

  // --- location tracking ---

  void _startLocationTracking() {
    if (_locationTimer != null) return; // already running
    _sendLocationSnapshot(); // immediate snapshot
    _locationTimer = Timer.periodic(const Duration(minutes: 60), (_) => _sendLocationSnapshot());
  }

  void _stopLocationTracking() {
    _locationTimer?.cancel();
    _locationTimer = null;
  }

  Future<void> _sendLocationSnapshot() async {
    try {
      final permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) return;
      if (!await Geolocator.isLocationServiceEnabled()) return;
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 20),
        ),
      );
      final snapshotSource = _ref.read(locationSnapshotSourceProvider);
      await snapshotSource.post(
        latitude: pos.latitude,
        longitude: pos.longitude,
        accuracy: pos.accuracy,
      );
    } catch (_) {
      // Silent — snapshot failure must not surface to employee or crash state
    }
  }

  // --- sync timer ---

  void _startSyncTimer() {
    _syncTimer?.cancel();
    _syncTimer = Timer.periodic(const Duration(minutes: 5), (_) async {
      try {
        await reconcile();
      } catch (_) {}
    });
  }

  void _stopSyncTimer() {
    _syncTimer?.cancel();
    _syncTimer = null;
  }

  @override
  void dispose() {
    _stopSyncTimer();
    _stopLocationTracking();
    super.dispose();
  }
}

final attendanceProvider = StateNotifierProvider<AttendanceNotifier, AsyncValue<TodayAttendance?>>((ref) {
  final source = ref.watch(attendanceSourceProvider);
  return AttendanceNotifier(source, CompanySettings.defaults, ref);
});

/// What, in today's status, means previously fetched history may be stale.
String attendanceHistoryKey(TodayAttendance t) => [
      t.date,
      t.status,
      t.isCheckedIn,
      t.totalMinutesToday,
      t.currentSessionStart ?? '',
      t.sessions.length,
      t.missedCheckoutDates.join(','),
    ].join('|');

final attendanceHistoryProvider = FutureProvider.family<List<AttendanceRecord>, ({String? startDate, String? endDate})>((ref, params) async {
  final source = ref.watch(attendanceSourceProvider);
  return source.getHistory(startDate: params.startDate, endDate: params.endDate);
});
