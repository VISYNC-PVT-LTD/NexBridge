import 'package:intl/intl.dart';

class RegularizationRequest {
  final String id;
  final String employeeId;
  final String date;
  final String type;
  final String reason;
  final String status;
  final String? requestedCheckIn;
  final String? requestedCheckOut;
  final String? reviewedBy;
  final String? reviewedAt;
  final String? reviewRemark;
  final String createdAt;

  const RegularizationRequest({
    required this.id,
    required this.employeeId,
    required this.date,
    required this.type,
    required this.reason,
    required this.status,
    this.requestedCheckIn,
    this.requestedCheckOut,
    this.reviewedBy,
    this.reviewedAt,
    this.reviewRemark,
    required this.createdAt,
  });

  bool get isCancellable => status == 'pending';
  bool get isWfh => type == 'wfh';
  bool get isMissedPunch => type == 'missed_punch';

  factory RegularizationRequest.fromJson(Map<String, dynamic> json) {
    return RegularizationRequest(
      id: json['_id'] as String? ?? '',
      employeeId: _extractId(json['employeeId']),
      date: json['date'] as String? ?? '',
      type: json['type'] as String? ?? '',
      reason: json['reason'] as String? ?? '',
      status: json['status'] as String? ?? 'pending',
      requestedCheckIn: json['requestedCheckIn'] as String?,
      requestedCheckOut: json['requestedCheckOut'] as String?,
      reviewedBy: _extractIdNullable(json['reviewedBy']),
      reviewedAt: json['reviewedAt'] as String?,
      reviewRemark: json['reviewRemark'] as String?,
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

/// Readable label for an API regularization type. The list and detail
/// screens used to show the raw code upper-cased (e.g. "CLIENTVISIT").
/// Same labels as the create screen.
const regularizationTypeLabels = <String, String>{
  'forgotCheckIn': 'Forgot Check-In',
  'forgotCheckOut': 'Forgot Check-Out',
  'workAwayFromOffice': 'Work Away From Office',
  'officialTravel': 'Official Travel',
  'clientVisit': 'Client Visit',
};

String regularizationTypeLabel(String type) => regularizationTypeLabels[type] ?? type;

/// Requested check-in/check-out instants are ISO-8601 UTC strings; show them
/// in the phone's local time (e.g. "08 Nov, 18:30") instead of the raw value.
String formatRequestedTime(String iso) {
  final t = DateTime.tryParse(iso);
  if (t == null) return iso;
  return DateFormat('dd MMM, HH:mm').format(t.toLocal());
}
