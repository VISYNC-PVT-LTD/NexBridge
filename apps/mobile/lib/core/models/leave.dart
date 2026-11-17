/// One leave type's balance exactly as GET /api/v1/leaves/balance reports it
/// (LeaveService.getBalance): `currentYear` is what is LEFT of this year's
/// allocation, `carriedForward` the still-valid carry-forward, and `total` what
/// can be taken now. The API has no entitlement or "used" figure, so the app
/// shows none. Values are days and may be fractional (pro-rated allocations,
/// half-day leave), so they are kept as doubles — never truncated.
class LeaveBalance {
  final String leaveType;
  final String leaveTypeName;
  final double currentYear;
  final double carriedForward;
  final double available;
  final String? cfExpiryDate;

  const LeaveBalance({
    required this.leaveType,
    required this.leaveTypeName,
    required this.currentYear,
    required this.carriedForward,
    required this.available,
    this.cfExpiryDate,
  });

  /// [json] is one entry of the balance response, e.g. `data.sickLeave`.
  factory LeaveBalance.fromApi(String leaveType, String leaveTypeName, Map<String, dynamic> json) {
    final currentYear = _days(json['currentYear']) ?? 0;
    final carriedForward = _days(json['carriedForward']) ?? 0;
    return LeaveBalance(
      leaveType: leaveType,
      leaveTypeName: leaveTypeName,
      currentYear: currentYear,
      carriedForward: carriedForward,
      available: _days(json['total']) ?? currentYear + carriedForward,
      cfExpiryDate: json['carryForwardExpiry'] as String?,
    );
  }
}

double? _days(dynamic v) => v is num ? v.toDouble() : (v is String ? double.tryParse(v) : null);

/// A day count for display: whole values without a decimal ("2"), fractional
/// values as they are ("0.5", "1.5"). Rounded to 2 decimals so floating-point
/// noise (e.g. 1.4999999) never reaches the screen.
String formatLeaveDays(num value) {
  final r = (value * 100).round() / 100;
  return r == r.truncateToDouble() ? r.toInt().toString() : r.toString();
}

/// "1 day", "0.5 days", "2 days"; "—" when the API did not report a duration.
String leaveDurationLabel(double? days) {
  if (days == null) return '—';
  return days == 1 ? '1 day' : '${formatLeaveDays(days)} days';
}

class LeaveRequest {
  final String id;
  final String employeeId;
  final String leaveType;
  final String startDate;
  final String endDate;
  /// Requested duration in days (0.5 for a half day); null if not reported.
  final double? days;
  final String reason;
  final String status;
  final String? reviewedBy;
  final String? reviewedAt;
  final String? reviewRemark;
  final String createdAt;

  const LeaveRequest({
    required this.id,
    required this.employeeId,
    required this.leaveType,
    required this.startDate,
    required this.endDate,
    required this.days,
    required this.reason,
    required this.status,
    this.reviewedBy,
    this.reviewedAt,
    this.reviewRemark,
    required this.createdAt,
  });

  bool get isCancellable => status == 'pending';

  factory LeaveRequest.fromJson(Map<String, dynamic> json) {
    return LeaveRequest(
      // backend returns 'id'; some legacy paths use '_id'
      id: json['id'] as String? ?? json['_id'] as String? ?? '',
      employeeId: _extractId(json['employeeId']),
      leaveType: json['leaveType'] as String? ?? '',
      startDate: json['startDate'] as String? ?? '',
      endDate: json['endDate'] as String? ?? '',
      // backend returns 'totalDays' (0.5 for a half day); legacy shape 'days'.
      // Previously `as int?` threw on 0.5 and a missing value became 1.
      days: _days(json['totalDays']) ?? _days(json['days']),
      reason: json['reason'] as String? ?? '',
      status: json['status'] as String? ?? 'pending',
      reviewedBy: _extractIdNullable(json['reviewedBy']),
      reviewedAt: json['reviewedAt'] as String?,
      // backend returns 'reviewRemarks'; mobile schema uses 'reviewRemark'
      reviewRemark: json['reviewRemark'] as String? ?? json['reviewRemarks'] as String?,
      createdAt: json['createdAt'] as String? ?? '',
    );
  }

  static String _extractId(dynamic value) {
    if (value is String) return value;
    if (value is Map) return value['_id'] as String? ?? '';
    return '';
  }

  static String? _extractIdNullable(dynamic value) {
    if (value == null) return null;
    if (value is String) return value;
    if (value is Map) return value['_id'] as String?;
    return null;
  }
}

/// Human label for an API leave type code (the API returns codes such as
/// 'paidLeave'; the app used to show them verbatim).
String leaveTypeLabel(String code) => const {
      'paidLeave': 'Paid Leave',
      'sickLeave': 'Sick Leave',
      'casualLeave': 'Casual Leave',
      'lwp': 'Leave Without Pay',
    }[code] ??
    code;
