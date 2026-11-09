class LeaveBalance {
  final String leaveType;
  final String leaveTypeName;
  final int entitled;
  final int used;
  final int remaining;
  final int carriedForward;
  final String? cfExpiryDate;

  const LeaveBalance({
    required this.leaveType,
    required this.leaveTypeName,
    required this.entitled,
    required this.used,
    required this.remaining,
    required this.carriedForward,
    this.cfExpiryDate,
  });

  factory LeaveBalance.fromJson(Map<String, dynamic> json) {
    return LeaveBalance(
      leaveType: json['leaveType'] as String? ?? '',
      leaveTypeName: json['leaveTypeName'] as String? ?? json['leaveType'] as String? ?? '',
      entitled: json['entitled'] as int? ?? 0,
      used: json['used'] as int? ?? 0,
      remaining: json['remaining'] as int? ?? 0,
      carriedForward: json['carriedForward'] as int? ?? 0,
      cfExpiryDate: json['cfExpiryDate'] as String?,
    );
  }
}

class LeaveRequest {
  final String id;
  final String employeeId;
  final String leaveType;
  final String startDate;
  final String endDate;
  final int days;
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
      // backend returns 'totalDays'; mobile schema uses 'days'
      days: (json['totalDays'] as int?) ?? json['days'] as int? ?? 1,
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
