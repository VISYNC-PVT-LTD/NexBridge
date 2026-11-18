class AttendanceCheckInLocation {
  final double latitude;
  final double longitude;
  const AttendanceCheckInLocation({required this.latitude, required this.longitude});

  factory AttendanceCheckInLocation.fromJson(Map<String, dynamic> json) {
    return AttendanceCheckInLocation(
      latitude: (json['latitude'] as num?)?.toDouble() ?? 0.0,
      longitude: (json['longitude'] as num?)?.toDouble() ?? 0.0,
    );
  }
}

class AttendanceSession {
  final String? checkIn;
  final String? checkOut;
  final int? durationMinutes;
  final AttendanceCheckInLocation? checkInLocation;
  final bool closedBySystem;
  final bool isRemote;
  final String? remoteSource;
  final String? checkInAddress;
  /// True when the session passed its 24-hour check-out window without a
  /// check-out. No punch-out exists for it (checkOut stays null).
  final bool missedCheckout;

  const AttendanceSession({
    this.checkIn,
    this.checkOut,
    this.durationMinutes,
    this.checkInLocation,
    this.closedBySystem = false,
    this.isRemote = false,
    this.remoteSource,
    this.checkInAddress,
    this.missedCheckout = false,
  });

  factory AttendanceSession.fromJson(Map<String, dynamic> json) {
    final locJson = json['checkInLocation'] as Map<String, dynamic>?;
    return AttendanceSession(
      checkIn: json['checkIn'] as String? ?? json['checkInTimestamp'] as String?,
      checkOut: json['checkOut'] as String? ?? json['checkOutTimestamp'] as String?,
      durationMinutes: json['durationMinutes'] as int?,
      checkInLocation: locJson != null ? AttendanceCheckInLocation.fromJson(locJson) : null,
      closedBySystem: json['closedBySystem'] as bool? ?? false,
      isRemote: json['isRemote'] as bool? ?? false,
      remoteSource: json['remoteSource'] as String?,
      checkInAddress: json['checkInAddress'] as String?,
      missedCheckout: json['missedCheckout'] as bool? ?? false,
    );
  }
}

class StaleSession {
  final String dateString;
  final String checkInTimestamp;

  const StaleSession({required this.dateString, required this.checkInTimestamp});

  factory StaleSession.fromJson(Map<String, dynamic> json) {
    return StaleSession(
      dateString: json['dateString'] as String? ?? '',
      checkInTimestamp: json['checkInTimestamp'] as String? ?? '',
    );
  }
}

class TodayAttendance {
  final String date;
  final String status;
  final bool isCheckedIn;
  final bool forgotCheckout;
  final StaleSession? staleSession;
  /// Every date whose missed check-out is still unresolved (server field
  /// `unresolvedMissedCheckoutDates`). There can be more than one.
  final List<String> unresolvedMissedCheckoutDates;
  final String? currentSessionStart;
  /// Company-local attendance date of the open session (server field
  /// `currentSession.dateString`). Earlier than [date] when the session began
  /// on a previous day; such time is not "today's" work.
  final String? currentSessionDate;
  /// checkIn + 24 h. At this instant the timer resets to 00:00:00 and the app
  /// re-syncs with the server (the session becomes a missed check-out).
  final String? currentSessionDeadline;
  final List<AttendanceSession> sessions;
  final int totalMinutesToday;

  const TodayAttendance({
    required this.date,
    required this.status,
    required this.isCheckedIn,
    this.forgotCheckout = false,
    this.staleSession,
    this.unresolvedMissedCheckoutDates = const [],
    this.currentSessionStart,
    this.currentSessionDate,
    this.currentSessionDeadline,
    required this.sessions,
    required this.totalMinutesToday,
  });

  /// Dates that need a "Missed check-out" banner, oldest first. Uses the full
  /// server list; falls back to the single stale session for older servers.
  List<String> get missedCheckoutDates {
    final dates = {...unresolvedMissedCheckoutDates.where((d) => d.isNotEmpty)};
    if (dates.isEmpty && forgotCheckout && (staleSession?.dateString.isNotEmpty ?? false)) {
      dates.add(staleSession!.dateString);
    }
    return dates.toList()..sort();
  }

