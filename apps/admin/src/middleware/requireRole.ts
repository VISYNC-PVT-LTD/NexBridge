import type { JwtPayload } from '@app-types/jwt';
import type { UserRole } from '@app-types/enums';
import { AuthError } from './requireAuth';

export function assertRole(payload: JwtPayload, ...roles: UserRole[]): void {
  if (!roles.includes(payload.role)) {
    throw new AuthError('AUTH_006', 403);
  }
}

/**
 * HR / attendance administrators (ATTENDANCE_ADMIN_ROLES): admin + super_admin.
 * Every other role — employee, manager, executive — may access only their OWN
 * attendance, leave, regularization and payroll records. No documented policy
 * grants managers/executives visibility of other employees' HR data; the
 * proxy page map already restricts HR pages to these two roles.
 */
export function isAttendanceAdmin(role: UserRole | string | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}

// Attendance/HR admin roles (backward compatible with existing assertRole('admin') calls)
export function assertAttendanceAdmin(payload: JwtPayload): void {
  assertRole(payload, 'admin', 'super_admin');
}

// Work Desk: super_admin, admin, manager, executive. employee role is Attendance-only.
export function assertWorkDeskAccess(payload: JwtPayload): void {
  assertRole(payload, 'super_admin', 'admin', 'manager', 'executive');
}
