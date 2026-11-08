import bcrypt from 'bcryptjs';
import type { UserRole } from '@app-types/enums';
import { isAttendanceAdmin } from '@mw/requireRole';
import { randomBytes, createHash } from 'crypto';
import mongoose from 'mongoose';
import { connectDB } from '@lib/db/connect';
import { sha256 } from '@lib/utils/hash';
import { sendEmail } from '@lib/email/brevo';
import { User } from '@models/User';
import { Employee } from '@models/Employee';
import type { IEmployee } from '@models/Employee';
import { DeviceSession } from '@models/DeviceSession';
import { AuditLog } from '@models/AuditLog';
import { CompanySettings } from '@models/CompanySettings';
import { PasswordResetToken } from '@models/PasswordResetToken';
import { AppError } from '@services/AuthService';
import { NotificationService, logNotificationFailure } from '@services/NotificationService';
import { getAppUrl } from '@lib/utils/app-url';
import type { ILeaveBalances } from '@models/User';

// 12-char readable temp password (no confusable chars) — used internally only, not emailed
const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword(): string {
  return Array.from(randomBytes(12))
    .map((b) => TEMP_CHARS[b % TEMP_CHARS.length])
    .join('');
}

function welcomeEmailHtml(firstName: string, setupUrl: string): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
    <tr>
      <td style="background:#1d4ed8;padding:32px 40px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Genesis Workforce</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:40px;">
        <p style="margin:0 0 16px;color:#111827;font-size:16px;font-weight:600;">Hello ${firstName},</p>
        <p style="margin:0 0 16px;color:#6b7280;font-size:15px;line-height:1.7;">
          Welcome to Genesis Workforce. Your account has been created by your administrator.
        </p>
        <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.7;">
          Click the button below to set your password and activate your account.
          This link expires in <strong style="color:#374151;">24 hours</strong>.
        </p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${setupUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 36px;border-radius:6px;">
            Set Your Password
          </a>
        </div>
        <div style="background:#f9fafb;border-radius:6px;padding:16px;margin-top:8px;">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${setupUrl}" style="color:#1d4ed8;word-break:break-all;font-size:12px;">${setupUrl}</a>
          </p>
        </div>
        <hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
          If you were not expecting this invitation, please contact your administrator immediately.<br>
          Never share this link with anyone.
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#f9fafb;padding:16px 40px;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">© ${year} Genesis Workforce. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function computeLeaveYearBounds(
  refDate: Date,
  leaveYearStartMonth: number,
): { start: Date; end: Date } {
  const m = refDate.getMonth() + 1;
  const y = refDate.getFullYear();
  const startYear = m >= leaveYearStartMonth ? y : y - 1;
  return {
    start: new Date(startYear, leaveYearStartMonth - 1, 1),
    end: new Date(startYear + 1, leaveYearStartMonth - 1, 1),
  };
}

function computeProRatedBalances(
  dateOfJoining: Date,
  leaveYearStartMonth: number,
): ILeaveBalances {
  const now = new Date();
  const { start: lyStart, end: lyEnd } = computeLeaveYearBounds(now, leaveYearStartMonth);

  const effectiveStart = dateOfJoining > lyStart ? dateOfJoining : lyStart;

  if (effectiveStart >= lyEnd) {
    return {
      paidLeave: { currentYear: 0, carriedForward: 0 },
      sickLeave: { currentYear: 0, carriedForward: 0 },
      casualLeave: { currentYear: 0, carriedForward: 0 },
    };
  }

  const monthsElapsed =
    (effectiveStart.getFullYear() - lyStart.getFullYear()) * 12 +
    (effectiveStart.getMonth() - lyStart.getMonth());
  const monthsRemaining = Math.max(0, 12 - monthsElapsed);

  // Default annual allocations — superseded by Settings module (Phase 11)
  const annual = { paidLeave: 12, sickLeave: 8, casualLeave: 6 };
  const pr = (a: number) => Math.round(((a * monthsRemaining) / 12) * 2) / 2;

  return {
    paidLeave: { currentYear: pr(annual.paidLeave), carriedForward: 0 },
    sickLeave: { currentYear: pr(annual.sickLeave), carriedForward: 0 },
    casualLeave: { currentYear: pr(annual.casualLeave), carriedForward: 0 },
  };
}

