import mongoose from 'mongoose';
import type { UserRole } from '@app-types/enums';
import { isAttendanceAdmin } from '@mw/requireRole';
import { connectDB } from '@lib/db/connect';
import { getLeaveYearBoundaries, dateRange, weekdayOf } from '@lib/utils/leaveUtils';
import { AppError } from '@services/AuthService';
import { User } from '@models/User';
import { CompanySettings } from '@models/CompanySettings';
import { Leave } from '@models/Leave';
import { LeaveTransaction } from '@models/LeaveTransaction';
import { Holiday } from '@models/Holiday';
import { AttendanceDay } from '@models/AttendanceDay';
import { AttendanceSession } from '@models/AttendanceSession';
import { PayrollRecord } from '@models/PayrollRecord';
import { AuditLog } from '@models/AuditLog';
import { NotificationService, logNotificationFailure } from '@services/NotificationService';
import type { ICompanySettings } from '@models/CompanySettings';
import type { ILeave, LeaveType, HalfDayPeriod } from '@models/Leave';
import type { IUser, ILeaveTypeBalance } from '@models/User';
import type { LeaveListQuery } from '@validators/leave';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function effectiveBalance(bal: ILeaveTypeBalance, now = new Date()): number {
  const cfValid = bal.carryForwardExpiry && bal.carryForwardExpiry > now;
  return bal.currentYear + (cfValid ? bal.carriedForward : 0);
}

function deductionSplit(
  bal: ILeaveTypeBalance,
  totalDays: number,
  now = new Date(),
): { fromCf: number; fromCy: number } {
  const cfValid = bal.carryForwardExpiry && bal.carryForwardExpiry > now;
  const cfAvail = cfValid ? bal.carriedForward : 0;
  const fromCf  = Math.min(cfAvail, totalDays);
  const fromCy  = totalDays - fromCf;
  return { fromCf, fromCy };
}

