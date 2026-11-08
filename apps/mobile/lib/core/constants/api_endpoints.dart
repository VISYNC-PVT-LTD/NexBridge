class ApiEndpoints {
  static const String baseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:3000');
  static const String apiPrefix = '/api/v1';

  static const String login = '/api/v1/auth/login';
  static const String logout = '/api/v1/auth/logout';
  static const String refresh = '/api/v1/auth/refresh';
  static const String me = '/api/v1/auth/me';
  static const String changePassword = '/api/v1/auth/me/change-password';
  static const String fcmToken = '/api/v1/notifications/fcm-token';
  static const String forgotPassword = '/api/v1/auth/password-reset/request';
  static const String resetPassword = '/api/v1/auth/password-reset/confirm';

  static const String checkIn = '/api/v1/attendance/checkin';
  static const String checkOut = '/api/v1/attendance/checkout';
  static const String attendanceToday = '/api/v1/attendance/today';
  static const String attendanceStatus = '/api/v1/attendance/status';
  static const String attendanceHistory = '/api/v1/attendance/history';
  static const String attendanceShift = '/api/v1/attendance/shift';
  static String attendanceEmployee(String employeeId) => '/api/v1/attendance/$employeeId';

  static const String leaves = '/api/v1/leaves';
  static const String leaveBalance = '/api/v1/leaves/balance';
  static String leaveById(String id) => '/api/v1/leaves/$id';
  static String leaveCancel(String id) => '/api/v1/leaves/$id/cancel';

  static const String regularizations = '/api/v1/regularizations';
  static String regularizationById(String id) => '/api/v1/regularizations/$id';
  // Server contract: PATCH /api/v1/regularizations/:id/withdraw (there is no /cancel route).
  static String regularizationWithdraw(String id) => '/api/v1/regularizations/$id/withdraw';

  static const String notifications = '/api/v1/notifications';
  static String notificationRead(String id) => '/api/v1/notifications/$id/read';
  static const String notificationsReadAll = '/api/v1/notifications/read-all';

  static const String payrollMe = '/api/v1/payroll/me';
  static String payslipById(String yearMonth) => '/api/v1/payroll/me/$yearMonth';

  static const String settings = '/api/v1/settings';

  static const String deviceRequest = '/api/v1/auth/device-request';
  static const String deviceRequestStatus = '/api/v1/auth/device-request/status';

  static const String locationSnapshot = '/api/v1/attendance/location-snapshot';
}
