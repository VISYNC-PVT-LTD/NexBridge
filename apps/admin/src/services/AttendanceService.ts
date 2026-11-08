import mongoose from 'mongoose';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { connectDB } from '@lib/db/connect';
import { sha256 } from '@lib/utils/hash';
import { haversineMeters } from '@engines/GeoFenceEngine';
import { computeDayStatus } from '@engines/DayStatusEngine';
import { User } from '@models/User';
import { Employee } from '@models/Employee';
import type { IEmployee } from '@models/Employee';
import { CompanySettings } from '@models/CompanySettings';
import { AttendanceDay } from '@models/AttendanceDay';
import { AttendanceSession } from '@models/AttendanceSession';
import { UsedNonce } from '@models/UsedNonce';
import { Holiday } from '@models/Holiday';
import { AuditLog } from '@models/AuditLog';
import { Regularization } from '@models/Regularization';
import type { IRegularization } from '@models/Regularization';
import { AppError } from '@services/AuthService';
import type { ICompanySettings } from '@models/CompanySettings';
import type { IAttendanceDay, AttendanceDayStatus } from '@models/AttendanceDay';
import type { WeekDay } from '@app-types/enums';
import { GeocodingService } from '@services/GeocodingService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FINGERPRINT_REGEX = /^[0-9a-f]{64}$/i;

function isMongooseDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000;
}

function toLocalDateString(utcDate: Date, timezone: string): string {
  return formatInTimeZone(utcDate, timezone, 'yyyy-MM-dd');
}

function toLocalHHMM(utcDate: Date, timezone: string): string {
  return formatInTimeZone(utcDate, timezone, 'HH:mm');
}

function toLocalDayOfWeek(utcDate: Date, timezone: string): WeekDay {
  return formatInTimeZone(utcDate, timezone, 'EEEE').toLowerCase() as WeekDay;
}

function parseHHMM(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Derive day status from totalMinutes, respecting stored caps and priority flags. */
function deriveDayStatus(
  totalMinutes: number,
  isHalfDayCapped: boolean,
  currentStatus: AttendanceDayStatus,
  settings: { requiredDailyMinutes: number; halfDayThresholdMinutes: number },
): AttendanceDayStatus {
  // Priority: holiday > weekend > leave/lwp > attendance-derived
  if (currentStatus === 'holiday') return 'holiday';
  if (currentStatus === 'weekend') return 'weekend';
  if (currentStatus === 'leave' || currentStatus === 'lwp') return currentStatus;

  const durationStatus: AttendanceDayStatus =
    totalMinutes >= settings.requiredDailyMinutes
      ? 'present'
      : totalMinutes >= settings.halfDayThresholdMinutes
        ? 'half-day'
        : 'absent';

  if (isHalfDayCapped && durationStatus === 'present') return 'half-day';
  return durationStatus;
}

// ─── Missed check-out (24-hour rule) ─────────────────────────────────────────
//
// Business rule (docs/85):
//  * A session that is not checked out within 24 hours of its check-in is a
//    MISSED CHECK-OUT. The deadline is checkIn + 24 h; a check-out at or after
//    the deadline is refused.
//  * No punch-out is fabricated: the session keeps checkOut = null and
//    durationMinutes = 0, and is marked closedBySystem with
//    systemCloseReason 'missed-checkout'. The original check-in is preserved.
//  * The check-in day is marked ABSENT (unless it is already a leave / LWP /
//    holiday / weekend day or was regularized) and flagged
//    hasUnresolvedMissedCheckout until an approved regularization or leave
//    resolves it. No worked minutes are added.
//  * Enforcement is lazy AND scheduled: every attendance read/write path calls
//    reconcileMissedCheckouts() first, so the rule is applied on time from the
//    user's point of view even if the nightly cron runs late or not at all.

export const MISSED_CHECKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Deadline by which a session must be checked out. */
export function checkoutDeadline(checkIn: Date): Date {
  return new Date(checkIn.getTime() + MISSED_CHECKOUT_WINDOW_MS);
}

/** True when the 24-hour window has elapsed (boundary inclusive: at the deadline it is missed). */
export function isCheckoutWindowExpired(checkIn: Date, now: Date = new Date()): boolean {
  return now.getTime() >= checkoutDeadline(checkIn).getTime();
}

const PROTECTED_DAY_STATUSES: AttendanceDayStatus[] = ['leave', 'lwp', 'holiday', 'weekend'];

/**
 * Marks one overdue session as a missed check-out. Idempotent and race-safe:
 * the update is conditional on the session still being active AND overdue, so
 * a duplicate cron run, a concurrent read-path reconciliation or a check-out
 * that won the race just before the deadline cannot be overwritten.
 * Returns true only for the call that performed the transition.
 */
async function markMissedCheckout(
  session: { _id: mongoose.Types.ObjectId; employeeId: mongoose.Types.ObjectId; attendanceDayId: mongoose.Types.ObjectId; checkIn: { timestamp: Date } },
  now: Date,
): Promise<boolean> {
  const deadline = checkoutDeadline(session.checkIn.timestamp);
  if (now.getTime() < deadline.getTime()) return false;

  let transitioned = false;
  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      transitioned = false;
      const expired = await AttendanceSession.findOneAndUpdate(
        { _id: session._id, isActive: true, 'checkIn.timestamp': { $lte: new Date(now.getTime() - MISSED_CHECKOUT_WINDOW_MS) } },
        {
          $set: {
            isActive: false,
            closedBySystem: true,
            systemCloseReason: 'missed-checkout' as const,
            durationMinutes: 0,
            checkOut: null,
            missedCheckoutDeadline: deadline,
            missedCheckoutDetectedAt: now,
          },
        },
        { session: mongoSession, new: true },
      );
      if (!expired) return;

      const day = await AttendanceDay.findById(session.attendanceDayId).session(mongoSession);
      if (day) {
        const isProtected = PROTECTED_DAY_STATUSES.includes(day.status) || day.isRegularized;
        await AttendanceDay.updateOne(
          { _id: day._id },
          {
            $set: {
              missedCheckoutSessionId: session._id,
              ...(isProtected ? {} : { status: 'absent', hasUnresolvedMissedCheckout: true }),
            },
          },
          { session: mongoSession },
        );
      }
      await AuditLog.create(
        [{
          performedBy: session.employeeId,
          action: 'ATTENDANCE_MISSED_CHECKOUT',
          targetType: 'AttendanceSession',
          targetId: session._id.toHexString(),
          changes: { by: 'system', deadline: deadline.toISOString(), detectedAt: now.toISOString() },
        }],
        { session: mongoSession },
      );
      transitioned = true;
    });
  } finally {
    await mongoSession.endSession();
  }
  return transitioned;
}