function formatListItem(user: mongoose.Document & { toObject(): Record<string, unknown> }, isAdmin: boolean) {
  const u = user as unknown as {
    _id: mongoose.Types.ObjectId;
    employeeId: string;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    department?: string;
    designation?: string;
    monthlySalary: number;
    dateOfJoining: Date;
    isActive: boolean;
    registeredDevice: unknown;
  };
  const base: Record<string, unknown> = {
    id: u._id.toHexString(),
    employeeId: u.employeeId,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    role: u.role,
    department: u.department ?? null,
    designation: u.designation ?? null,
    dateOfJoining: u.dateOfJoining.toISOString().split('T')[0],
    isActive: u.isActive,
    hasRegisteredDevice: u.registeredDevice !== null,
  };
  if (isAdmin) base.monthlySalary = u.monthlySalary;
  return base;
}

function isMongooseDuplicateKey(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
}

function assertValidObjectId(id: string): void {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError('GEN_002', 404, 'Employee not found.');
}

export class EmployeeService {
  static async list(
    query: {
      page: number;
      limit: number;
      search?: string;
      department?: string;
      isActive?: boolean;
      sortBy: string;
      sortOrder: 'asc' | 'desc';
    },
    requesterRole: UserRole,
  ) {
    if (!isAttendanceAdmin(requesterRole)) throw new AppError('AUTH_006', 403, 'Forbidden.');

    await connectDB();

    const filter: Record<string, unknown> = {};
    if (query.search) {
      const rx = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { employeeId: rx }];
    }
    if (query.department !== undefined) filter.department = query.department;
    if (query.isActive !== undefined) filter.isActive = query.isActive;

