import mongoose from 'mongoose';
import { toZonedTime } from 'date-fns-tz';
import { connectDB } from '@lib/db/connect';
import { AppError } from '@services/AuthService';
import { Regularization } from '@models/Regularization';
import { AttendanceDay } from '@models/AttendanceDay';
import { AttendanceSession } from '@models/AttendanceSession';
import { CompanySettings } from '@models/CompanySettings';
import { PayrollRecord } from '@models/PayrollRecord';
import { AuditLog } from '@models/AuditLog';
import { User } from '@models/User';
import { Employee } from '@models/Employee';
import { NotificationService, logNotificationFailure } from '@services/NotificationService';
import { computeDayStatus } from '@engines/DayStatusEngine';
import { reconcileMissedCheckouts } from '@services/AttendanceService';
import type { IRegularization } from '@models/Regularization';
import type { ICompanySettings } from '@models/CompanySettings';
import type { CreateRegularizationInput, RegularizationListQuery } from '@validators/regularization';
import type { JwtPayload } from '@app-types/jwt';
import { isAttendanceAdmin } from '@mw/requireRole';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type EmployeeStub = { _id: string; firstName: string; lastName: string } | null;

function formatReg(
  reg: IRegularization & { _id: mongoose.Types.ObjectId },
  employeeStub?: EmployeeStub,
) {
  return {
    _id:               reg._id.toHexString(),
    employeeId:        employeeStub ?? reg.employeeId.toHexString(),
    date:              reg.dateString,
    type:              reg.type,
    requestedCheckIn:  reg.requestedCheckIn?.toISOString() ?? null,
    requestedCheckOut: reg.requestedCheckOut?.toISOString() ?? null,
    reason:            reg.reason,
    status:            reg.status,
    reviewedBy:        reg.reviewedBy?.toHexString() ?? null,
    reviewedAt:        reg.reviewedAt?.toISOString() ?? null,
    reviewRemark:      reg.reviewRemark ?? null,
    attendanceDayId:   reg.attendanceDayId?.toHexString() ?? null,
    withdrawnAt:       reg.withdrawnAt?.toISOString() ?? null,
    createdAt:         reg.createdAt.toISOString(),
  };
}

async function getSettings(): Promise<ICompanySettings> {
  const s = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
  if (!s) throw new AppError('GEN_004', 500, 'Company settings not configured.');
  return s;
}

async function checkPayrollWarning(
  employeeId: mongoose.Types.ObjectId,
  dateString: string,
): Promise<string | null> {
  const yearMonth = dateString.slice(0, 7);
  const record = await PayrollRecord.findOne({ employeeId, yearMonth, status: 'finalised' }).lean();
  return record ? `Payroll for ${yearMonth} is already finalised. Attendance change may affect payroll accuracy.` : null;
}

// ─── M2: Date boundary validation ────────────────────────────────────────────

function localDateString(ts: Date, timezone: string): string {
  return toZonedTime(ts, timezone).toISOString().slice(0, 10);
}

function validateTimestampBoundaries(
  dateStr: string,
  requestedCheckIn: Date | undefined,
  requestedCheckOut: Date | undefined,
  timezone: string,
): void {
  if (requestedCheckIn) {
    const localDay = localDateString(requestedCheckIn, timezone);
    if (localDay !== dateStr) {
      throw new AppError('GEN_001', 400, `requestedCheckIn must be on the same calendar day as date (${dateStr}) in the company timezone.`);
    }
  }

  if (requestedCheckOut) {
    const localDay = localDateString(requestedCheckOut, timezone);
    const reqDate  = new Date(dateStr + 'T00:00:00Z');
    const nextDay  = new Date(reqDate.getTime() + 86_400_000).toISOString().slice(0, 10);
    if (localDay !== dateStr && localDay !== nextDay) {
      throw new AppError('GEN_001', 400, `requestedCheckOut must be on the same day or the following day as date (${dateStr}) in the company timezone.`);
    }
  }
}

// ─── Reconciliation helpers ───────────────────────────────────────────────────