/**
 * Applies the 24-hour rule to every overdue active session (optionally for one
 * employee). Safe to call from any request path and from the cron.
 */
export async function reconcileMissedCheckouts(
  opts: { employeeId?: string; now?: Date } = {},
): Promise<{ expired: number }> {
  const now = opts.now ?? new Date();
  const filter: Record<string, unknown> = {
    isActive: true,
    'checkIn.timestamp': { $lte: new Date(now.getTime() - MISSED_CHECKOUT_WINDOW_MS) },
  };
  if (opts.employeeId) filter.employeeId = new mongoose.Types.ObjectId(opts.employeeId);

  const overdue = await AttendanceSession.find(filter)
    .select('_id employeeId attendanceDayId checkIn.timestamp')
    .lean();
  let expired = 0;
  for (const s of overdue ?? []) {
    if (await markMissedCheckout(s as unknown as Parameters<typeof markMissedCheckout>[0], now)) expired++;
  }
  return { expired };
}

/** Format a session for API responses. */
function formatSession(s: {
  _id: mongoose.Types.ObjectId;
  checkIn: { timestamp: Date; latitude: number; longitude: number; address?: string | null; geocodingStatus?: string };
  checkOut: { timestamp: Date } | null;
  durationMinutes: number | null;
  isActive?: boolean;
  closedBySystem: boolean;
  systemCloseReason?: string;
  isRemote: boolean;
  remoteSource?: string;
}) {
  const missedCheckout = s.systemCloseReason === 'missed-checkout';
  return {
    sessionId: s._id.toHexString(),
    checkInTimestamp: s.checkIn.timestamp.toISOString(),
    checkInLocation: { latitude: s.checkIn.latitude, longitude: s.checkIn.longitude },
    checkInAddress: s.checkIn.address ?? null,
    // Never a fabricated punch-out: a missed check-out has no checkout time.
    checkOutTimestamp: s.checkOut ? s.checkOut.timestamp.toISOString() : null,
    durationMinutes: s.durationMinutes ?? 0,
    isActive: s.isActive === true,
    closedBySystem: s.closedBySystem,
    missedCheckout,
    ...(missedCheckout && { checkoutDeadline: checkoutDeadline(s.checkIn.timestamp).toISOString() }),
    isRemote: s.isRemote,
    ...(s.remoteSource !== undefined && { remoteSource: s.remoteSource }),
  };
}

