import type { DayStatus, LeaveStatus, RegularizationStatus, RegularizationType, PayrollStatus, UserRole, LeaveTypeCode } from './enums';

export interface Employee {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  department?: string | null;
  designation?: string | null;
  role: UserRole;
  isActive: boolean;
  requiresPasswordChange: boolean;
  monthlySalary?: number;
  dateOfJoining: string;
  dateOfLeaving?: string | null;
  hasRegisteredDevice?: boolean;
  allowOutsideGeofence?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceRecord {
  _id: string;
  employeeId: string | Employee;
  date: string;
  status: DayStatus;
  checkIn?: string;
  checkOut?: string;
  workHours?: number;
  isRegularized: boolean;
  /** A session on this day missed its 24-hour check-out window (no punch-out recorded). */
  missedCheckout?: boolean;
  hasUnresolvedMissedCheckout?: boolean;
  isCheckedIn?: boolean;
  createdAt: string;
}

export interface LeaveRequest {
  _id: string;
  employeeId: string | Employee;
  leaveType: LeaveTypeCode;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: LeaveStatus;
  reviewedBy?: string | Employee;
  reviewedAt?: string;
  reviewRemark?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegularizationRequest {
  _id: string;
  employeeId: string | Employee;
  date: string;
  type: RegularizationType;
  reason: string;
  status: RegularizationStatus;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reviewedBy?: string | Employee;
  reviewedAt?: string;
  reviewRemark?: string;
  attendanceDayId?: string | null;
  withdrawnAt?: string | null;
  createdAt: string;
}

export interface PayrollRecord {
  id: string;
  employeeId: string | Employee;
  yearMonth: string;
  status: PayrollStatus;
  // UI/mobile aliases (returned by formatRecord)
  workingDays: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  halfDays: number;
  lopDays: number;
  grossSalary: number;
  netSalary: number;
  deductions: number;
  earnings: Record<string, number>;
  isStale: boolean;
  // Internal names also returned
  effectiveWorkingDays: number;
  effectivePresentDays: number;
  effectiveLwpDays: number;
  paidLeaveDays: number;
  halfDayLwpDays: number;
  perDaySalary: number;
  lateMarkCount?: number;
  halfDayDeductionDays?: number;
  deductionBreakdown: {
    lwpDeduction: number;
    absentDeduction: number;
    halfDayDeduction?: number;
    manualDeduction: number;
    totalDeductions: number;
  };
  manualDeduction: number;
  manualDeductionRemark: string;
  employeeSnapshot: {
    firstName: string;
    lastName: string;
    employeeId: string;
    department?: string;
    designation?: string;
    monthlySalary: number;
  };
  computedAt: string;
  finalisedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  _id: string;
  userId: string;
  title: string;
  body: string;
  isRead: boolean;
  type: string;
  referenceId?: string;
  createdAt: string;
}

export interface Settings {
  company: {
    name: string;
    address?: string;
    timezone: string;
    currency: string;
  };
  workingDays: string[];
  shift: {
    startTime: string;
    endTime: string;
    gracePeriodMinutes: number;
  };
  geofence?: {
    lat: number;
    lng: number;
    radiusMeters: number;
    enabled: boolean;
  };
  attendanceValidation?: {
    mode: 'geofence' | 'officeIp';
    allowedOfficeIps: string[];
  };
  payrollRules?: {
    halfDayAggregationCount: number;
  };
}

export interface DeviceRequestItem {
  _id: string;
  userId: string;
  email: string;
  fingerprintHash: string;
  deviceName: string;
  manufacturer: string;
  deviceModel: string;
  androidVersion: string;
  appVersion: string;
  buildNumber: string;
  timezone: string;
  language: string;
  screenResolution: string;
  batteryLevel?: number;
  requestIp: string;
  platform: 'android' | 'ios';
  status: 'pending' | 'approved' | 'rejected';
  type: 'first_device' | 'replacement';
  requestedAt: string;
  expiresAt: string;
  reviewedAt?: string;
  approvalNote?: string;
  rejectionReason?: string;
  requestCount: number;
}

export interface RegisteredDeviceItem {
  fingerprintHash: string;
  registeredAt: string;
  deviceInfo: string;
  platform: 'android' | 'ios';
}

export interface DeviceHistoryItem {
  fingerprintHash: string;
  deviceName: string;
  platform: 'android' | 'ios';
  registeredAt: string;
  revokedAt?: string;
  revokedReason: 'manual_revocation' | 'replacement' | 'admin_reset';
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ErrorBody {
  code: string;
  message: string;
}