async function reconcileForSession(
  employeeId: mongoose.Types.ObjectId,
  dateString: string,
  attendanceDayId: mongoose.Types.ObjectId,
  settings: ICompanySettings,
  session: mongoose.ClientSession,
) {
  // Sum durationMinutes from all closed sessions for this employee+date
  const sessions = await AttendanceSession.find(
    { employeeId, dateString, isActive: false },
    { durationMinutes: 1 },
  ).session(session).lean();
  const totalMinutes = sessions.reduce((acc, s) => acc + (s.durationMinutes ?? 0), 0);

  // Weekly-off / holiday / leave days keep their status when work is recorded
  // on them (same protection as the 24-hour missed-check-out rule and the live
  // check-out path); only the minutes are updated. Previously an approved
  // regularization turned e.g. a worked Sunday into 'absent'.
  const PROTECTED: string[] = ['weekend', 'holiday', 'leave', 'lwp'];
  const current = await AttendanceDay.findById(attendanceDayId, 'status').session(session).lean() as { status?: string } | null;
  if (current?.status && PROTECTED.includes(current.status)) {
    await AttendanceDay.findByIdAndUpdate(
      attendanceDayId,
      {
        $set: {
          totalMinutes,
          overtimeMinutes: Math.max(0, totalMinutes - settings.requiredDailyMinutes),
          isRegularized: true,
          hasUnresolvedMissedCheckout: false,
        },
      },
      { session },
    );
    return current.status;
  }

  const result = computeDayStatus({
    totalMinutes,
    requiredDailyMinutes:    settings.requiredDailyMinutes,
    halfDayThresholdMinutes: settings.halfDayThresholdMinutes,
    halfDayLateCheckInTime:  settings.halfDayLateCheckInTime,
    lateArrivalGraceMinutes: settings.lateArrivalGraceMinutes,
    workStartTime:           settings.workStartTime,
  });

  await AttendanceDay.findByIdAndUpdate(
    attendanceDayId,
    {
      $set: {
        status:          result.finalStatus,
        totalMinutes,
        overtimeMinutes: Math.max(0, totalMinutes - settings.requiredDailyMinutes),
        isLateArrival:   result.isLateArrival,
        lateByMinutes:   result.lateByMinutes,
        isHalfDayCapped: result.isHalfDayCapped,
        isRegularized:   true,
        hasUnresolvedMissedCheckout: false,
      },
    },
    { session },
  );

  return result.finalStatus;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class RegularizationService {

  // ─── Create ──────────────────────────────────────────────────────────────────

  static async create(params: {
    employeeId: string;
    input: CreateRegularizationInput;
  }) {
    await connectDB();
    // Apply the 24-hour rule first so an overdue session is recognised as a
    // missed check-out that this request can correct.
    await reconcileMissedCheckouts({ employeeId: params.employeeId });
    const settings = await getSettings();

    const { employeeId, input } = params;
    const employeeOid = new mongoose.Types.ObjectId(employeeId);

    // BR-REG-01: date must not be future (work-away allows today; others require past only)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const reqDate = new Date(input.date + 'T00:00:00Z');
    const isWorkAway = input.type === 'workAwayFromOffice';
    const isFuture = isWorkAway ? reqDate > today : reqDate >= today;
    if (isFuture) {
      throw new AppError('GEN_001', 400, isWorkAway ? 'Date must not be in the future.' : 'Date must be in the past.');
    }

    // BR-REG-01: within lookback window (same-day work-away is always within window)
    const lookbackMs = settings.regularizationLookbackDays * 24 * 60 * 60 * 1000;
    if (today.getTime() - reqDate.getTime() > lookbackMs) {
      throw new AppError('REG_001', 422, `Date is older than the allowed lookback window of ${settings.regularizationLookbackDays} days.`);
    }

    // M2: Validate requestedCheckIn/requestedCheckOut date boundaries
    validateTimestampBoundaries(
      input.date,
      input.requestedCheckIn  ? new Date(input.requestedCheckIn)  : undefined,
      input.requestedCheckOut ? new Date(input.requestedCheckOut) : undefined,
      settings.timezone,
    );

    // BR-REG-02: no active (pending/approved) request for this date
    const existing = await Regularization.findOne({
      employeeId: employeeOid,
      dateString: input.date,
      status: { $in: ['pending', 'approved'] },
    }).lean();
    if (existing) {
      throw new AppError('REG_002', 409, 'A regularization request already exists for this date.');
    }

    // BR-REG-03: session state must be consistent with the requested type
    const sessions = await AttendanceSession.find({
      employeeId: employeeOid,
      dateString: input.date,
    }).lean();

    // A session closed by the employee (not by system) is a completed record — no regularisation allowed
    const hasCompletedSession = sessions.some((s) => s.checkOut !== null && !s.closedBySystem);
    if (hasCompletedSession) {
      throw new AppError('REG_004', 422, 'This date already has a completed attendance record. Regularisation is not available.');
    }

    // forgotCheckOut requires a missed-checkout session (still active, or closed by midnight rollover)
    if (input.type === 'forgotCheckOut') {
      const hasEligibleSession = sessions.some(
        (s) => s.isActive || (s.closedBySystem && (s.systemCloseReason === 'midnight-rollover' || s.systemCloseReason === 'missed-checkout')),
      );
      if (!hasEligibleSession) {
        throw new AppError('REG_005', 422, 'No missed-checkout session found for this date. If you were absent, please apply for leave instead.');
      }
    }

    const reg = await Regularization.create({
      employeeId:        employeeOid,
      dateString:        input.date,
      type:              input.type,
      requestedCheckIn:  input.requestedCheckIn  ? new Date(input.requestedCheckIn)  : undefined,
      requestedCheckOut: input.requestedCheckOut ? new Date(input.requestedCheckOut) : undefined,
      reason:            input.reason,
      status:            'pending',
    });

    await AuditLog.create({
      performedBy: employeeOid,
      action:      'REGULARIZATION_CREATED',
      targetType:  'Regularization',
      targetId:    reg._id.toHexString(),
    });

    void NotificationService.notifyAllAdmins({
      type:          'regularizationSubmitted',
      title:         'New Regularization Request',
      body:          `An employee has submitted an attendance regularization request for ${input.date}.`,
      referenceType: 'regularizationRequest',
      referenceId:   reg._id as mongoose.Types.ObjectId,
    }).catch(logNotificationFailure);

    return formatReg(reg as IRegularization & { _id: mongoose.Types.ObjectId });
  }

  // ─── Approve ─────────────────────────────────────────────────────────────────

  static async approve(id: string, adminId: string) {
    await connectDB();
    const settings = await getSettings();

    if (!mongoose.isValidObjectId(id)) throw new AppError('GEN_002', 404, 'Regularization request not found.');
    const reg = await Regularization.findById(id).lean() as (IRegularization & { _id: mongoose.Types.ObjectId }) | null;
    if (!reg) throw new AppError('GEN_002', 404, 'Regularization request not found.');
    if (reg.status !== 'pending') throw new AppError('REG_003', 422, 'Only pending requests can be approved.');

    const adminOid    = new mongoose.Types.ObjectId(adminId);
    const employeeOid = reg.employeeId;
    const { dateString } = reg;
    const dateObj = new Date(dateString + 'T00:00:00Z');
    const year  = dateObj.getUTCFullYear();
    const month = dateObj.getUTCMonth() + 1;

    const warnings: string[] = [];
    const payrollWarn = await checkPayrollWarning(employeeOid, dateString);
    if (payrollWarn) warnings.push(payrollWarn);

    const dbSession = await mongoose.startSession();
    let updatedDayStatus: string = 'present';
    let attendanceDayId: mongoose.Types.ObjectId;

    try {
      await dbSession.withTransaction(async () => {
        // ── Atomically claim the request (pending → approved) ──────────────
        // Concurrent approve/reject/withdraw: only the first conditional update
        // matches; the loser gets REG_003 and its transaction applies nothing
        // (no duplicate synthetic session, no double day update).
        const claimed = await Regularization.findOneAndUpdate(
          { _id: reg._id, status: 'pending' },
          { $set: { status: 'approved', reviewedBy: adminOid, reviewedAt: new Date() } },
          { session: dbSession, new: true },
        );
        if (!claimed) throw new AppError('REG_003', 422, 'Only pending requests can be approved.');

        // ── Upsert AttendanceDay ────────────────────────────────────────────
        const dayUpsert = await AttendanceDay.findOneAndUpdate(
          { employeeId: employeeOid, dateString },
          {
            $setOnInsert: {
              employeeId:      employeeOid,
              dateString,
              date:            dateObj,
              year,
              month,
              totalMinutes:    0,
              requiredMinutes: settings.requiredDailyMinutes,
              overtimeMinutes: 0,
              isLateArrival:   false,
              lateByMinutes:   0,
              isHalfDayCapped: false,
              isRegularized:   false,
            },
          },
          { upsert: true, new: true, session: dbSession },
        );
        attendanceDayId = dayUpsert!._id as mongoose.Types.ObjectId;

        if (reg.type === 'forgotCheckIn' && reg.requestedCheckOut) {
          // The employee stated BOTH times: record exactly that session and
          // derive the day from real minutes (TC-REG-011: "added as additional
          // session; cumulative minutes updated"). Previously the requested
          // check-out was silently dropped and the day forced to 'present'.
          const checkInTs  = reg.requestedCheckIn ?? dateObj;
          const checkOutTs = reg.requestedCheckOut;
          if (checkOutTs.getTime() <= checkInTs.getTime() || checkOutTs.getTime() - checkInTs.getTime() > 24 * 60 * 60 * 1000) {
            throw new AppError('REG_007', 422, 'Requested check-out must be after the check-in and within 24 hours of it.');
          }
          // Never double-count: the interval must not overlap a recorded session.
          const overlapping = await AttendanceSession.findOne({
            employeeId: employeeOid,
            'checkIn.timestamp': { $lt: checkOutTs },
            $or: [{ isActive: true }, { 'checkOut.timestamp': { $gt: checkInTs } }],
          }).session(dbSession).lean();
          if (overlapping) {
            throw new AppError('REG_008', 409, 'The requested times overlap an attendance session that is already recorded for this employee.');
          }
          const durationMins = Math.floor((checkOutTs.getTime() - checkInTs.getTime()) / 60000);
          const sysId = reg._id.toHexString().slice(-8);

          await AttendanceSession.create(
            [{
              employeeId:      employeeOid,
              attendanceDayId,
              dateString,
              checkIn: {
                timestamp: checkInTs, latitude: 0, longitude: 0, accuracy: 0, distanceFromOffice: 0,
                deviceFingerprint: 'system-regularization', nonce: `sys-reg-${sysId}`, isWithinGeoFence: true,
              },
              checkOut: {
                timestamp: checkOutTs, latitude: 0, longitude: 0, accuracy: 0, distanceFromOffice: 0,
                deviceFingerprint: 'system-regularization', nonce: `sys-reg-co-${sysId}`, isWithinGeoFence: true,
              },
              durationMinutes:   durationMins,
              isActive:          false,
              closedBySystem:    true,
              systemCloseReason: 'admin-force-close' as const,
              flags: { lowGpsAccuracy: false, outsideGeoFence: false, suspiciousTimestamp: false, possibleMockGps: false },
            }],
            { session: dbSession },
          );

          updatedDayStatus = await reconcileForSession(employeeOid, dateString, attendanceDayId, settings, dbSession);
          await AttendanceDay.findByIdAndUpdate(
            attendanceDayId,
            { $set: { regularizationRequestId: reg._id } },
            { session: dbSession },
          );

        } else if (reg.type === 'forgotCheckIn') {
          // Only a check-in time was stated: unchanged legacy behaviour —
          // synthetic closed session without a check-out, day forced present
          // (no duration exists to derive a status from; see docs/86 open rules).
          const nonce = `sys-reg-${reg._id.toHexString().slice(-8)}`;
          const checkInTs = reg.requestedCheckIn ?? dateObj;

          await AttendanceSession.create(
            [{
              employeeId:      employeeOid,
              attendanceDayId,
              dateString,
              checkIn: {
                timestamp:          checkInTs,
                latitude:           0,
                longitude:          0,
                accuracy:           0,
                distanceFromOffice: 0,
                deviceFingerprint:  'system-regularization',
                nonce,
                isWithinGeoFence:   true,
              },
              checkOut:          null,
              durationMinutes:   null,
              isActive:          false,
              closedBySystem:    true,
              systemCloseReason: 'admin-force-close' as const,
              flags: {
                lowGpsAccuracy:      false,
                outsideGeoFence:     false,
                suspiciousTimestamp: false,
                possibleMockGps:     false,
              },
            }],
            { session: dbSession },
          );

          // Day forced to present — no checkout means duration=0, status engine would mark absent
          await AttendanceDay.findByIdAndUpdate(
            attendanceDayId,
            {
              $set: {
                status:                  'present',
                isRegularized:           true,
                hasUnresolvedMissedCheckout: false,
                regularizationRequestId: reg._id,
              },
            },
            { session: dbSession },
          );
          updatedDayStatus = 'present';

        } else if (reg.type === 'forgotCheckOut') {
          // H1 FIX: Find session that is either still active (unlikely for past days)
          // OR was closed by midnight-rollover cron (the normal case for past dates).
          // Active sessions would only exist on same-day regularizations (unlikely but handled).
          const targetSession = await AttendanceSession.findOne(
            {
              employeeId: employeeOid,
              dateString,
              $or: [
                { isActive: true },
                { isActive: false, closedBySystem: true, systemCloseReason: { $in: ['midnight-rollover', 'missed-checkout'] } },
              ],
            },
          ).sort({ createdAt: -1 }).session(dbSession).lean();

          if (!targetSession) {
            throw new AppError('REG_006', 422, 'No session found for forgot-checkout regularization. No active or midnight-rolled session exists for this date.');
          }

          const checkInTs    = targetSession.checkIn.timestamp;
          // A missed check-out is only corrected with the employee's stated,
          // admin-approved time: it must exist, follow the check-in and fall
          // within the 24-hour window. Nothing is invented.
          if (!reg.requestedCheckOut) {
            throw new AppError('REG_007', 422, 'A requested check-out time is required to correct a missed check-out.');
          }
          const checkOutTs = reg.requestedCheckOut;
          if (checkOutTs.getTime() <= checkInTs.getTime() || checkOutTs.getTime() - checkInTs.getTime() > 24 * 60 * 60 * 1000) {
            throw new AppError('REG_007', 422, 'Requested check-out must be after the check-in and within 24 hours of it.');
          }
          const durationMins = Math.max(0, Math.round((checkOutTs.getTime() - checkInTs.getTime()) / 60000));

          await AttendanceSession.findByIdAndUpdate(
            targetSession._id,
            {
              $set: {
                isActive:          false,
                closedBySystem:    true,
                systemCloseReason: 'admin-force-close' as const,
                durationMinutes:   durationMins,
                checkOut: {
                  timestamp:          checkOutTs,
                  nonce:              `sys-reg-co-${reg._id.toHexString().slice(-8)}`,
                  latitude:           0,
                  longitude:          0,
                  accuracy:           0,
                  distanceFromOffice: 0,
                  deviceFingerprint:  'system-regularization',
                  isWithinGeoFence:   true,
                },
              },
            },
            { session: dbSession },
          );

          updatedDayStatus = await reconcileForSession(employeeOid, dateString, attendanceDayId, settings, dbSession);
          await AttendanceDay.findByIdAndUpdate(
            attendanceDayId,
            { $set: { regularizationRequestId: reg._id } },
            { session: dbSession },
          );

        } else {
          // workAwayFromOffice | officialTravel | clientVisit
          // Directly mark day as present — no session creation per BR-REG-07
          await AttendanceDay.findByIdAndUpdate(
            attendanceDayId,
            {
              $set: {
                status:                  'present',
                isRegularized:           true,
                hasUnresolvedMissedCheckout: false,
                regularizationRequestId: reg._id,
              },
            },
            { session: dbSession },
          );
          updatedDayStatus = 'present';
        }

        // ── Link the attendance day to the (already claimed) request ──────
        await Regularization.findByIdAndUpdate(
          reg._id,
          { $set: { attendanceDayId } },
          { session: dbSession },
        );
      });
    } finally {
      await dbSession.endSession();
    }

    await AuditLog.create({
      performedBy: adminOid,
      action:      'REGULARIZATION_APPROVED',
      targetType:  'Regularization',
      targetId:    id,
    });

    // Same-day work-away approval → enable geofence bypass so employee can check in now
    const todayStr = new Date().toISOString().slice(0, 10);
    if (reg.type === 'workAwayFromOffice' && reg.dateString === todayStr) {
      const empUser = await User.findById(employeeOid, 'employeeId firstName lastName dateOfJoining monthlySalary').lean() as
        { employeeId: string; firstName: string; lastName: string; dateOfJoining: Date; monthlySalary: number } | null;
      if (empUser) {
        await Employee.findOneAndUpdate(
          { userId: employeeOid },
          {
            $set: { allowOutsideGeofence: true },
            $setOnInsert: {
              employeeCode:  empUser.employeeId,
              firstName:     empUser.firstName,
              lastName:      empUser.lastName,
              joiningDate:   empUser.dateOfJoining,
              monthlySalary: empUser.monthlySalary ?? 0,
            },
          },
          { upsert: true },
        );
      }
    }

    void (async () => {
      try {
        const regUser = await User.findById(reg.employeeId, 'email firstName lastName').lean() as { email: string; firstName: string; lastName: string } | null;
        const isSameDayWorkAway = reg.type === 'workAwayFromOffice' && reg.dateString === todayStr;
        const notifBody = isSameDayWorkAway
          ? 'Your work-away request has been approved. You can now check in from your current location.'
          : `Your attendance regularization request for ${reg.dateString} has been approved.`;
        await NotificationService.create({
          employeeId:    reg.employeeId,
          type:          'regularizationApproved',
          title:         isSameDayWorkAway ? 'Work-Away Request Approved' : 'Regularization Request Approved',
          body:          notifBody,
          referenceType: 'regularizationRequest',
          referenceId:   reg._id,
          emailAddress:  regUser?.email,
          emailName:     regUser ? `${regUser.firstName} ${regUser.lastName}` : undefined,
        });
      } catch { /* notification failure is non-critical */ }
    })();

    return {
      id,
      status:          'approved',
      attendanceDayId: attendanceDayId!.toHexString(),
      updatedDayStatus,
      warnings,
    };
  }

  // ─── Reject ───────────────────────────────────────────────────────────────────

  static async reject(id: string, adminId: string, reason?: string) {
    await connectDB();

    if (!mongoose.isValidObjectId(id)) throw new AppError('GEN_002', 404, 'Regularization request not found.');
    const reg = await Regularization.findById(id).lean() as (IRegularization & { _id: mongoose.Types.ObjectId }) | null;
    if (!reg) throw new AppError('GEN_002', 404, 'Regularization request not found.');
    if (reg.status !== 'pending') throw new AppError('REG_003', 422, 'Only pending requests can be rejected.');

    const adminOid = new mongoose.Types.ObjectId(adminId);

    // Conditional update — a concurrent approve/withdraw cannot be overwritten.
    const updated = await Regularization.findOneAndUpdate(
      { _id: reg._id, status: 'pending' },
      {
        $set: {
          status:       'rejected',
          reviewedBy:   adminOid,
          reviewedAt:   new Date(),
          reviewRemark: reason,
        },
      },
      { new: true },
    );
    if (!updated) throw new AppError('REG_003', 422, 'Only pending requests can be rejected.');

    await AuditLog.create({
      performedBy: adminOid,
      action:      'REGULARIZATION_REJECTED',
      targetType:  'Regularization',
      targetId:    id,
    });

    void (async () => {
      try {
        const regUser = await User.findById(reg.employeeId, 'email firstName lastName').lean() as { email: string; firstName: string; lastName: string } | null;
        await NotificationService.create({
          employeeId:    reg.employeeId,
          type:          'regularizationRejected',
          title:         'Regularization Request Rejected',
          body:          `Your attendance regularization request for ${reg.dateString} has been rejected.${reason ? ` Reason: ${reason}` : ''}`,
          referenceType: 'regularizationRequest',
          referenceId:   reg._id,
          emailAddress:  regUser?.email,
          emailName:     regUser ? `${regUser.firstName} ${regUser.lastName}` : undefined,
        });
      } catch { /* notification failure is non-critical */ }
    })();

    return { id, status: 'rejected' };
  }

  // ─── Withdraw ─────────────────────────────────────────────────────────────────

  static async withdraw(id: string, employeeId: string) {
    await connectDB();

    if (!mongoose.isValidObjectId(id)) throw new AppError('GEN_002', 404, 'Regularization request not found.');
    const employeeOid = new mongoose.Types.ObjectId(employeeId);
    const reg = await Regularization.findById(id).lean() as (IRegularization & { _id: mongoose.Types.ObjectId }) | null;
    if (!reg) throw new AppError('GEN_002', 404, 'Regularization request not found.');
    if (!reg.employeeId.equals(employeeOid)) throw new AppError('AUTH_006', 403, 'Not authorized to withdraw this request.');
    if (reg.status !== 'pending') throw new AppError('REG_003', 422, 'Only pending requests can be withdrawn.');

    // Conditional on owner + pending: a concurrent approval/rejection wins cleanly.
    const updated = await Regularization.findOneAndUpdate(
      { _id: reg._id, employeeId: employeeOid, status: 'pending' },
      { $set: { status: 'withdrawn', withdrawnAt: new Date() } },
      { new: true },
    );
    if (!updated) throw new AppError('REG_003', 422, 'Only pending requests can be withdrawn.');

    await AuditLog.create({
      performedBy: employeeOid,
      action:      'REGULARIZATION_WITHDRAWN',
      targetType:  'Regularization',
      targetId:    id,
    });

    return { id, status: 'withdrawn' };
  }

  // ─── Get by ID ────────────────────────────────────────────────────────────────

  static async getById(id: string, payload: JwtPayload) {
    await connectDB();

    if (!mongoose.isValidObjectId(id)) throw new AppError('GEN_002', 404, 'Regularization request not found.');
    const reg = await Regularization.findById(id).lean() as (IRegularization & { _id: mongoose.Types.ObjectId }) | null;
    if (!reg) throw new AppError('GEN_002', 404, 'Regularization request not found.');

    // Only HR admins may view other employees' requests (manager/executive: own only).
    if (!isAttendanceAdmin(payload.role)) {
      const employeeOid = new mongoose.Types.ObjectId(payload.userId);
      if (!reg.employeeId.equals(employeeOid)) {
        throw new AppError('AUTH_006', 403, 'Not authorized to view this request.');
      }
    }

    return formatReg(reg);
  }

  // ─── List ─────────────────────────────────────────────────────────────────────

  static async list(query: RegularizationListQuery, payload: JwtPayload) {
    await connectDB();

    const filter: Record<string, unknown> = {};

    // Non-HR-admin roles (employee, manager, executive) are always scoped to
    // their own requests; an employeeId query parameter cannot widen that.
    if (!isAttendanceAdmin(payload.role)) {
      filter.employeeId = new mongoose.Types.ObjectId(payload.userId);
    } else if (query.employeeId) {
      filter.employeeId = new mongoose.Types.ObjectId(query.employeeId);
    }

    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;
    if (query.startDate || query.endDate) {
      const range: Record<string, string> = {};
      if (query.startDate) range.$gte = query.startDate;
      if (query.endDate)   range.$lte = query.endDate;
      filter.dateString = range;
    }

    const skip = (query.page - 1) * query.limit;
    const [regs, total] = await Promise.all([
      Regularization.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).lean() as unknown as Promise<(IRegularization & { _id: mongoose.Types.ObjectId })[]>,
      Regularization.countDocuments(filter),
    ]);

    // Batch-load employee names for admin list view
    const uniqueIds = [...new Set(regs.map((r) => r.employeeId.toHexString()))];
    const users = await User.find(
      { _id: { $in: uniqueIds } },
      '_id firstName lastName',
    ).lean() as { _id: mongoose.Types.ObjectId; firstName: string; lastName: string }[];
    const userMap = new Map(users.map((u) => [u._id.toHexString(), u]));

    return {
      data: regs.map((r) => {
        const u = userMap.get(r.employeeId.toHexString());
        const stub: EmployeeStub = u ? { _id: u._id.toHexString(), firstName: u.firstName, lastName: u.lastName } : null;
        return formatReg(r, stub);
      }),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  // ─── List Pending (admin) ─────────────────────────────────────────────────────

  static async listPending(query: { page: number; limit: number }) {
    await connectDB();

    const skip = (query.page - 1) * query.limit;
    const [regs, total] = await Promise.all([
      Regularization.find({ status: 'pending' }).sort({ createdAt: 1 }).skip(skip).limit(query.limit).lean() as unknown as Promise<(IRegularization & { _id: mongoose.Types.ObjectId })[]>,
      Regularization.countDocuments({ status: 'pending' }),
    ]);

    return {
      data:       regs.map((r) => formatReg(r)),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }
}