/** Format an attendance day for history/weekly/monthly responses. */
function formatDayRecord(
  day: IAttendanceDay,
  sessions: ReturnType<typeof formatSession>[],
  settings: { requiredDailyMinutes: number },
  timezone: string,
) {
  // Only a genuinely active session means "checked-in" (a missed check-out
  // also has no checkout time but is closed).
  const hasActiveSession = sessions.some((s) => s.isActive);
  const overtimeMinutes = Math.max(0, day.totalMinutes - settings.requiredDailyMinutes);
  const zonedDate = toZonedTime(day.date, timezone);
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayOfWeek = dayNames[zonedDate.getDay()];
  return {
    dateString: day.dateString,
    dayOfWeek: dayOfWeek.charAt(0).toUpperCase() + dayOfWeek.slice(1),
    status: hasActiveSession ? 'checked-in' : day.status,
    totalMinutes: day.totalMinutes,
    overtimeMinutes,
    isLateArrival: day.isLateArrival,
    lateByMinutes: day.lateByMinutes,
    isHalfDayCapped: day.isHalfDayCapped,
    isHoliday: day.status === 'holiday',
    isWeekend: day.status === 'weekend',
    isRegularized: day.isRegularized,
    hasUnresolvedMissedCheckout: day.hasUnresolvedMissedCheckout === true,
    sessions,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface CheckInInput {
  employeeId: string;
  deviceFingerprintHeader: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  nonce: string;
  clientTimestamp: string;
  clientIp?: string;
}

export interface CheckOutInput {
  employeeId: string;
  /** X-Device-Fingerprint header (raw 64-hex). Required: checkout is bound to the registered device. */
  deviceFingerprintHeader?: string;
  nonce: string;
  clientTimestamp: string;
  clientIp?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

export class AttendanceService {
  // ─── Check In ─────────────────────────────────────────────────────────────

  static async checkIn(input: CheckInInput) {
    await connectDB();

    const serverTime = new Date();
    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    if (!settings) throw new AppError('GEN_500', 500, 'Company settings not configured.');

    // Load user and employee profile
    const [user, employeeProfile] = await Promise.all([
      User.findById(input.employeeId).lean(),
      Employee.findOne({ userId: new mongoose.Types.ObjectId(input.employeeId) }).lean<IEmployee>(),
    ]);
    if (!user) throw new AppError('AUTH_003', 401, 'Unauthorized.');
    if (!user.isActive) throw new AppError('AUTH_007', 403, 'Account deactivated.');

    // Validate device fingerprint (BR-ATT-02)
    // NOTE: AUTH_004 is overloaded — here it means "malformed X-Device-Fingerprint
    // header on a check-in request"; in AuthService.login it means "no registeredDevice
    // on the user account". Same code, different meaning depending on call site. Not
    // split this phase (attendance scope) — noted for 30.10.
    if (!FINGERPRINT_REGEX.test(input.deviceFingerprintHeader)) {
      throw new AppError('AUTH_004', 401, 'Missing or malformed device fingerprint.');
    }
    if (!user.registeredDevice) {
      throw new AppError('AUTH_005', 401, 'Device fingerprint mismatch.');
    }
    const incomingHash = sha256(input.deviceFingerprintHeader);
    if (incomingHash !== user.registeredDevice.fingerprintHash) {
      throw new AppError('AUTH_005', 401, 'Device fingerprint mismatch.');
    }

    // Validate timestamp window (BR-ATT-01)
    const clientTime = new Date(input.clientTimestamp);
    const diffMs = Math.abs(serverTime.getTime() - clientTime.getTime());
    if (Number.isNaN(diffMs) || diffMs > settings.checkinTimestampWindowMinutes * 60 * 1000) {
      throw new AppError('ATT_007', 422, 'Timestamp outside allowed window.');
    }

    // Consume nonce (BR-ATT-03) — BEFORE geo-fence check (nonce consumed on geofence rejection too)
    try {
      await UsedNonce.create({ nonce: input.nonce, employeeId: new mongoose.Types.ObjectId(input.employeeId), action: 'checkin' });
    } catch (err) {
      if (isMongooseDuplicateKey(err)) throw new AppError('ATT_004', 409, 'Nonce already used.');
      throw err;
    }

    // GPS accuracy check (BR-ATT-05)
    const lowGpsAccuracy = input.accuracy > settings.gpsAccuracyThresholdMeters;
    if (lowGpsAccuracy) throw new AppError('ATT_002', 422, 'GPS accuracy too low.');

    // Mock GPS detection (BR-ATT-06)
    const possibleMockGps = input.accuracy === 0;

    // Geo-fence check (BR-ATT-04) — skipped for employees with allowOutsideGeofence=true
    const distanceFromOffice = haversineMeters(
      { latitude: input.latitude, longitude: input.longitude },
      { latitude: settings.geoFence.latitude, longitude: settings.geoFence.longitude },
    );
    const isWithinGeoFence = distanceFromOffice <= settings.geoFence.radiusMeters;
    const bypassGeofence = employeeProfile?.allowOutsideGeofence === true;
    const validationMode = settings.attendanceValidationMode ?? 'geofence';

    if (!bypassGeofence) {
      if (validationMode === 'geofence') {
        if (settings.geoFence.isEnabled && !isWithinGeoFence) {
          throw new AppError('ATT_001', 422, 'Outside geofence.');
        }
      } else if (validationMode === 'officeIp') {
        const allowedIps = settings.allowedOfficeIps ?? [];
        if (allowedIps.length === 0 || !allowedIps.includes(input.clientIp ?? '')) {
          // ATT_009 (was ATT_004, which also means "nonce already used").
          throw new AppError('ATT_009', 422, 'Not connected to the approved office network.');
        }
      }
    }

    // Compute IST date/time (BR-ATT-08)
    const timezone = settings.timezone || 'Asia/Kolkata';
    const dateString = toLocalDateString(serverTime, timezone);
    const localHHMM  = toLocalHHMM(serverTime, timezone);
    const dayOfWeek  = toLocalDayOfWeek(serverTime, timezone);

    // Determine whether this session is remote and why the geofence was bypassed.
    // In officeIp mode the geofence is not the validation gate, so bypass employees
    // are always treated as remote (they skipped the IP check, not the geofence).
    let isRemote = false;
    let remoteSource: 'employeeOverride' | 'workAwayApproval' | undefined;
    let remoteApprovalId: mongoose.Types.ObjectId | undefined;

    const treatedAsRemote = bypassGeofence && (validationMode === 'officeIp' || !isWithinGeoFence);
    if (treatedAsRemote) {
      isRemote = true;
      const workAwayReg = await Regularization.findOne({
        employeeId: new mongoose.Types.ObjectId(input.employeeId),
        dateString,
        type: { $in: ['workAwayFromOffice', 'officialTravel', 'clientVisit'] },
        status: 'approved',
      }).lean() as unknown as (IRegularization & { _id: mongoose.Types.ObjectId }) | null;
      if (workAwayReg) {
        remoteSource = 'workAwayApproval';
        remoteApprovalId = workAwayReg._id;
      } else {
        remoteSource = 'employeeOverride';
      }
    }

    // Weekend check
    const isWeekend = !settings.workingDays.includes(dayOfWeek);

    // Holiday check
    const holiday = await Holiday.findOne({ dateString }).lean();
    const isHoliday = !!holiday;

    // Late arrival computation
    const lateResult = computeDayStatus({
      totalMinutes: 0,
      checkInTime: localHHMM,
      requiredDailyMinutes: settings.requiredDailyMinutes,
      halfDayThresholdMinutes: settings.halfDayThresholdMinutes,
      halfDayLateCheckInTime: settings.halfDayLateCheckInTime,
      lateArrivalGraceMinutes: settings.lateArrivalGraceMinutes,
      workStartTime: settings.workStartTime,
      isWeekend,
      isHoliday,
    });

    // Determine initial day status
    let initialStatus: AttendanceDayStatus = 'absent';
    if (isHoliday) initialStatus = 'holiday';
    if (isWeekend) initialStatus = 'weekend';

    const [year, month] = dateString.split('-').map(Number);
    const dateOnly = new Date(dateString + 'T00:00:00.000Z');

    // 24-hour rule (docs/85): an open session blocks a new check-in until its
    // 24-hour window has elapsed — even across a calendar day. Once the window
    // has elapsed the old session becomes a missed check-out (no fabricated
    // punch-out, its day marked absent) and the new check-in proceeds.
    const existingActive = await AttendanceSession.findOne({
      employeeId: new mongoose.Types.ObjectId(input.employeeId),
      isActive: true,
    }).lean();
    if (existingActive) {
      if (!isCheckoutWindowExpired(existingActive.checkIn.timestamp, serverTime)) {
        throw new AppError('ATT_003', 409, 'Already checked in. Check out of your open session first.');
      }
      await markMissedCheckout(
        existingActive as unknown as Parameters<typeof markMissedCheckout>[0],
        serverTime,
      );
    }

    // Transaction: upsert AttendanceDay + create AttendanceSession (BR-ATT-07)
    const mongoSession = await mongoose.startSession();
    let dayDoc: IAttendanceDay;
    let sessionDoc: mongoose.Document & { _id: mongoose.Types.ObjectId };

    try {
      await mongoSession.withTransaction(async () => {
        const upserted = await AttendanceDay.findOneAndUpdate(
          { employeeId: new mongoose.Types.ObjectId(input.employeeId), dateString },
          {
            $setOnInsert: {
              date: dateOnly,
              year,
              month,
              status: initialStatus,
              totalMinutes: 0,
              requiredMinutes: settings.requiredDailyMinutes,
              overtimeMinutes: 0,
              isLateArrival: lateResult.isLateArrival,
              lateByMinutes: lateResult.lateByMinutes,
              isHalfDayCapped: lateResult.isHalfDayCapped,
              isRegularized: false,
            },
          },
          { upsert: true, new: true, session: mongoSession },
        );
        dayDoc = upserted!;

        try {
          const [created] = await AttendanceSession.create(
            [
              {
                employeeId: new mongoose.Types.ObjectId(input.employeeId),
                attendanceDayId: dayDoc._id,
                dateString,
                checkIn: {
                  latitude: input.latitude,
                  longitude: input.longitude,
                  accuracy: input.accuracy,
                  distanceFromOffice,
                  timestamp: serverTime,
                  deviceFingerprint: input.deviceFingerprintHeader,
                  nonce: input.nonce,
                  isWithinGeoFence,
                },
                checkOut: null,
                durationMinutes: null,
                isActive: true,
                closedBySystem: false,
                flags: {
                  lowGpsAccuracy,
                  outsideGeoFence: !isWithinGeoFence,
                  suspiciousTimestamp: false,
                  possibleMockGps,
                },
                isRemote,
                ...(remoteSource !== undefined && { remoteSource }),
                ...(remoteApprovalId !== undefined && { remoteApprovalId }),
              },
            ],
            { session: mongoSession },
          );
          sessionDoc = created as typeof created & { _id: mongoose.Types.ObjectId };
        } catch (err) {
          if (isMongooseDuplicateKey(err)) throw new AppError('ATT_003', 409, 'Already checked in.');
          throw err;
        }
      });
    } finally {
      await mongoSession.endSession();
    }

    // Fire-and-forget reverse geocoding — never blocks check-in response
    const sessionIdForGeo = (sessionDoc!._id as mongoose.Types.ObjectId).toHexString();
    GeocodingService.reverseGeocode(input.latitude, input.longitude)
      .then((geo) =>
        AttendanceSession.findByIdAndUpdate(sessionIdForGeo, {
          $set: {
            'checkIn.address': geo.address,
            'checkIn.geocodingStatus': geo.geocodingStatus,
            'checkIn.geocodingProvider': geo.geocodingProvider,
          },
        }),
      )
      .catch(() => {});

    // Audit log
    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(input.employeeId),
      action: 'ATTENDANCE_CHECKIN',
      targetType: 'AttendanceSession',
      targetId: sessionIdForGeo,
      // Coordinates live on the session record; the audit trail does not need
      // a second copy of the employee's location.
      changes: { dateString, isRemote },
    });

    return {
      sessionId: sessionIdForGeo,
      checkInTimestamp: serverTime.toISOString(),
      dateString,
      status: 'checked-in' as const,
      flags: {
        possibleMockGps,
        isLateArrival: lateResult.isLateArrival,
        lateByMinutes: lateResult.lateByMinutes,
        isHalfDayCapped: lateResult.isHalfDayCapped,
      },
    };
  }

  // ─── Check Out ────────────────────────────────────────────────────────────

  static async checkOut(input: CheckOutInput) {
    await connectDB();

    const serverTime = new Date();
    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    if (!settings) throw new AppError('GEN_500', 500, 'Company settings not configured.');

    const employeeOid = new mongoose.Types.ObjectId(input.employeeId);

    // Account + device binding (same rules as check-in, BR-ATT-02). Checkout
    // must come from the registered device, not just any holder of the token.
    const user = await User.findById(input.employeeId).lean();
    if (!user) throw new AppError('AUTH_003', 401, 'Unauthorized.');
    if (!user.isActive) throw new AppError('AUTH_007', 403, 'Account deactivated.');
    const fingerprint = input.deviceFingerprintHeader ?? '';
    if (!FINGERPRINT_REGEX.test(fingerprint)) {
      throw new AppError('AUTH_004', 401, 'Missing or malformed device fingerprint.');
    }
    if (!user.registeredDevice || sha256(fingerprint) !== user.registeredDevice.fingerprintHash) {
      throw new AppError('AUTH_005', 401, 'Device fingerprint mismatch.');
    }

    // Find active session (BR-ATT-09)
    const activeSession = await AttendanceSession.findOne({
      employeeId: employeeOid,
      isActive: true,
    });
    if (!activeSession) throw new AppError('ATT_005', 422, 'No active session found.');

    // 24-hour rule: at or after checkIn + 24 h the session can no longer be
    // checked out. It becomes a missed check-out (no punch-out recorded) and
    // the employee must use regularization or leave.
    if (isCheckoutWindowExpired(activeSession.checkIn.timestamp, serverTime)) {
      await markMissedCheckout(
        activeSession as unknown as Parameters<typeof markMissedCheckout>[0],
        serverTime,
      );
      throw new AppError(
        'ATT_011',
        422,
        'The 24-hour check-out window for this session has passed. It is recorded as a missed check-out; please submit a regularization or leave request.',
      );
    }

    // Validate timestamp window (BR-ATT-10)
    const clientTime = new Date(input.clientTimestamp);
    const diffMs = Math.abs(serverTime.getTime() - clientTime.getTime());
    if (Number.isNaN(diffMs) || diffMs > settings.checkinTimestampWindowMinutes * 60 * 1000) {
      throw new AppError('ATT_007', 422, 'Timestamp outside allowed window.');
    }

    // Location policy at checkout — same rules as check-in.
    const checkoutEmployeeProfile = await Employee.findOne({ userId: employeeOid }).lean<IEmployee>();
    const checkoutBypassGeofence = checkoutEmployeeProfile?.allowOutsideGeofence === true;
    const checkoutValidationMode = settings.attendanceValidationMode ?? 'geofence';
    const hasCheckoutLocation =
      input.latitude !== undefined && input.longitude !== undefined && input.accuracy !== undefined;
    // An ordinary (non-override) employee under an ENABLED geofence must prove
    // where they are. Missing coordinates are rejected — never assumed inside.
    const locationRequired =
      !checkoutBypassGeofence && checkoutValidationMode === 'geofence' && settings.geoFence.isEnabled;

    if (locationRequired && !hasCheckoutLocation) {
      throw new AppError(
        'ATT_010',
        422,
        'Location is required to check out. Turn on location services, allow location access for the app, and try again.',
      );
    }
    if (locationRequired && input.accuracy! > settings.gpsAccuracyThresholdMeters) {
      throw new AppError('ATT_002', 422, 'GPS accuracy too low.');
    }

    const checkoutDistanceFromOffice = hasCheckoutLocation
      ? haversineMeters(
          { latitude: input.latitude!, longitude: input.longitude! },
          { latitude: settings.geoFence.latitude, longitude: settings.geoFence.longitude },
        )
      : 0;
    // Unverified (no coordinates) is recorded as NOT within the fence.
    const checkoutIsWithinGeoFence = hasCheckoutLocation
      ? checkoutDistanceFromOffice <= settings.geoFence.radiusMeters
      : false;

    if (!checkoutBypassGeofence) {
      if (checkoutValidationMode === 'officeIp') {
        const allowedIps = settings.allowedOfficeIps ?? [];
        if (allowedIps.length === 0 || !allowedIps.includes(input.clientIp ?? '')) {
          throw new AppError('ATT_009', 422, 'Not connected to the approved office network.');
        }
      } else if (locationRequired && !checkoutIsWithinGeoFence) {
        throw new AppError('ATT_001', 422, 'Outside geofence.');
      }
    }

    // Consume nonce (BR-ATT-11) — after cheap validation so a GPS failure does
    // not burn the nonce; replay is still impossible (unique index).
    try {
      await UsedNonce.create({ nonce: input.nonce, employeeId: employeeOid, action: 'checkout' });
    } catch (err) {
      if (isMongooseDuplicateKey(err)) throw new AppError('ATT_004', 409, 'Nonce already used.');
      throw err;
    }

    // Compute duration
    // Whole minutes actually elapsed (floor): never credits unworked seconds,
    // and a check-out 1 s before the 24-hour deadline cannot read as "24 h".
    const durationMinutes = Math.max(0, Math.floor(
      (serverTime.getTime() - activeSession.checkIn.timestamp.getTime()) / 60_000,
    ));

    let newTotalMinutes = 0;
    let overtimeMinutes = 0;
    let newStatus: AttendanceDayStatus = 'absent';
    let dayDateString = activeSession.dateString;

    // Transaction: close session + update day (BR-ATT-12). The session close is
    // conditional on isActive:true so concurrent/duplicate checkouts cannot
    // double-count minutes; minutes are added with $inc, not read-modify-write.
    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        // Conditional on still-active AND still inside the 24-hour window, so a
        // check-out racing the deadline (or the reconciler) cannot both succeed.
        const closed = await AttendanceSession.findOneAndUpdate(
          {
            _id: activeSession._id,
            isActive: true,
            'checkIn.timestamp': { $gt: new Date(serverTime.getTime() - MISSED_CHECKOUT_WINDOW_MS) },
          },
          {
            $set: {
              isActive: false,
              durationMinutes,
              checkOut: {
                timestamp: serverTime,
                nonce: input.nonce,
                latitude: hasCheckoutLocation ? input.latitude! : 0,
                longitude: hasCheckoutLocation ? input.longitude! : 0,
                accuracy: hasCheckoutLocation ? input.accuracy! : 0,
                distanceFromOffice: checkoutDistanceFromOffice,
                deviceFingerprint: fingerprint,
                isWithinGeoFence: checkoutIsWithinGeoFence,
                locationProvided: hasCheckoutLocation,
              },
            },
          },
          { session: mongoSession, new: true },
        );
        if (!closed) throw new AppError('ATT_005', 422, 'No active session found.');

        const day = await AttendanceDay.findByIdAndUpdate(
          activeSession.attendanceDayId,
          { $inc: { totalMinutes: durationMinutes } },
          { session: mongoSession, new: true },
        );
        if (!day) throw new AppError('GEN_002', 404, 'Attendance day record not found.');

        newTotalMinutes = day.totalMinutes;
        overtimeMinutes = Math.max(0, newTotalMinutes - settings.requiredDailyMinutes);
        newStatus = deriveDayStatus(newTotalMinutes, day.isHalfDayCapped, day.status, settings);
        dayDateString = day.dateString;
        await AttendanceDay.findByIdAndUpdate(
          day._id,
          { $set: { overtimeMinutes, status: newStatus } },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }
    const day = { dateString: dayDateString };

    // Audit log
    await AuditLog.create({
      performedBy: new mongoose.Types.ObjectId(input.employeeId),
      action: 'ATTENDANCE_CHECKOUT',
      targetType: 'AttendanceSession',
      targetId: (activeSession._id as mongoose.Types.ObjectId).toHexString(),
      changes: { dateString: day.dateString, durationMinutes, totalMinutes: newTotalMinutes },
    });

    return {
      sessionId: (activeSession._id as mongoose.Types.ObjectId).toHexString(),
      checkInTimestamp: activeSession.checkIn.timestamp.toISOString(),
      checkOutTimestamp: serverTime.toISOString(),
      durationMinutes,
      day: {
        dateString: day.dateString,
        status: newStatus,
        totalMinutes: newTotalMinutes,
        overtimeMinutes,
      },
    };
  }

  // ─── Today Status (BR-ATT-15 to BR-ATT-17) ───────────────────────────────

  static async getStatus(employeeId: string) {
    await connectDB();

    const now = new Date();
    // Apply the 24-hour rule first so an overdue session is never reported as
    // "checked in" (works even if the nightly cron has not run yet).
    await reconcileMissedCheckouts({ employeeId, now });

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const timezone = settings?.timezone || 'Asia/Kolkata';
    const dateString = toLocalDateString(now, timezone);
    const empOid = new mongoose.Types.ObjectId(employeeId);

    // Unresolved missed check-outs inside the regularization window (oldest
    // actionable first is not needed — the most recent one drives the banner).
    const lookbackDays = settings?.regularizationLookbackDays ?? 30;
    const lookbackStart = toLocalDateString(new Date(now.getTime() - lookbackDays * 86_400_000), timezone);

    const [day, activeSession, allSessions, unresolvedDays] = await Promise.all([
      AttendanceDay.findOne({ employeeId: empOid, dateString }).lean(),
      AttendanceSession.findOne({ employeeId: empOid, isActive: true }).lean(),
      AttendanceSession.find({ employeeId: empOid, dateString }).lean(),
      AttendanceDay.find({
        employeeId: empOid,
        hasUnresolvedMissedCheckout: true,
        dateString: { $gte: lookbackStart },
      }).sort({ dateString: -1 }).lean(),
    ]);

    const totalMinutes = day?.totalMinutes ?? 0;
    const requiredMinutes = settings?.requiredDailyMinutes ?? 540;

    const isCheckedIn = !!activeSession;
    const runningMinutes = activeSession
      ? Math.max(0, Math.floor((now.getTime() - activeSession.checkIn.timestamp.getTime()) / 60_000))
      : 0;

    // Banner data for the most recent unresolved missed check-out.
    const latestMissed = (unresolvedDays ?? [])[0];
    let staleSession: { dateString: string; checkInTimestamp: string | null } | null = null;
    if (latestMissed) {
      const missedSession = latestMissed.missedCheckoutSessionId
        ? await AttendanceSession.findById(latestMissed.missedCheckoutSessionId).select('checkIn.timestamp').lean()
        : null;
      staleSession = {
        dateString: latestMissed.dateString,
        checkInTimestamp: missedSession?.checkIn?.timestamp?.toISOString() ?? null,
      };
    }

    const sessions = (allSessions ?? []).map((s) => ({
      sessionId: (s._id as mongoose.Types.ObjectId).toHexString(),
      checkInTimestamp: s.checkIn.timestamp.toISOString(),
      checkInAddress: s.checkIn.address ?? null,
      // Missed check-outs have no checkout and 0 minutes — never fabricated.
      checkOutTimestamp: s.checkOut ? s.checkOut.timestamp.toISOString() : null,
      durationMinutes: s.isActive ? runningMinutes : (s.durationMinutes ?? 0),
      isActive: s.isActive === true,
      closedBySystem: s.closedBySystem,
      missedCheckout: s.systemCloseReason === 'missed-checkout',
      isRemote: s.isRemote,
      ...(s.remoteSource !== undefined && { remoteSource: s.remoteSource }),
    }));

    return {
      isCheckedIn,
      // True while an unresolved missed check-out exists in the regularization
      // window. Independent of isCheckedIn (the employee may already have
      // started a new day).
      forgotCheckout: !!latestMissed,
      unresolvedMissedCheckoutDates: (unresolvedDays ?? []).map((d) => d.dateString),
      todayDateString: dateString,
      currentSession: isCheckedIn && activeSession
        ? {
            sessionId: (activeSession._id as mongoose.Types.ObjectId).toHexString(),
            checkInTimestamp: activeSession.checkIn.timestamp.toISOString(),
            // Clients reset the timer to 00:00:00 at this instant and re-sync.
            checkoutDeadline: checkoutDeadline(activeSession.checkIn.timestamp).toISOString(),
            checkInLocation: {
              latitude: activeSession.checkIn.latitude,
              longitude: activeSession.checkIn.longitude,
            },
            checkInAddress: activeSession.checkIn.address ?? null,
            elapsedMinutes: runningMinutes,
            remainingMinutes: Math.max(0, requiredMinutes - totalMinutes - runningMinutes),
            isRemote: activeSession.isRemote,
            ...(activeSession.remoteSource !== undefined && { remoteSource: activeSession.remoteSource }),
          }
        : null,
      staleSession,
      todaySummary: {
        totalMinutes,
        status: isCheckedIn ? 'checked-in' : (day?.status ?? 'absent'),
        sessions,
      },
    };
  }

  // ─── History ──────────────────────────────────────────────────────────────

  static async getHistory(
    employeeId: string,
    query: { startDate: string; endDate: string; status?: string; page: number; limit: number },
  ) {
    await connectDB();
    await reconcileMissedCheckouts({ employeeId });

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const timezone = settings?.timezone || 'Asia/Kolkata';
    const workingDays: WeekDay[] = settings?.workingDays ?? [];

    const empObjectId = new mongoose.Types.ObjectId(employeeId);
    const todayStr = toLocalDateString(new Date(), timezone);

    // Fetch all existing days in range un-paginated (range is ≤ 31 days)
    const existingDays = await AttendanceDay.find({
      employeeId: empObjectId,
      dateString: { $gte: query.startDate, $lte: query.endDate },
    }).sort({ dateString: 1 }).lean();

    // Holidays in range — exclude from synthetic absent generation
    const holidays = await Holiday.find({
      dateString: { $gte: query.startDate, $lte: query.endDate },
    }).select('dateString').lean();
    const holidaySet = new Set(holidays.map((h) => h.dateString));

    const existingByDate = new Map(existingDays.map((d) => [d.dateString, d]));

    // Build merged list: real docs + synthetic absent for past working days with no doc
    type RealEntry = { real: true; doc: typeof existingDays[0] };
    type SyntheticEntry = { real: false; dateString: string };
    const merged: Array<RealEntry | SyntheticEntry> = [];

    // Iterate at noon UTC so no timezone boundary can flip the calendar date
    const cursor = new Date(query.startDate + 'T12:00:00Z');
    const endLimit = new Date(query.endDate + 'T12:00:00Z');
    while (cursor <= endLimit) {
      const ds = toLocalDateString(cursor, timezone);
      if (existingByDate.has(ds)) {
        merged.push({ real: true, doc: existingByDate.get(ds)! });
      } else if (ds <= todayStr && !holidaySet.has(ds)) {
        const dow = toLocalDayOfWeek(cursor, timezone);
        if (workingDays.includes(dow)) {
          merged.push({ real: false, dateString: ds });
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // Apply optional status filter
    const filtered = query.status
      ? merged.filter((item) =>
          item.real
            ? (item as RealEntry).doc.status === query.status
            : query.status === 'absent',
        )
      : merged;

    const total = filtered.length;
    const paginated = filtered.slice((query.page - 1) * query.limit, query.page * query.limit);

    // Load sessions only for real days on this page
    const realPageDayIds = paginated
      .filter((item): item is RealEntry => item.real)
      .map((item) => item.doc._id as mongoose.Types.ObjectId);

    const sessions = await AttendanceSession.find({ attendanceDayId: { $in: realPageDayIds } })
      .sort({ 'checkIn.timestamp': 1 })
      .lean();

    const sessionsByDay = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const key = (s.attendanceDayId as mongoose.Types.ObjectId).toHexString();
      if (!sessionsByDay.has(key)) sessionsByDay.set(key, []);
      sessionsByDay.get(key)!.push(s);
    }

    const settingsObj = settings ?? { requiredDailyMinutes: 540 };
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    const data = paginated.map((item) => {
      if (item.real) {
        const { doc } = item as RealEntry;
        const daySessions = sessionsByDay.get((doc._id as mongoose.Types.ObjectId).toHexString()) ?? [];
        return formatDayRecord(
          doc as unknown as IAttendanceDay,
          daySessions.map(formatSession),
          settingsObj,
          timezone,
        );
      }
      // Synthetic absent — past working day with no AttendanceDay document
      const { dateString } = item as SyntheticEntry;
      const zonedDate = toZonedTime(new Date(dateString + 'T12:00:00Z'), timezone);
      const dayName = dayNames[zonedDate.getDay()];
      return {
        dateString,
        dayOfWeek: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        status: 'absent' as const,
        totalMinutes: 0,
        overtimeMinutes: 0,
        isLateArrival: false,
        lateByMinutes: 0,
        isHalfDayCapped: false,
        isHoliday: false,
        isWeekend: false,
        isRegularized: false,
        sessions: [],
      };
    });

    return {
      data,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  // ─── Today — Admin Dashboard (§5.5) ───────────────────────────────────────

  static async getTodayAllEmployees(query: {
    status?: string;
    department?: string;
    page: number;
    limit: number;
  }) {
    await connectDB();
    await reconcileMissedCheckouts();

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const timezone = settings?.timezone || 'Asia/Kolkata';
    const dateString = toLocalDateString(new Date(), timezone);

    // Build employee filter
    const empFilter: Record<string, unknown> = { isActive: true, role: 'employee' };
    if (query.department) empFilter.department = query.department;

    const [allEmployees, total] = await Promise.all([
      User.find(empFilter)
        .select('_id employeeId firstName lastName department')
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      User.countDocuments(empFilter),
    ]);

    const employeeIds = allEmployees.map((e) => e._id);

    const [days, activeSessions] = await Promise.all([
      AttendanceDay.find({ employeeId: { $in: employeeIds }, dateString }).lean(),
      AttendanceSession.find({ employeeId: { $in: employeeIds }, isActive: true }).lean(),
    ]);

    const dayByEmployee = new Map(days.map((d) => [(d.employeeId as mongoose.Types.ObjectId).toHexString(), d]));
    const activeSessionByEmployee = new Map(activeSessions.map((s) => [(s.employeeId as mongoose.Types.ObjectId).toHexString(), s]));
    const now = Date.now();

    const data = allEmployees
      .map((emp) => {
        const empIdStr = (emp._id as mongoose.Types.ObjectId).toHexString();
        const day = dayByEmployee.get(empIdStr);
        const active = activeSessionByEmployee.get(empIdStr);
        const isCheckedIn = !!active;
        const elapsedMinutes = active
          ? Math.round((now - active.checkIn.timestamp.getTime()) / 60_000)
          : 0;

        const derivedStatus = isCheckedIn ? 'checked-in' : day ? 'checked-out' : 'absent';
        if (query.status && derivedStatus !== query.status) return null;

        return {
          employeeId: emp.employeeId,
          firstName: emp.firstName,
          lastName: emp.lastName,
          department: emp.department ?? null,
          isCheckedIn,
          checkInTime: active ? active.checkIn.timestamp.toISOString() : null,
          elapsedMinutes,
          dayStatus: day?.status ?? 'absent',
          totalMinutesToday: (day?.totalMinutes ?? 0) + elapsedMinutes,
        };
      })
      .filter(Boolean);

    return {
      data,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  // ─── Weekly Summary (§5.6) ────────────────────────────────────────────────

  static async getWeekly(employeeId: string, weekStr?: string) {
    await connectDB();
    await reconcileMissedCheckouts({ employeeId });

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const timezone = settings?.timezone || 'Asia/Kolkata';

    // Parse week string YYYY-Www or default to current week
    let monday: Date;
    if (weekStr) {
      const [yearStr, weekNumStr] = weekStr.split('-W');
      const year = parseInt(yearStr, 10);
      const weekNum = parseInt(weekNumStr, 10);
      const jan4 = new Date(year, 0, 4);
      const dayOfWeek = jan4.getDay() || 7;
      monday = new Date(jan4.getTime() + (weekNum - 1) * 7 * 86_400_000 - (dayOfWeek - 1) * 86_400_000);
    } else {
      const now = toZonedTime(new Date(), timezone);
      const dow = now.getDay() || 7;
      monday = new Date(now.getTime() - (dow - 1) * 86_400_000);
      monday.setHours(0, 0, 0, 0);
    }

    const sunday = new Date(monday.getTime() + 6 * 86_400_000);
    const startDate = monday.toISOString().split('T')[0];
    const endDate   = sunday.toISOString().split('T')[0];

    const result = await this.getHistory(employeeId, { startDate, endDate, page: 1, limit: 7 });
    const totalMinutes = result.data.reduce((sum, d) => sum + d.totalMinutes, 0);
    const totalOvertimeMinutes = result.data.reduce((sum, d) => sum + d.overtimeMinutes, 0);

    const isoWeek = weekStr ?? (() => {
      const year = monday.getFullYear();
      const jan4 = new Date(year, 0, 4);
      const dayOfJan4 = jan4.getDay() || 7;
      const weekNum = Math.ceil(((monday.getTime() - jan4.getTime()) / 86_400_000 + dayOfJan4) / 7);
      return `${year}-W${String(weekNum).padStart(2, '0')}`;
    })();

    return {
      week: isoWeek,
      startDate,
      endDate,
      totalMinutes,
      totalOvertimeMinutes,
      days: result.data,
    };
  }

  // ─── Monthly Summary (§5.7) ───────────────────────────────────────────────

  static async getMonthly(employeeId: string, yearMonthStr?: string) {
    await connectDB();
    await reconcileMissedCheckouts({ employeeId });

    const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const timezone = settings?.timezone || 'Asia/Kolkata';

    const yearMonth = yearMonthStr ?? formatInTimeZone(new Date(), timezone, 'yyyy-MM');
    const [yearStr, monthStr] = yearMonth.split('-');
    const year  = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const startDate = `${yearMonth}-01`;
    const lastDay   = new Date(year, month, 0).getDate();
    const endDate   = `${yearMonth}-${String(lastDay).padStart(2, '0')}`;

    const result = await this.getHistory(employeeId, { startDate, endDate, page: 1, limit: 100 });

    const summary = {
      workingDaysInMonth: 0,
      presentDays: 0,
      halfDays: 0,
      absentDays: 0,
      leaveDays: 0,
      holidayDays: 0,
      weekendDays: 0,
      totalMinutes: 0,
      overtimeMinutes: 0,
    };

    const workingDays = settings?.workingDays ?? ['monday','tuesday','wednesday','thursday','friday'];
    // Count working days in month
    const current = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    while (current <= end) {
      const dow = toLocalDayOfWeek(current, timezone);
      if (workingDays.includes(dow)) summary.workingDaysInMonth++;
      current.setDate(current.getDate() + 1);
    }

    for (const d of result.data) {
      summary.totalMinutes += d.totalMinutes;
      summary.overtimeMinutes += d.overtimeMinutes;
      if (d.status === 'present') summary.presentDays++;
      else if (d.status === 'half-day') summary.halfDays++;
      else if (d.status === 'absent') summary.absentDays++;
      else if (d.status === 'leave' || d.status === 'lwp') summary.leaveDays++;
      else if (d.status === 'holiday') summary.holidayDays++;
      else if (d.status === 'weekend') summary.weekendDays++;
    }

    return { yearMonth, summary, days: result.data };
  }

  // ─── Auto Close Sessions (midnight rollover cron) ─────────────────────────

  /**
   * Scheduled sweep for the 24-hour missed-check-out rule. Idempotent: safe to
   * run late, early, repeatedly or concurrently (Vercel may deliver a cron run
   * more than once). Request paths call reconcileMissedCheckouts() too, so a
   * delayed cron never delays what users see.
   */
  static async reconcileMissedCheckouts(now: Date = new Date()): Promise<{ expired: number }> {
    await connectDB();
    return reconcileMissedCheckouts({ now });
  }

  // ─── Admin List (§5.8) — cross-employee attendance list for admin portal ────

  static async adminList(query: {
    date?: string;
    startDate?: string;
    endDate?: string;
    employeeId?: string;
    status?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    await connectDB();
    await reconcileMissedCheckouts();

    const filter: Record<string, unknown> = {};

    // Date range
    if (query.date) {
      filter.dateString = query.date;
    } else if (query.startDate || query.endDate) {
      const range: Record<string, string> = {};
      if (query.startDate) range.$gte = query.startDate;
      if (query.endDate)   range.$lte = query.endDate;
      filter.dateString = range;
    }

    if (query.status) filter.status = query.status;

    // Employee filter (explicit ID takes precedence over search)
    if (query.employeeId) {
      filter.employeeId = new mongoose.Types.ObjectId(query.employeeId);
    } else if (query.search) {
      const safe  = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safe, 'i');
      const matchingUsers = await User.find(
        { $or: [{ firstName: regex }, { lastName: regex }, { employeeId: regex }] },
      ).select('_id').lean();
      filter.employeeId = { $in: matchingUsers.map((u) => u._id) };
    }

    const skip = (query.page - 1) * query.limit;
    const [days, total] = await Promise.all([
      AttendanceDay.find(filter)
        .populate('employeeId', 'firstName lastName employeeId email department')
        .sort({ dateString: -1 })
        .skip(skip)
        .limit(query.limit)
        .lean(),
      AttendanceDay.countDocuments(filter),
    ]);

    // Batch-fetch first check-in / last check-out for all returned days
    const dayIds = days.map((d) => d._id as mongoose.Types.ObjectId);
    const sessions = await AttendanceSession.find({ attendanceDayId: { $in: dayIds } })
      .select('attendanceDayId checkIn.timestamp checkOut.timestamp systemCloseReason isActive')
      .sort({ 'checkIn.timestamp': 1 })
      .lean();
    const adminSettings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const adminTz = adminSettings?.timezone || 'Asia/Kolkata';

    const sessionsByDay = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const key = (s.attendanceDayId as mongoose.Types.ObjectId).toHexString();
      if (!sessionsByDay.has(key)) sessionsByDay.set(key, []);
      sessionsByDay.get(key)!.push(s);
    }

    type PopulatedEmp = { _id: mongoose.Types.ObjectId; firstName: string; lastName: string; employeeId: string; email: string; department?: string };

    const data = days.map((day) => {
      const dayId   = (day._id as mongoose.Types.ObjectId).toHexString();
      const ss      = sessionsByDay.get(dayId) ?? [];
      const first   = ss[0];
      const last    = ss[ss.length - 1];
      const emp     = day.employeeId as unknown as PopulatedEmp | null;

      return {
        _id:          dayId,
        employeeId:   emp
          ? { _id: emp._id.toHexString(), firstName: emp.firstName, lastName: emp.lastName, employeeId: emp.employeeId, email: emp.email, department: emp.department ?? null }
          : (day.employeeId as mongoose.Types.ObjectId).toHexString(),
        date:         (day.date as Date).toISOString(),
        dateString:   day.dateString,
        status:       day.status,
        // HH:mm in the COMPANY timezone (was UTC — off by 5:30 for IST).
        checkIn:      first  ? toLocalHHMM(first.checkIn.timestamp, adminTz) : null,
        checkOut:     (last && last.checkOut) ? toLocalHHMM(last.checkOut.timestamp, adminTz) : null,
        // Missed check-out: no punch-out exists (never fabricated).
        missedCheckout: ss.some((x) => x.systemCloseReason === 'missed-checkout'),
        hasUnresolvedMissedCheckout: day.hasUnresolvedMissedCheckout === true,
        isCheckedIn:  ss.some((x) => x.isActive),
        workHours:    day.totalMinutes > 0 ? Math.round((day.totalMinutes / 60) * 10) / 10 : null,
        isRegularized: day.isRegularized,
        createdAt:    (day.createdAt as Date).toISOString(),
      };
    });

    return {
      data,
      pagination: {
        page:       query.page,
        limit:      query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }
}