  factory TodayAttendance.fromJson(Map<String, dynamic> json) {
    final staleJson = json['staleSession'] as Map<String, dynamic>?;
    return TodayAttendance(
      date: json['date'] as String? ?? '',
      status: json['status'] as String? ?? 'absent',
      isCheckedIn: json['isCheckedIn'] as bool? ?? false,
      forgotCheckout: json['forgotCheckout'] as bool? ?? false,
      staleSession: staleJson != null ? StaleSession.fromJson(staleJson) : null,
      unresolvedMissedCheckoutDates: (json['unresolvedMissedCheckoutDates'] as List<dynamic>?)
              ?.whereType<String>()
              .toList() ??
          const [],
      currentSessionStart: json['currentSessionStart'] as String?,
      currentSessionDate: json['currentSessionDate'] as String?,
      currentSessionDeadline: json['currentSessionDeadline'] as String?,
      sessions: (json['sessions'] as List<dynamic>?)
              ?.map((e) => AttendanceSession.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
      totalMinutesToday: json['totalMinutesToday'] as int? ?? 0,
    );
  }
}

class AttendanceRecord {
  final String id;
  final String employeeId;
  final String date;
  final String status;
  final String? checkIn;
  final String? checkOut;
  final double? workHours;
  /// Minutes credited for the day (employee history sends `totalMinutes`).
  final int? totalMinutes;
  final bool isRegularized;
  final List<AttendanceSession> sessions;
  /// A session of this day passed its 24-hour window without a check-out.
  final bool missedCheckout;
  /// ...and it has not yet been resolved by regularization or leave.
  final bool hasUnresolvedMissedCheckout;

  const AttendanceRecord({
    required this.id,
    required this.employeeId,
    required this.date,
    required this.status,
    this.checkIn,
    this.checkOut,
    this.workHours,
    this.totalMinutes,
    required this.isRegularized,
    this.sessions = const [],
    this.missedCheckout = false,
    this.hasUnresolvedMissedCheckout = false,
  });

  // The employee history endpoint (/attendance/history) sends dateString,
  // totalMinutes and per-session timestamps; the admin list sends date,
  // workHours and checkIn/checkOut. Regression: the app read only the admin
  // fields, so employee history always showed "Hours: 0.0h" and no times.
  factory AttendanceRecord.fromJson(Map<String, dynamic> json) {
    final sessions = (json['sessions'] as List<dynamic>?)
            ?.map((e) => AttendanceSession.fromJson(e as Map<String, dynamic>))
            .toList() ??
        <AttendanceSession>[];
    final totalMinutes = (json['totalMinutes'] as num?)?.toInt();
    final workHours = (json['workHours'] as num?)?.toDouble() ??
        (totalMinutes != null && totalMinutes > 0 ? (totalMinutes / 60 * 10).round() / 10 : null);
    return AttendanceRecord(
      id: json['_id'] as String? ?? json['id'] as String? ?? '',
      employeeId: _extractId(json['employeeId']),
      // history endpoint returns dateString; admin endpoint returns date
      date: json['date'] as String? ?? json['dateString'] as String? ?? '',
      status: json['status'] as String? ?? 'absent',
      checkIn: json['checkIn'] as String? ?? (sessions.isNotEmpty ? sessions.first.checkIn : null),
      checkOut: json['checkOut'] as String? ?? (sessions.isNotEmpty ? sessions.last.checkOut : null),
      workHours: workHours,
      totalMinutes: totalMinutes ?? (workHours != null ? (workHours * 60).round() : null),
      isRegularized: json['isRegularized'] as bool? ?? false,
      sessions: sessions,
      missedCheckout: json['missedCheckout'] as bool? ?? sessions.any((s) => s.missedCheckout),
      hasUnresolvedMissedCheckout: json['hasUnresolvedMissedCheckout'] as bool? ?? false,
    );
  }

  static String _extractId(dynamic value) {
    if (value is String) return value;
    if (value is Map) return value['_id'] as String? ?? '';
    return '';
  }
}

class MonthlySummary {
  final int presentDays;
  final int absentDays;
  final int leaveDays;
  final int halfDays;
  final int holidayDays;
  final int weekendDays;
  final double totalHours;

  const MonthlySummary({
    required this.presentDays,
    required this.absentDays,
    required this.leaveDays,
    required this.halfDays,
    required this.holidayDays,
    required this.weekendDays,
    required this.totalHours,
  });

  factory MonthlySummary.fromJson(Map<String, dynamic> json) {
    return MonthlySummary(
      presentDays: json['presentDays'] as int? ?? 0,
      absentDays: json['absentDays'] as int? ?? 0,
      leaveDays: json['leaveDays'] as int? ?? 0,
      halfDays: json['halfDays'] as int? ?? 0,
      holidayDays: json['holidayDays'] as int? ?? 0,
      weekendDays: json['weekendDays'] as int? ?? 0,
      totalHours: (json['totalHours'] as num?)?.toDouble() ?? 0.0,
    );
  }
}