    const sortDir = query.sortOrder === 'asc' ? 1 : -1;
    const sortField = query.sortBy;

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ [sortField]: sortDir })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return {
      data: users.map((u) => formatListItem(u as unknown as mongoose.Document & { toObject(): Record<string, unknown> }, true)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  static async create(
    data: {
      employeeId: string;
      firstName: string;
      lastName: string;
      email: string;
      role: UserRole;
      phone?: string;
      department?: string;
      designation?: string;
      monthlySalary: number;
      dateOfJoining: string;
      allowOutsideGeofence?: boolean;
    },
    createdBy: string,
  ) {
    await connectDB();

    // Fetch settings for leave year start month
    const settings = await CompanySettings.findById('company-settings').lean();
    const leaveYearStartMonth = (settings as { leaveYearStartMonth?: number } | null)?.leaveYearStartMonth ?? 1;

    const dateOfJoining = new Date(data.dateOfJoining);
    const leaveBalances = computeProRatedBalances(dateOfJoining, leaveYearStartMonth);
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    let user;
    try {
      user = await User.create({
        employeeId: data.employeeId.toUpperCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email.toLowerCase(),
        passwordHash,
        role: data.role,
        phone: data.phone,
        department: data.department,
        designation: data.designation,
        monthlySalary: data.monthlySalary,
        dateOfJoining,
        isActive: true,
        requiresPasswordChange: true,
        registeredDevice: null,
        leaveBalances,
        createdBy: new mongoose.Types.ObjectId(createdBy),
      });
    } catch (err) {
      if (isMongooseDuplicateKey(err)) throw new AppError('GEN_006', 409, 'email or employeeId already exists.');
      throw err;
    }

    // Create Employee (payroll profile) with same _id as User for consistent FK across APIs
    try {
      await Employee.create({
        _id: user._id,
        userId: user._id,
        employeeCode: data.employeeId.toUpperCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        department: data.department,
        designation: data.designation,
        joiningDate: dateOfJoining,
        monthlySalary: data.monthlySalary,
        status: 'active',
        ...(data.allowOutsideGeofence !== undefined && { allowOutsideGeofence: data.allowOutsideGeofence }),
      });
    } catch (empErr) {
      // Rollback: delete User so the operation is atomic from the caller's perspective
      await User.deleteOne({ _id: user._id });
      if (isMongooseDuplicateKey(empErr)) throw new AppError('GEN_006', 409, 'email or employeeId already exists.');
      throw empErr;
    }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(createdBy),
      action: 'EMPLOYEE_CREATED',
      targetType: 'User',
      targetId: (user._id as mongoose.Types.ObjectId).toHexString(),
      changes: { employeeId: data.employeeId, email: data.email },
    });

    // Generate one-time password setup token (24h expiry) — never email the password
    const rawInviteToken = randomBytes(32).toString('hex');
    const inviteTokenHash = createHash('sha256').update(rawInviteToken).digest('hex');
    const inviteExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await PasswordResetToken.create({
      userId: user._id,
      email: user.email,
      tokenHash: inviteTokenHash,
      expiresAt: inviteExpiresAt,
      ipAddress: 'system',
    });

    const setupUrl = `${getAppUrl()}/reset-password?token=${rawInviteToken}&email=${encodeURIComponent(user.email)}&setup=1`;

    try {
      await sendEmail({
        to: { email: user.email, name: `${user.firstName} ${user.lastName}` },
        subject: `Welcome to Genesis Workforce — Set your password`,
        htmlContent: welcomeEmailHtml(user.firstName, setupUrl),
      });
    } catch {
      // swallow — employee can be re-invited if email delivery fails
    }

    return {
      id: (user._id as mongoose.Types.ObjectId).toHexString(),
      employeeId: user.employeeId,
      email: user.email,
    };
  }

  static async resendSetupLink(id: string, adminId: string) {
    assertValidObjectId(id);
    await connectDB();

    const userId = new mongoose.Types.ObjectId(id);
    const user = await User.findById(userId).lean() as {
      _id: mongoose.Types.ObjectId;
      email: string;
      firstName: string;
      lastName: string;
      isActive: boolean;
    } | null;
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');
    if (!user.isActive) throw new AppError('GEN_003', 422, 'Cannot send setup link to an inactive employee.');

    // Invalidate all existing unused tokens so old email links no longer work
    await PasswordResetToken.updateMany(
      { userId, isUsed: false },
      { $set: { isUsed: true, usedAt: new Date() } },
    );

    const rawToken       = randomBytes(32).toString('hex');
    const tokenHash      = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt      = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await PasswordResetToken.create({ userId, email: user.email, tokenHash, expiresAt, ipAddress: 'system' });

    const setupUrl = `${getAppUrl()}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}&setup=1`;

    try {
      await sendEmail({
        to: { email: user.email, name: `${user.firstName} ${user.lastName}` },
        subject: `Genesis Workforce — Set your password`,
        htmlContent: welcomeEmailHtml(user.firstName, setupUrl),
      });
    } catch { /* swallow — admin can retry */ }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(adminId),
      action:      'EMPLOYEE_SETUP_LINK_RESENT',
      targetType:  'User',
      targetId:    id,
    });

    return { emailSent: true };
  }

  static async getById(id: string, requesterRole: UserRole) {
    if (!isAttendanceAdmin(requesterRole)) throw new AppError('AUTH_006', 403, 'Forbidden.');
    assertValidObjectId(id);
    await connectDB();

    const [user, employeeProfile] = await Promise.all([
      User.findById(id),
      Employee.findOne({ userId: new mongoose.Types.ObjectId(id) }).lean<IEmployee>(),
    ]);
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    return {
      id: (user._id as mongoose.Types.ObjectId).toHexString(),
      employeeId: user.employeeId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      phone: user.phone ?? null,
      department: user.department ?? null,
      designation: user.designation ?? null,
      monthlySalary: user.monthlySalary,
      dateOfJoining: user.dateOfJoining.toISOString().split('T')[0],
      dateOfLeaving: user.dateOfLeaving?.toISOString().split('T')[0] ?? null,
      isActive: user.isActive,
      hasRegisteredDevice: user.registeredDevice !== null,
      requiresPasswordChange: user.requiresPasswordChange,
      leaveBalances: user.leaveBalances,
      allowOutsideGeofence: employeeProfile?.allowOutsideGeofence ?? false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  static async update(
    id: string,
    data: {
      firstName?: string;
      lastName?: string;
      phone?: string | null;
      department?: string | null;
      designation?: string | null;
      monthlySalary?: number;
      salaryComponents?: { basic?: number; hra?: number; specialAllowance?: number; otherAllowances?: number };
      dateOfLeaving?: string | null;
      allowOutsideGeofence?: boolean;
    },
    performedBy: string,
  ) {
    assertValidObjectId(id);
    await connectDB();

    const user = await User.findById(id);
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};

    const track = (field: string, newVal: unknown, currentVal: unknown) => {
      if (newVal === null) {
        before[field] = currentVal;
        after[field] = null;
        $unset[field] = 1;
      } else if (newVal !== undefined) {
        before[field] = currentVal;
        after[field] = newVal;
        $set[field] = newVal;
      }
    };

    track('firstName', data.firstName, user.firstName);
    track('lastName', data.lastName, user.lastName);
    track('phone', data.phone, user.phone ?? null);
    track('department', data.department, user.department ?? null);
    track('designation', data.designation, user.designation ?? null);
    track('monthlySalary', data.monthlySalary, user.monthlySalary);

    if (data.dateOfLeaving !== undefined) {
      if (data.dateOfLeaving === null) {
        before.dateOfLeaving = user.dateOfLeaving?.toISOString().split('T')[0] ?? null;
        after.dateOfLeaving = null;
        $unset.dateOfLeaving = 1;
      } else {
        before.dateOfLeaving = user.dateOfLeaving?.toISOString().split('T')[0] ?? null;
        after.dateOfLeaving = data.dateOfLeaving;
        $set.dateOfLeaving = new Date(data.dateOfLeaving);
      }
    }

    const updateOp: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) updateOp.$set = $set;
    if (Object.keys($unset).length > 0) updateOp.$unset = $unset;

    const updated = await User.findByIdAndUpdate(id, updateOp, { new: true, runValidators: true });
    if (!updated) throw new AppError('GEN_002', 404, 'Employee not found.');

    if (data.allowOutsideGeofence !== undefined || data.salaryComponents !== undefined) {
      const empSet: Record<string, unknown> = {};
      if (data.allowOutsideGeofence !== undefined) {
        empSet.allowOutsideGeofence = data.allowOutsideGeofence;
        before.allowOutsideGeofence = !data.allowOutsideGeofence;
        after.allowOutsideGeofence = data.allowOutsideGeofence;
      }
      if (data.salaryComponents !== undefined) {
        empSet.salaryComponents = data.salaryComponents;
      }
      await Employee.findOneAndUpdate(
        { userId: new mongoose.Types.ObjectId(id) },
        {
          $set: { ...empSet },
          $setOnInsert: {
            employeeCode:  user.employeeId,
            firstName:     user.firstName,
            lastName:      user.lastName,
            joiningDate:   user.dateOfJoining,
            monthlySalary: user.monthlySalary ?? 0,
          },
        },
        { upsert: true },
      );
    }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(performedBy),
      action: 'EMPLOYEE_UPDATED',
      targetType: 'User',
      targetId: id,
      changes: { before, after },
    });

    const updatedEmployeeProfile = await Employee.findOne(
      { userId: new mongoose.Types.ObjectId(id) },
    ).lean<IEmployee>();

    return {
      id: (updated._id as mongoose.Types.ObjectId).toHexString(),
      employeeId: updated.employeeId,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      role: updated.role,
      phone: updated.phone ?? null,
      department: updated.department ?? null,
      designation: updated.designation ?? null,
      monthlySalary: updated.monthlySalary,
      dateOfJoining: updated.dateOfJoining.toISOString().split('T')[0],
      dateOfLeaving: updated.dateOfLeaving?.toISOString().split('T')[0] ?? null,
      isActive: updated.isActive,
      hasRegisteredDevice: updated.registeredDevice !== null,
      requiresPasswordChange: updated.requiresPasswordChange,
      leaveBalances: updated.leaveBalances,
      allowOutsideGeofence: updatedEmployeeProfile?.allowOutsideGeofence ?? false,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  static async activate(id: string, performedBy: string) {
    assertValidObjectId(id);
    await connectDB();

    const user = await User.findByIdAndUpdate(id, { $set: { isActive: true } }, { new: true });
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(performedBy),
      action: 'EMPLOYEE_REACTIVATED',
      targetType: 'User',
      targetId: id,
    });

    void NotificationService.create({
      employeeId:   user._id as mongoose.Types.ObjectId,
      type:         'accountActivated',
      title:        'Account Activated',
      body:         'Your account has been activated. You can now log in.',
      emailAddress: user.email,
      emailName:    `${user.firstName} ${user.lastName}`,
    }).catch(logNotificationFailure);

    return { message: 'Employee activated. They must log in fresh on each device.' };
  }

  static async deactivate(id: string, reason: string | undefined, performedBy: string) {
    assertValidObjectId(id);
    await connectDB();

    const user = await User.findById(id);
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        await User.updateOne(
          { _id: user._id },
          { $set: { isActive: false } },
          { session: mongoSession },
        );
        await DeviceSession.updateMany(
          { employeeId: user._id, isRevoked: false },
          { $set: { isRevoked: true, revokedAt: new Date(), revokedReason: 'admin-reset' } },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(performedBy),
      action: 'EMPLOYEE_DEACTIVATED',
      targetType: 'User',
      targetId: id,
      changes: reason ? { reason } : undefined,
    });

    void NotificationService.create({
      employeeId:   user._id as mongoose.Types.ObjectId,
      type:         'accountDeactivated',
      title:        'Account Deactivated',
      body:         `Your account has been deactivated.${reason ? ` Reason: ${reason}` : ''}`,
      emailAddress: user.email,
      emailName:    `${user.firstName} ${user.lastName}`,
    }).catch(logNotificationFailure);

    return { message: 'Employee deactivated. All sessions revoked.' };
  }

  static async registerDevice(
    id: string,
    deviceFingerprint: string,
    deviceName: string | undefined,
    performedBy: string,
    platform: 'ios' | 'android' = 'android',
  ) {
    assertValidObjectId(id);
    await connectDB();

    const fingerprintHash = sha256(deviceFingerprint);
    const now = new Date();
    const name = deviceName ?? 'Unknown device';

    const existing = await User.findById(id);
    if (!existing) throw new AppError('GEN_002', 404, 'Employee not found.');

    const updateOps: Record<string, unknown> = {
      $set: {
        registeredDevice: {
          fingerprintHash,
          registeredAt: now,
          deviceInfo: name,
          platform,
        },
      },
    };

    if (existing.registeredDevice) {
      (updateOps.$push as Record<string, unknown>) = {
        deviceHistory: {
          fingerprintHash: existing.registeredDevice.fingerprintHash,
          deviceName: existing.registeredDevice.deviceInfo,
          platform: existing.registeredDevice.platform,
          registeredAt: existing.registeredDevice.registeredAt,
          revokedAt: now,
          revokedBy: new mongoose.Types.ObjectId(performedBy),
          revokedReason: 'replacement',
        },
      };
    }

    await User.updateOne({ _id: id }, updateOps);

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(performedBy),
      action: 'DEVICE_REGISTERED',
      targetType: 'User',
      targetId: id,
      changes: { deviceName: name },
    });

    return { message: 'Device registered. Employee can now log in.' };
  }

  static async resetDevice(id: string, performedBy: string) {
    assertValidObjectId(id);
    await connectDB();

    const user = await User.findById(id);
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    const now = new Date();
    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        const updateOps: Record<string, unknown> = {
          $set: { registeredDevice: null },
        };

        if (user.registeredDevice) {
          (updateOps.$push as Record<string, unknown>) = {
            deviceHistory: {
              fingerprintHash: user.registeredDevice.fingerprintHash,
              deviceName: user.registeredDevice.deviceInfo,
              platform: user.registeredDevice.platform,
              registeredAt: user.registeredDevice.registeredAt,
              revokedAt: now,
              revokedBy: new mongoose.Types.ObjectId(performedBy),
              revokedReason: 'admin_reset',
            },
          };
        }

        await User.updateOne({ _id: user._id }, updateOps, { session: mongoSession });
        await DeviceSession.updateMany(
          { employeeId: user._id, isRevoked: false },
          { $set: { isRevoked: true, revokedAt: now, revokedReason: 'device-change' } },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(performedBy),
      action: 'DEVICE_REVOKED',
      targetType: 'User',
      targetId: id,
    });

    return { message: 'Device reset. All sessions revoked. Employee must re-register their device.' };
  }
}