function formatLeave(leave: ILeave & { _id: mongoose.Types.ObjectId }, employeeName?: string) {
  return {
    id:          leave._id.toHexString(),
    employeeId:  leave.employeeId.toHexString(),
    employeeName: employeeName ?? null,
    leaveType:   leave.leaveType,
    duration:    leave.duration,
    halfDayPeriod: leave.halfDayPeriod ?? null,
    startDate:   leave.startDate.toISOString().slice(0, 10),
    endDate:     leave.endDate.toISOString().slice(0, 10),
    totalDays:   leave.totalDays,
    affectedDates: leave.affectedDates,
    status:      leave.status,
    leaveYear:   leave.leaveYear,
    reason:      leave.reason ?? null,
    reviewRemarks:    leave.reviewRemarks ?? null,
    reviewedBy:       leave.reviewedBy?.toHexString() ?? null,
    reviewedAt:       leave.reviewedAt?.toISOString() ?? null,
    revocationReason: leave.revocationReason ?? null,
    revokedBy:        leave.revokedBy?.toHexString() ?? null,
    revokedAt:        leave.revokedAt?.toISOString() ?? null,
    withdrawalReason: leave.withdrawalReason ?? null,
    withdrawnBy:      leave.withdrawnBy?.toHexString() ?? null,
    withdrawnAt:      leave.withdrawnAt?.toISOString() ?? null,
    createdAt:   leave.createdAt.toISOString(),
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class LeaveService {

  // ─── Apply ──────────────────────────────────────────────────────────────────

  static async apply(params: {
    employeeId: string;
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    duration: 'full' | 'half';
    halfDayPeriod?: HalfDayPeriod;
    reason?: string;
  }) {
    await connectDB();

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    if (!settings) throw new AppError('GEN_004', 500, 'Company settings not configured.');

    const now       = new Date();
    const todayStr  = now.toISOString().slice(0, 10);

    if (params.startDate < todayStr) {
      // Narrow exception (docs/85): a past working day may be covered by leave
      // ONLY to resolve an unresolved 24-hour missed check-out, within the
      // regularization lookback window. Everything else stays forbidden.
      const lookbackDays = settings.regularizationLookbackDays ?? 30;
      const oldestAllowed = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
      if (params.endDate >= todayStr || params.startDate < oldestAllowed) {
        throw new AppError('GEN_001', 400, 'Leave cannot be applied for past dates.');
      }
      const pastDates = dateRange(new Date(params.startDate + 'T00:00:00Z'), new Date(params.endDate + 'T00:00:00Z'));
      const workingPast = pastDates.filter((d) =>
        new Set((settings.workingDays ?? ['monday','tuesday','wednesday','thursday','friday']) as string[]).has(weekdayOf(d)));
      const missedDays = await AttendanceDay.countDocuments({
        employeeId: new mongoose.Types.ObjectId(params.employeeId),
        dateString: { $in: workingPast },
        hasUnresolvedMissedCheckout: true,
      });
      if (workingPast.length === 0 || missedDays !== workingPast.length) {
        throw new AppError('GEN_001', 400, 'Leave cannot be applied for past dates (except to resolve a missed check-out).');
      }
    }
    if (params.endDate < params.startDate) {
      throw new AppError('GEN_001', 400, 'endDate must be >= startDate.');
    }

    const startDateObj = new Date(params.startDate + 'T00:00:00Z');
    const endDateObj   = new Date(params.endDate   + 'T00:00:00Z');

    // Compute affectedDates — exclude weekends and holidays (BR-LVE-01)
    const allDates   = dateRange(startDateObj, endDateObj);
    const workingSet = new Set((settings.workingDays ?? ['monday','tuesday','wednesday','thursday','friday']) as string[]);

    const workingDatesInRange = allDates.filter(d => workingSet.has(weekdayOf(d)));

    if (workingDatesInRange.length === 0) {
      throw new AppError('LVE_004', 422, 'All requested dates fall on non-working days (weekends).');
    }

    // Check holidays
    const holidays = await Holiday.find({ dateString: { $in: workingDatesInRange } }).lean();
    const holidaySet = new Set(holidays.map((h: { dateString: string }) => h.dateString));
    const affectedDates = workingDatesInRange.filter(d => !holidaySet.has(d));

    if (affectedDates.length === 0) {
      // Some were weekends (removed), remaining are all holidays
      if (workingDatesInRange.every(d => holidaySet.has(d))) {
        throw new AppError('LVE_003', 422, 'All requested dates fall on public holidays.');
      }
      throw new AppError('LVE_003', 422, 'All requested dates fall on public holidays.');
    }

    const totalDays = params.duration === 'half' ? 0.5 : affectedDates.length;

    // Compute leaveYear (BR-LVE-05)
    const { leaveYear } = getLeaveYearBoundaries(startDateObj, settings.leaveYearStartMonth ?? 1);

    // Balance check for non-LWP (BR-LVE-04)
    if (params.leaveType !== 'lwp') {
      const user = await User.findById(params.employeeId).lean() as IUser | null;
      if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');
      const bal = user.leaveBalances[params.leaveType as keyof typeof user.leaveBalances];
      if (!bal || effectiveBalance(bal, now) < totalDays) {
        throw new AppError('LVE_001', 422, 'Insufficient leave balance.');
      }
    }

    // Overlap check — any affectedDate with existing pending/approved leave (BR-LVE-03)
    const overlap = await Leave.findOne({
      employeeId: new mongoose.Types.ObjectId(params.employeeId),
      status: { $in: ['pending', 'approved'] },
      affectedDates: { $in: affectedDates },
    }).lean();
    if (overlap) throw new AppError('LVE_002', 409, 'Dates overlap with an existing leave request.');

    // Create leave request (BR-LVE-06: balance NOT deducted here)
    const leave = await Leave.create({
      employeeId:    new mongoose.Types.ObjectId(params.employeeId),
      leaveType:     params.leaveType,
      duration:      params.duration,
      halfDayPeriod: params.halfDayPeriod,
      startDate:     startDateObj,
      endDate:       endDateObj,
      totalDays,
      leaveYear,
      reason:        params.reason ?? '',
      status:        'pending',
      affectedDates,
    });

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(params.employeeId),
      action:      'LEAVE_APPLIED',
      targetType:  'Leave',
      targetId:    (leave._id as mongoose.Types.ObjectId).toHexString(),
    });

    void NotificationService.notifyAllAdmins({
      type:          'leaveSubmitted',
      title:         'New Leave Request',
      body:          `An employee has submitted a ${params.leaveType} leave request for ${params.startDate}.`,
      referenceType: 'leaveRequest',
      referenceId:   leave._id as mongoose.Types.ObjectId,
    }).catch(logNotificationFailure);

    return {
      id:            (leave._id as mongoose.Types.ObjectId).toHexString(),
      leaveType:     leave.leaveType,
      duration:      leave.duration,
      halfDayPeriod: leave.halfDayPeriod ?? null,
      startDate:     params.startDate,
      endDate:       params.endDate,
      totalDays:     leave.totalDays,
      affectedDates: leave.affectedDates,
      status:        'pending',
      leaveYear:     leave.leaveYear,
      createdAt:     leave.createdAt.toISOString(),
    };
  }

  // ─── List ───────────────────────────────────────────────────────────────────

  static async list(params: { actorId: string; role: UserRole } & LeaveListQuery) {
    await connectDB();

    const filter: Record<string, unknown> = {};

    // Only HR admins (admin/super_admin) may list other employees' leave;
    // employee/manager/executive are always scoped to their own records.
    if (!isAttendanceAdmin(params.role)) {
      filter['employeeId'] = new mongoose.Types.ObjectId(params.actorId);
    } else if (params.employeeId) {
      filter['employeeId'] = new mongoose.Types.ObjectId(params.employeeId);
    }

    if (params.status)    filter['status']    = params.status;
    if (params.leaveType) filter['leaveType'] = params.leaveType;
    if (params.leaveYear) filter['leaveYear'] = params.leaveYear;
    if (params.startDate) filter['startDate'] = { $gte: new Date(params.startDate + 'T00:00:00Z') };
    if (params.endDate)   filter['endDate']   = { ...(filter['endDate'] as object ?? {}), $lte: new Date(params.endDate + 'T23:59:59Z') };

    const skip  = (params.page - 1) * params.limit;
    const sort: Record<string, 1 | -1> = { [params.sortBy]: params.sortBy === 'status' ? 1 : -1 };

    const [leaves, total] = await Promise.all([
      Leave.find(filter).sort(sort).skip(skip).limit(params.limit).lean() as unknown as Promise<(ILeave & { _id: mongoose.Types.ObjectId })[]>,
      Leave.countDocuments(filter),
    ]);

    // Batch-fetch employee names for admin
    const empIds = [...new Set(leaves.map((l: { employeeId: mongoose.Types.ObjectId }) => l.employeeId.toHexString()))];
    let nameMap: Record<string, string> = {};
    if (isAttendanceAdmin(params.role) && empIds.length > 0) {
      const users = await User.find({ _id: { $in: empIds } }, 'firstName lastName').lean() as unknown as Array<{ _id: mongoose.Types.ObjectId; firstName: string; lastName: string }>;
      nameMap = Object.fromEntries(users.map(u => [u._id.toHexString(), `${u.firstName} ${u.lastName}`]));
    }

    return {
      data: leaves.map((l: ILeave & { _id: mongoose.Types.ObjectId }) =>
        formatLeave(l, nameMap[l.employeeId.toHexString()])),
      pagination: {
        page:       params.page,
        limit:      params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  // ─── Get by ID ──────────────────────────────────────────────────────────────

  static async getById(leaveId: string, actorId: string, role: UserRole) {
    await connectDB();

    if (!mongoose.isValidObjectId(leaveId)) throw new AppError('GEN_002', 404, 'Leave request not found.');
    const leave = await Leave.findById(leaveId).lean() as (ILeave & { _id: mongoose.Types.ObjectId }) | null;
    if (!leave) throw new AppError('GEN_002', 404, 'Leave request not found.');

    if (!isAttendanceAdmin(role) && leave.employeeId.toHexString() !== actorId) {
      throw new AppError('AUTH_006', 403, 'Access denied.');
    }

    return formatLeave(leave);
  }

  // ─── Cancel ─────────────────────────────────────────────────────────────────

  static async cancel(leaveId: string, employeeId: string) {
    await connectDB();

    const leave = await Leave.findById(leaveId) as (ILeave & { _id: mongoose.Types.ObjectId }) | null;
    if (!leave) throw new AppError('GEN_002', 404, 'Leave request not found.');

    if (leave.employeeId.toHexString() !== employeeId) {
      throw new AppError('AUTH_006', 403, 'Access denied.');
    }
    if (leave.status !== 'pending') {
      throw new AppError('LVE_007', 422, 'Only pending leave requests can be cancelled.');
    }

    // Conditional update — an approval racing with the cancel wins cleanly.
    const cancelled = await Leave.findOneAndUpdate(
      { _id: leave._id, employeeId: leave.employeeId, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { new: true },
    );
    if (!cancelled) throw new AppError('LVE_007', 422, 'Only pending leave requests can be cancelled.');

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(employeeId),
      action:      'LEAVE_CANCELLED',
      targetType:  'Leave',
      targetId:    leave._id.toHexString(),
    });

    return { id: leave._id.toHexString(), status: 'cancelled' };
  }

  // ─── Approve ────────────────────────────────────────────────────────────────

  static async approve(leaveId: string, adminId: string) {
    await connectDB();

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    if (!settings) throw new AppError('GEN_004', 500, 'Company settings not configured.');

    const leave = await Leave.findById(leaveId).lean() as (ILeave & { _id: mongoose.Types.ObjectId }) | null;
    if (!leave) throw new AppError('GEN_002', 404, 'Leave request not found.');
    if (leave.status !== 'pending') throw new AppError('LVE_005', 422, 'Only pending leave requests can be approved.');

    const now = new Date();
    const { leaveYear, totalDays, leaveType, employeeId, affectedDates, duration } = leave;

    // Read fresh user balance (race-condition protection)
    const user = await User.findById(employeeId).lean() as IUser | null;
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    let balanceAfterCy  = 0;
    let balanceAfterCf  = 0;
    let deductFromCy    = 0;
    let deductFromCf    = 0;

    if (leaveType !== 'lwp') {
      const bal = user.leaveBalances[leaveType as keyof IUser['leaveBalances']];
      if (effectiveBalance(bal, now) < totalDays) {
        throw new AppError('LVE_001', 422, 'Insufficient leave balance.');
      }
      const split = deductionSplit(bal, totalDays, now);
      deductFromCf = split.fromCf;
      deductFromCy = split.fromCy;
      balanceAfterCy = bal.currentYear - deductFromCy;
      balanceAfterCf = bal.carriedForward - deductFromCf;
    }

    const warnings: string[] = [];
    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        // Atomic state claim (pending → approved): concurrent duplicate
        // requests cannot both apply balance/attendance changes.
        const claimed = await Leave.findOneAndUpdate(
          { _id: leave._id, status: 'pending' },
          { $set: { status: 'approved', reviewedBy: new mongoose.Types.ObjectId(adminId), reviewedAt: now } },
          { session: mongoSession, new: true },
        );
        if (!claimed) throw new AppError('LVE_005', 422, 'Only pending leave requests can be approved.');

        // Atomic balance deduction — $gte prevents underflow (BR-LVE-13)
        if (leaveType !== 'lwp') {
          const balancePath = `leaveBalances.${leaveType}`;
          const filter: Record<string, unknown> = {
            _id: employeeId,
            [`${balancePath}.currentYear`]:  { $gte: deductFromCy },
          };
          if (deductFromCf > 0) {
            filter[`${balancePath}.carriedForward`] = { $gte: deductFromCf };
          }
          const updated = await User.findOneAndUpdate(
            filter,
            {
              $inc: {
                [`${balancePath}.currentYear`]:  -deductFromCy,
                [`${balancePath}.carriedForward`]: -deductFromCf,
              },
            },
            { session: mongoSession, new: false },
          );
          if (!updated) throw new AppError('LVE_001', 422, 'Insufficient leave balance (concurrent update).');

          await LeaveTransaction.create([{
            employeeId,
            leaveType,
            leaveYear,
            transactionType: 'deduction-approval',
            days:   -totalDays,
            balanceAfterCurrentYear:    balanceAfterCy,
            balanceAfterCarriedForward: balanceAfterCf,
            referenceType: 'leaveRequest',
            referenceId:   leave._id,
            performedBy:   new mongoose.Types.ObjectId(adminId),
            timestamp:     now,
          }], { session: mongoSession });
        }

        // Update AttendanceDay.status for all affectedDates (BR-LVE-13)
        const dayStatus = duration === 'half' ? 'half-day' : 'leave';
        for (const dateStr of affectedDates) {
          await AttendanceDay.findOneAndUpdate(
            { employeeId, dateString: dateStr },
            {
              $set: {
                status:             dayStatus,
                leaveRequestId:     leave._id,
                leaveType,
                leaveDuration:      duration,
                leaveHalfDayPeriod: leave.halfDayPeriod,
                // Approved leave resolves a 24-hour missed check-out on this day.
                hasUnresolvedMissedCheckout: false,
              },
              $setOnInsert: {
                date:           new Date(dateStr + 'T00:00:00Z'),
                year:           Number(dateStr.slice(0, 4)),
                month:          Number(dateStr.slice(5, 7)),
                totalMinutes:   0,
                requiredMinutes: settings.requiredDailyMinutes ?? 540,
                overtimeMinutes: 0,
                isLateArrival:  false,
                lateByMinutes:  0,
                isHalfDayCapped: false,
                isRegularized:  false,
              },
            },
            { upsert: true, session: mongoSession },
          );

          // Check for active attendance session — warning only (BR-LVE-14)
          const activeSession = await AttendanceSession.findOne(
            { employeeId, dateString: dateStr, isActive: true },
          ).session(mongoSession).lean();
          if (activeSession) {
            warnings.push(`Employee is currently checked in on ${dateStr}. Attendance session preserved.`);
          }
        }

        // Update leave request
        await Leave.findByIdAndUpdate(
          leave._id,
          {
            $set: {
              status:      'approved',
              reviewedBy:  new mongoose.Types.ObjectId(adminId),
              reviewedAt:  now,
            },
          },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(adminId),
      action:      'LEAVE_APPROVED',
      targetType:  'Leave',
      targetId:    leave._id.toHexString(),
    });

    void NotificationService.create({
      employeeId:    leave.employeeId,
      type:          'leaveApproved',
      title:         'Leave Request Approved',
      body:          `Your ${leave.leaveType} leave request has been approved.`,
      referenceType: 'leaveRequest',
      referenceId:   leave._id,
      emailAddress:  user?.email,
      emailName:     user ? `${user.firstName} ${user.lastName}` : undefined,
    }).catch(logNotificationFailure);

    return {
      id:          leave._id.toHexString(),
      status:      'approved',
      approvedBy:  adminId,
      approvedAt:  now.toISOString(),
      balanceAfter: leaveType !== 'lwp' ? { currentYear: balanceAfterCy, carriedForward: balanceAfterCf } : null,
      warnings,
    };
  }

  // ─── Reject ─────────────────────────────────────────────────────────────────

  static async reject(leaveId: string, adminId: string, reason?: string) {
    await connectDB();

    const leave = await Leave.findById(leaveId) as (ILeave & { _id: mongoose.Types.ObjectId }) | null;
    if (!leave) throw new AppError('GEN_002', 404, 'Leave request not found.');
    if (leave.status !== 'pending') throw new AppError('LVE_005', 422, 'Only pending leave requests can be rejected.');

    const now = new Date();
    const rejected = await Leave.findOneAndUpdate(
      { _id: leave._id, status: 'pending' },
      {
        $set: {
          status:     'rejected',
          reviewedBy: new mongoose.Types.ObjectId(adminId),
          reviewedAt: now,
          ...(reason ? { reviewRemarks: reason } : {}),
        },
      },
      { new: true },
    );
    if (!rejected) throw new AppError('LVE_005', 422, 'Only pending leave requests can be rejected.');

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(adminId),
      action:      'LEAVE_REJECTED',
      targetType:  'Leave',
      targetId:    leave._id.toHexString(),
    });

    void (async () => {
      const rejectedUser = await User.findById(leave.employeeId, 'email firstName lastName').lean() as { email: string; firstName: string; lastName: string } | null;
      void NotificationService.create({
        employeeId:    leave.employeeId,
        type:          'leaveRejected',
        title:         'Leave Request Rejected',
        body:          `Your ${leave.leaveType} leave request has been rejected.${reason ? ` Reason: ${reason}` : ''}`,
        referenceType: 'leaveRequest',
        referenceId:   leave._id,
        emailAddress:  rejectedUser?.email,
        emailName:     rejectedUser ? `${rejectedUser.firstName} ${rejectedUser.lastName}` : undefined,
      }).catch(logNotificationFailure);
    })();

    return { id: leave._id.toHexString(), status: 'rejected' };
  }

  // ─── Revoke ─────────────────────────────────────────────────────────────────

  static async revoke(leaveId: string, adminId: string, reason: string) {
    await connectDB();

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    if (!settings) throw new AppError('GEN_004', 500, 'Company settings not configured.');

    const leave = await Leave.findById(leaveId).lean() as (ILeave & { _id: mongoose.Types.ObjectId }) | null;
    if (!leave) throw new AppError('GEN_002', 404, 'Leave request not found.');
    if (leave.status !== 'approved') throw new AppError('LVE_006', 422, 'Only approved leave requests can be revoked.');

    const now = new Date();
    const { leaveType, leaveYear, totalDays, employeeId, affectedDates } = leave;

    // Fetch fresh balance for snapshot
    const user = await User.findById(employeeId).lean() as IUser | null;
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    let balanceAfterCy  = 0;
    let balanceAfterCf  = 0;

    if (leaveType !== 'lwp') {
      const bal = user.leaveBalances[leaveType as keyof IUser['leaveBalances']];
      balanceAfterCy = bal.currentYear + totalDays;
      balanceAfterCf = bal.carriedForward;
    }

    const warnings: string[] = [];

    // Check payroll finalized for affected months (BR-LVE-22)
    const affectedMonths = [...new Set(affectedDates.map(d => d.slice(0, 7)))];
    for (const ym of affectedMonths) {
      const payroll = await PayrollRecord.findOne({
        employeeId,
        yearMonth: ym,
        status:    'finalised',
      }).lean();
      if (payroll) {
        warnings.push(`Payroll for ${ym} is finalised. Manual recomputation required.`);
      }
    }

    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        // Atomic state claim (approved → revoked): concurrent duplicate
        // requests cannot both apply balance/attendance changes.
        const claimed = await Leave.findOneAndUpdate(
          { _id: leave._id, status: 'approved' },
          { $set: { status: 'revoked' } },
          { session: mongoSession, new: true },
        );
        if (!claimed) throw new AppError('LVE_006', 422, 'Only approved leave requests can be revoked.');

        if (leaveType !== 'lwp') {
          // Restore balance to currentYear (BR-LVE-21)
          await User.findByIdAndUpdate(
            employeeId,
            { $inc: { [`leaveBalances.${leaveType}.currentYear`]: totalDays } },
            { session: mongoSession },
          );

          await LeaveTransaction.create([{
            employeeId,
            leaveType,
            leaveYear,
            transactionType: 'restoration-revocation',
            days:   totalDays,
            balanceAfterCurrentYear:    balanceAfterCy,
            balanceAfterCarriedForward: balanceAfterCf,
            referenceType: 'leaveRequest',
            referenceId:   leave._id,
            performedBy:   new mongoose.Types.ObjectId(adminId),
            timestamp:     now,
          }], { session: mongoSession });
        }

        // Reset AttendanceDay.status for all affectedDates (BR-LVE-21)
        for (const dateStr of affectedDates) {
          const day = await AttendanceDay.findOne({ employeeId, dateString: dateStr }).session(mongoSession).lean();
          if (!day) continue;
          // A day whose missed check-out was resolved only by this leave goes
          // back to absent + unresolved (docs/85); otherwise derive from minutes.
          const missedUnresolvedAgain = !!day.missedCheckoutSessionId && !day.isRegularized;
          const priorStatus = missedUnresolvedAgain
            ? 'absent'
            : (day.totalMinutes ?? 0) >= (settings.requiredDailyMinutes ?? 540)
              ? 'present'
              : (day.totalMinutes ?? 0) >= (settings.halfDayThresholdMinutes ?? 270)
                ? 'half-day'
                : 'absent';
          await AttendanceDay.updateOne(
            { _id: day._id },
            {
              $set:   { status: priorStatus, ...(missedUnresolvedAgain ? { hasUnresolvedMissedCheckout: true } : {}) },
              $unset: { leaveRequestId: '', leaveType: '', leaveDuration: '' },
            },
            { session: mongoSession },
          );
        }

        // Update leave request
        await Leave.findByIdAndUpdate(
          leave._id,
          {
            $set: {
              status:           'revoked',
              revokedBy:        new mongoose.Types.ObjectId(adminId),
              revokedAt:        now,
              revocationReason: reason,
            },
          },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(adminId),
      action:      'LEAVE_REVOKED',
      targetType:  'Leave',
      targetId:    leave._id.toHexString(),
    });

    void NotificationService.create({
      employeeId:    leave.employeeId,
      type:          'leaveRevoked',
      title:         'Leave Request Revoked',
      body:          `Your ${leave.leaveType} leave has been revoked. Reason: ${reason}`,
      referenceType: 'leaveRequest',
      referenceId:   leave._id,
      emailAddress:  user?.email,
      emailName:     user ? `${user.firstName} ${user.lastName}` : undefined,
    }).catch(logNotificationFailure);

    return {
      id:          leave._id.toHexString(),
      status:      'revoked',
      balanceAfter: leaveType !== 'lwp' ? { currentYear: balanceAfterCy, carriedForward: balanceAfterCf } : null,
      warnings,
    };
  }

  // ─── Withdraw (employee cancels approved leave before it starts) ─────────────

  static async withdraw(leaveId: string, employeeId: string, reason?: string) {
    await connectDB();

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    if (!settings) throw new AppError('GEN_004', 500, 'Company settings not configured.');

    const leave = await Leave.findById(leaveId).lean() as (ILeave & { _id: mongoose.Types.ObjectId }) | null;
    if (!leave) throw new AppError('GEN_002', 404, 'Leave request not found.');

    if (leave.employeeId.toHexString() !== employeeId) {
      throw new AppError('AUTH_006', 403, 'Access denied.');
    }
    if (leave.status !== 'approved') {
      throw new AppError('LVE_008', 422, 'Only approved leave requests can be withdrawn.');
    }

    const now     = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const firstDate = leave.affectedDates[0];

    if (firstDate && firstDate <= todayStr) {
      throw new AppError('LVE_008', 422, 'Leave has already started and cannot be withdrawn.');
    }

    const { leaveType, leaveYear, totalDays, affectedDates } = leave;

    const user = await User.findById(employeeId).lean() as IUser | null;
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    let balanceAfterCy  = 0;
    let balanceAfterCf  = 0;

    if (leaveType !== 'lwp') {
      const bal = user.leaveBalances[leaveType as keyof IUser['leaveBalances']];
      balanceAfterCy = bal.currentYear + totalDays;
      balanceAfterCf = bal.carriedForward;
    }

    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        // Atomic state claim (approved → withdrawn): concurrent duplicate
        // requests cannot both apply balance/attendance changes.
        const claimed = await Leave.findOneAndUpdate(
          { _id: leave._id, status: 'approved' },
          { $set: { status: 'withdrawn' } },
          { session: mongoSession, new: true },
        );
        if (!claimed) throw new AppError('LVE_008', 422, 'Only approved leave requests can be withdrawn.');

        if (leaveType !== 'lwp') {
          await User.findByIdAndUpdate(
            employeeId,
            { $inc: { [`leaveBalances.${leaveType}.currentYear`]: totalDays } },
            { session: mongoSession },
          );

          await LeaveTransaction.create([{
            employeeId:  new mongoose.Types.ObjectId(employeeId),
            leaveType,
            leaveYear,
            transactionType: 'restoration-withdrawal',
            days:   totalDays,
            balanceAfterCurrentYear:    balanceAfterCy,
            balanceAfterCarriedForward: balanceAfterCf,
            referenceType: 'leaveRequest',
            referenceId:   leave._id,
            performedBy:   new mongoose.Types.ObjectId(employeeId),
            timestamp:     now,
          }], { session: mongoSession });
        }

        // Revert AttendanceDay for all affectedDates
        for (const dateStr of affectedDates) {
          const day = await AttendanceDay.findOne({ employeeId, dateString: dateStr }).session(mongoSession).lean();
          if (!day) continue;
          // A day whose missed check-out was resolved only by this leave goes
          // back to absent + unresolved (docs/85); otherwise derive from minutes.
          const missedUnresolvedAgain = !!day.missedCheckoutSessionId && !day.isRegularized;
          const priorStatus = missedUnresolvedAgain
            ? 'absent'
            : (day.totalMinutes ?? 0) >= (settings.requiredDailyMinutes ?? 540)
              ? 'present'
              : (day.totalMinutes ?? 0) >= (settings.halfDayThresholdMinutes ?? 270)
                ? 'half-day'
                : 'absent';
          await AttendanceDay.updateOne(
            { _id: day._id },
            {
              $set:   { status: priorStatus, ...(missedUnresolvedAgain ? { hasUnresolvedMissedCheckout: true } : {}) },
              $unset: { leaveRequestId: '', leaveType: '', leaveDuration: '', leaveHalfDayPeriod: '' },
            },
            { session: mongoSession },
          );
        }

        await Leave.findByIdAndUpdate(
          leave._id,
          {
            $set: {
              status:           'withdrawn',
              withdrawnBy:      new mongoose.Types.ObjectId(employeeId),
              withdrawnAt:      now,
              withdrawalReason: reason,
            },
          },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }

    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(employeeId),
      action:      'LEAVE_WITHDRAWN',
      targetType:  'Leave',
      targetId:    leave._id.toHexString(),
    });

    return {
      id:          leave._id.toHexString(),
      status:      'withdrawn',
      balanceAfter: leaveType !== 'lwp' ? { currentYear: balanceAfterCy, carriedForward: balanceAfterCf } : null,
    };
  }

  // ─── Balance ─────────────────────────────────────────────────────────────────

  static async getBalance(actorId: string, role: UserRole, employeeId?: string) {
    await connectDB();

    const targetId = (isAttendanceAdmin(role) && employeeId) ? employeeId : actorId;
    const user = await User.findById(targetId).lean() as IUser | null;
    if (!user) throw new AppError('GEN_002', 404, 'Employee not found.');

    const now   = new Date();
    const { leaveBalances } = user;

    function fmt(bal: ILeaveTypeBalance) {
      const cfValid = bal.carryForwardExpiry && bal.carryForwardExpiry > now;
      const cf      = cfValid ? bal.carriedForward : 0;
      return {
        currentYear:        bal.currentYear,
        carriedForward:     cf,
        carryForwardExpiry: bal.carryForwardExpiry?.toISOString().slice(0, 10) ?? null,
        total:              bal.currentYear + cf,
      };
    }

    return {
      paidLeave:   fmt(leaveBalances.paidLeave),
      sickLeave:   fmt(leaveBalances.sickLeave),
      casualLeave: fmt(leaveBalances.casualLeave),
      asOf: now.toISOString(),
    };
  }

  // ─── List Pending (admin) ────────────────────────────────────────────────────

  static async listPending(params: {
    employeeId?: string;
    leaveType?: string;
    page: number;
    limit: number;
  }) {
    await connectDB();

    const filter: Record<string, unknown> = { status: 'pending' };
    if (params.employeeId) filter['employeeId'] = new mongoose.Types.ObjectId(params.employeeId);
    if (params.leaveType)  filter['leaveType']  = params.leaveType;

    const skip = (params.page - 1) * params.limit;
    const [leaves, total] = await Promise.all([
      Leave.find(filter).sort({ createdAt: 1 }).skip(skip).limit(params.limit).lean() as unknown as Promise<(ILeave & { _id: mongoose.Types.ObjectId })[]>,
      Leave.countDocuments(filter),
    ]);

    const empIds = [...new Set(leaves.map((l: { employeeId: mongoose.Types.ObjectId }) => l.employeeId.toHexString()))];
    let nameMap: Record<string, string> = {};
    if (empIds.length > 0) {
      const users = await User.find({ _id: { $in: empIds } }, 'firstName lastName').lean() as unknown as Array<{ _id: mongoose.Types.ObjectId; firstName: string; lastName: string }>;
      nameMap = Object.fromEntries(users.map(u => [u._id.toHexString(), `${u.firstName} ${u.lastName}`]));
    }

    return {
      data: leaves.map((l: ILeave & { _id: mongoose.Types.ObjectId }) =>
        formatLeave(l, nameMap[l.employeeId.toHexString()])),
      pagination: {
        page:       params.page,
        limit:      params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }
}
