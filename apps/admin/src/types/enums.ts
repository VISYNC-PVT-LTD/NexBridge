export type DayStatus =
  | 'present'
  | 'absent'
  | 'half-day'
  | 'leave'
  | 'holiday'
  | 'weekend'
  | 'lwp'
  | 'not-applicable';

// Mirrors models/Leave.ts status enum.
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'revoked' | 'withdrawn';

export type RegularizationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export type RegularizationType =
  | 'forgotCheckIn'
  | 'forgotCheckOut'
  | 'workAwayFromOffice'
  | 'officialTravel'
  | 'clientVisit';

export type PayrollStatus = 'draft' | 'finalised';

export type UserRole = 'admin' | 'employee' | 'super_admin' | 'manager' | 'executive';

export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

// Mirrors models/Leave.ts leaveType enum (what /api/v1/leaves returns).
export type LeaveTypeCode = 'paidLeave' | 'sickLeave' | 'casualLeave' | 'lwp';

export const LEAVE_TYPE_LABELS: Record<LeaveTypeCode, string> = {
  paidLeave: 'Paid Leave',
  sickLeave: 'Sick Leave',
  casualLeave: 'Casual Leave',
  lwp: 'Leave Without Pay',
};

export function leaveTypeLabel(code: string): string {
  return (LEAVE_TYPE_LABELS as Record<string, string>)[code] ?? code;
}
