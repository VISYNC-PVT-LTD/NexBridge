import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import mongoose from 'mongoose';

// Simulate already-connected DB so connectDB returns immediately
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

import { AttendanceService, isCheckoutWindowExpired, checkoutDeadline, MISSED_CHECKOUT_WINDOW_MS } from '@services/AttendanceService';
import { User } from '@models/User';
import { CompanySettings } from '@models/CompanySettings';
import { AttendanceDay } from '@models/AttendanceDay';
import { AttendanceSession } from '@models/AttendanceSession';
import { UsedNonce } from '@models/UsedNonce';
import { Holiday } from '@models/Holiday';
import { Employee } from '@models/Employee';
import { Regularization } from '@models/Regularization';
import { AuditLog } from '@models/AuditLog';
import { createHash } from 'crypto';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMP_ID      = new mongoose.Types.ObjectId().toHexString();
const EMP_OID     = new mongoose.Types.ObjectId(EMP_ID);
const DAY_OID     = new mongoose.Types.ObjectId();
const SESSION_OID = new mongoose.Types.ObjectId();
const NONCE       = '550e8400-e29b-41d4-a716-446655440000';
const FINGERPRINT = 'a'.repeat(64);
const TIMESTAMP   = new Date().toISOString();
const CHECKOUT_BASE = {
  employeeId: EMP_ID,
  deviceFingerprintHeader: FINGERPRINT,
  nonce: NONCE,
  clientTimestamp: TIMESTAMP,
  latitude: 12.9,
  longitude: 77.6,
  accuracy: 10,
};

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    timezone: 'Asia/Kolkata',
    workStartTime: '09:00',
    workEndTime: '18:00',
    requiredDailyMinutes: 540,
    halfDayThresholdMinutes: 270,
    halfDayLateCheckInTime: '13:00',
    lateArrivalGraceMinutes: 15,
    workingDays: ['monday','tuesday','wednesday','thursday','friday'],
    geoFence: { isEnabled: true, latitude: 12.9, longitude: 77.6, radiusMeters: 200 },
    gpsAccuracyThresholdMeters: 100,
    checkinTimestampWindowMinutes: 60, // generous window for tests
    sessionAutoClosePaddingMinutes: 30,
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: EMP_OID,
    employeeId: 'EMP001',
    firstName: 'Jane',
    lastName: 'Doe',
    isActive: true,
    registeredDevice: {
      fingerprintHash: createHash('sha256').update(FINGERPRINT).digest('hex'),
      deviceName: 'Pixel 8',
      platform: 'android',
    },
    ...overrides,
  };
}

function makeActiveSession(overrides: Record<string, unknown> = {}) {
  const checkInTime = new Date(Date.now() - 60 * 60 * 1000); // 1hr ago
  return {
    _id: SESSION_OID,
    employeeId: EMP_OID,
    attendanceDayId: DAY_OID,
    dateString: new Date().toISOString().split('T')[0],
    checkIn: {
      timestamp: checkInTime,
      latitude: 12.9,
      longitude: 77.6,
      accuracy: 10,
      distanceFromOffice: 50,
      deviceFingerprint: FINGERPRINT,
      nonce: NONCE,
      isWithinGeoFence: true,
    },
    checkOut: null,
    durationMinutes: null,
    isActive: true,
    closedBySystem: false,
    flags: { lowGpsAccuracy: false, outsideGeoFence: false, suspiciousTimestamp: false, possibleMockGps: false },
    ...overrides,
  };
}

function makeDay(overrides: Record<string, unknown> = {}) {
  const today = new Date().toISOString().split('T')[0];
  const [year, month] = today.split('-').map(Number);
  return {
    _id: DAY_OID,
    employeeId: EMP_OID,
    dateString: today,
    date: new Date(today + 'T00:00:00Z'),
    year,
    month,
    status: 'absent',
    totalMinutes: 0,
    requiredMinutes: 540,
    overtimeMinutes: 0,
    isLateArrival: false,
    lateByMinutes: 0,
    isHalfDayCapped: false,
    isRegularized: false,
    ...overrides,
  };
}

function mockTransaction() {
  const session = {
    withTransaction: jest.fn().mockImplementation(async (fn: () => Promise<void>) => fn()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session as unknown as mongoose.ClientSession);
  return session;
}

// Chainable mock helpers
function mockFindByIdLean(model: { findById: (...args: unknown[]) => unknown }, resolveWith: unknown) {
  jest.spyOn(model, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue(resolveWith),
  } as unknown as ReturnType<typeof User.findById>);
}

function mockFindOneLean(model: { findOne: (...args: unknown[]) => unknown }, resolveWith: unknown) {
  jest.spyOn(model, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(resolveWith),
  } as unknown as ReturnType<typeof AttendanceDay.findOne>);
}

function mockFindLean(model: { find: (...args: unknown[]) => unknown }, resolveWith: unknown) {
  jest.spyOn(model, 'find').mockReturnValue({
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(resolveWith),
  } as unknown as ReturnType<typeof AttendanceSession.find>);
}

// Setup standard checkin spies (after nonce consumed, no geo issue)
function setupCheckinSuccess() {
  mockFindByIdLean(User, makeUser());
  jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);
  mockTransaction();
  jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue(makeDay() as never);
  jest.spyOn(AttendanceSession, 'create').mockResolvedValue([makeActiveSession()] as never);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.spyOn(CompanySettings, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue(makeSettings()),
  } as unknown as ReturnType<typeof CompanySettings.findById>);
  jest.spyOn(AuditLog, 'create').mockResolvedValue({} as never);
  jest.spyOn(Holiday, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof Holiday.findOne>);
  // Current contract: check-in/out also load the Employee profile (geofence
  // override flag) and, on check-in, look for a stale active session and an
  // approved work-away regularization. Default: ordinary employee, no
  // override, no stale session, no work-away approval.
  jest.spyOn(Employee, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof Employee.findOne>);
  jest.spyOn(Regularization, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof Regularization.findOne>);
  jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof AttendanceSession.findOne>);
  // 24-hour rule: read paths reconcile overdue sessions first (default: none)
  // and getStatus looks up unresolved missed check-out days (default: none).
  mockFindLean(AttendanceSession, []);
  jest.spyOn(AttendanceDay, 'find').mockReturnValue({
    sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof AttendanceDay.find>);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── U-ATT-01: checkIn — device fingerprint validation ────────────────────────

describe('U-ATT-01: checkIn device fingerprint validation', () => {
  it('throws AUTH_005 when fingerprint hash does not match', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);

    await expect(
      AttendanceService.checkIn({
        employeeId: EMP_ID,
        deviceFingerprintHeader: 'b'.repeat(64), // wrong fingerprint
        latitude: 12.9,
        longitude: 77.6,
        accuracy: 10,
        nonce: NONCE,
        clientTimestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_005' });
  });

  it('throws AUTH_004 when fingerprint header is not 64-char hex', async () => {
    mockFindByIdLean(User, makeUser());

    await expect(
      AttendanceService.checkIn({
        employeeId: EMP_ID,
        deviceFingerprintHeader: 'tooshort',
        latitude: 12.9,
        longitude: 77.6,
        accuracy: 10,
        nonce: NONCE,
        clientTimestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_004' });
  });
});

// ─── U-ATT-02: checkIn — nonce replay prevention ──────────────────────────────

describe('U-ATT-02: checkIn nonce replay prevention', () => {
  it('throws ATT_004 when nonce already used (duplicate key 11000)', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(UsedNonce, 'create').mockRejectedValue({ code: 11000 } as never);

    await expect(
      AttendanceService.checkIn({
        employeeId: EMP_ID,
        deviceFingerprintHeader: FINGERPRINT,
        latitude: 12.9,
        longitude: 77.6,
        accuracy: 10,
        nonce: NONCE,
        clientTimestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ code: 'ATT_004' });
  });
});

// ─── U-ATT-03: checkIn — geofence enforcement ────────────────────────────────

describe('U-ATT-03: checkIn geofence enforcement', () => {
  it('throws ATT_001 when outside geofence and fence is enabled', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);

    await expect(
      AttendanceService.checkIn({
        employeeId: EMP_ID,
        deviceFingerprintHeader: FINGERPRINT,
        latitude:  0,   // far from office at 12.9, 77.6
        longitude: 0,
        accuracy: 10,
        nonce: NONCE,
        clientTimestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ code: 'ATT_001' });
  });

  it('does NOT throw when geofence is disabled even if outside', async () => {
    jest.spyOn(CompanySettings, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(
        makeSettings({ geoFence: { isEnabled: false, latitude: 12.9, longitude: 77.6, radiusMeters: 200 } }),
      ),
    } as unknown as ReturnType<typeof CompanySettings.findById>);
    mockFindByIdLean(User, makeUser());
    jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);
    const txSession = mockTransaction();
    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue(makeDay() as never);
    jest.spyOn(AttendanceSession, 'create').mockResolvedValue([makeActiveSession()] as never);

    const result = await AttendanceService.checkIn({
      employeeId: EMP_ID,
      deviceFingerprintHeader: FINGERPRINT,
      latitude:  0,
      longitude: 0,
      accuracy: 10,
      nonce: NONCE,
      clientTimestamp: TIMESTAMP,
    });
    expect(result.status).toBe('checked-in');
    expect(txSession.withTransaction).toHaveBeenCalled();
  });
});

// ─── U-ATT-04: checkIn — GPS accuracy rejection ───────────────────────────────

describe('U-ATT-04: checkIn GPS accuracy rejection', () => {
  it('throws ATT_002 when accuracy exceeds threshold', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);

    await expect(
      AttendanceService.checkIn({
        employeeId: EMP_ID,
        deviceFingerprintHeader: FINGERPRINT,
        latitude: 12.9,
        longitude: 77.6,
        accuracy: 500, // > 100m threshold
        nonce: NONCE,
        clientTimestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ code: 'ATT_002' });
  });
});

// ─── U-ATT-05: checkIn — mock GPS detection ───────────────────────────────────

describe('U-ATT-05: checkIn mock GPS detection', () => {
  it('sets possibleMockGps flag when accuracy === 0', async () => {
    setupCheckinSuccess();

    const result = await AttendanceService.checkIn({
      employeeId: EMP_ID,
      deviceFingerprintHeader: FINGERPRINT,
      latitude: 12.9,
      longitude: 77.6,
      accuracy: 0,
      nonce: NONCE,
      clientTimestamp: TIMESTAMP,
    });
    expect(result.flags.possibleMockGps).toBe(true);
  });
});

// ─── U-ATT-06: checkIn — duplicate active session prevention ─────────────────

describe('U-ATT-06: checkIn duplicate session prevention', () => {
  it('throws ATT_003 when already checked in (partial unique index violation)', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);
    mockTransaction();
    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue(makeDay() as never);
    jest.spyOn(AttendanceSession, 'create').mockRejectedValue({ code: 11000 } as never);

    await expect(
      AttendanceService.checkIn({
        employeeId: EMP_ID,
        deviceFingerprintHeader: FINGERPRINT,
        latitude: 12.9,
        longitude: 77.6,
        accuracy: 10,
        nonce: NONCE,
        clientTimestamp: TIMESTAMP,
      }),
    ).rejects.toMatchObject({ code: 'ATT_003' });
  });
});

// ─── U-ATT-07: checkIn — late arrival flag ───────────────────────────────────

describe('U-ATT-07: checkIn late arrival detection', () => {
  it('response always contains isLateArrival, lateByMinutes, isHalfDayCapped flags', async () => {
    setupCheckinSuccess();

    const result = await AttendanceService.checkIn({
      employeeId: EMP_ID,
      deviceFingerprintHeader: FINGERPRINT,
      latitude: 12.9,
      longitude: 77.6,
      accuracy: 10,
      nonce: NONCE,
      clientTimestamp: TIMESTAMP,
    });
    expect(result.flags).toHaveProperty('isLateArrival');
    expect(result.flags).toHaveProperty('lateByMinutes');
    expect(result.flags).toHaveProperty('isHalfDayCapped');
  });
});

// ─── U-ATT-08: checkIn — success response shape ──────────────────────────────

describe('U-ATT-08: checkIn success response shape', () => {
  it('returns sessionId, checkInTimestamp, dateString, status:checked-in, flags', async () => {
    setupCheckinSuccess();

    const result = await AttendanceService.checkIn({
      employeeId: EMP_ID,
      deviceFingerprintHeader: FINGERPRINT,
      latitude: 12.9,
      longitude: 77.6,
      accuracy: 10,
      nonce: NONCE,
      clientTimestamp: TIMESTAMP,
    });
    expect(result).toHaveProperty('sessionId');
    expect(result).toHaveProperty('checkInTimestamp');
    expect(result).toHaveProperty('dateString');
    expect(result.status).toBe('checked-in');
    expect(result.flags).toHaveProperty('possibleMockGps');
  });
});

// ─── U-ATT-09: checkOut — no active session ──────────────────────────────────

describe('U-ATT-09: checkOut with no active session', () => {
  it('throws ATT_005 when no active session exists', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(null);

    await expect(
      AttendanceService.checkOut({ ...CHECKOUT_BASE }),
    ).rejects.toMatchObject({ code: 'ATT_005' });
  });
});

// ─── U-ATT-10: checkOut — nonce replay ───────────────────────────────────────

describe('U-ATT-10: checkOut nonce replay prevention', () => {
  it('throws ATT_004 on duplicate checkout nonce', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
    jest.spyOn(UsedNonce, 'create').mockRejectedValue({ code: 11000 } as never);

    await expect(
      AttendanceService.checkOut({ ...CHECKOUT_BASE }),
    ).rejects.toMatchObject({ code: 'ATT_004' });
  });
});

// ─── U-ATT-11: checkOut — success ─────────────────────────────────────────────

function setupCheckoutSuccess(dayAfterInc: Record<string, unknown> = {}) {
  mockFindByIdLean(User, makeUser());
  jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
  jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);
  mockTransaction();
  const close = jest.spyOn(AttendanceSession, 'findOneAndUpdate').mockResolvedValue({ _id: SESSION_OID } as never);
  const dayUpdate = jest.spyOn(AttendanceDay, 'findByIdAndUpdate').mockResolvedValue(
    makeDay({ totalMinutes: 60, ...dayAfterInc }) as never,
  );
  return { close, dayUpdate };
}

function checkoutSet(close: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (close.mock.calls[0][1] as { $set: { checkOut: Record<string, unknown> } }).$set.checkOut;
}

describe('U-ATT-11: checkOut success', () => {
  it('returns sessionId, timestamps, durationMinutes, day summary', async () => {
    setupCheckoutSuccess();
    const result = await AttendanceService.checkOut({ ...CHECKOUT_BASE });
    expect(result).toHaveProperty('sessionId');
    expect(result).toHaveProperty('checkInTimestamp');
    expect(result).toHaveProperty('checkOutTimestamp');
    expect(result).toHaveProperty('durationMinutes');
    expect(result.day).toHaveProperty('dateString');
    expect(result.day).toHaveProperty('status');
    expect(result.day).toHaveProperty('totalMinutes', 60);
  });

  it('closes the session conditionally (isActive:true) and adds minutes with $inc', async () => {
    const { close, dayUpdate } = setupCheckoutSuccess();
    await AttendanceService.checkOut({ ...CHECKOUT_BASE });
    expect(close.mock.calls[0][0]).toMatchObject({ _id: SESSION_OID, isActive: true });
    // ...and is conditional on still being inside the 24-hour window
    expect((close.mock.calls[0][0] as Record<string, { $gt: Date }>)['checkIn.timestamp'].$gt).toBeInstanceOf(Date);
    expect(dayUpdate.mock.calls[0][1]).toEqual({ $inc: { totalMinutes: expect.any(Number) } });
  });

  it('a concurrent duplicate checkout that loses the race gets ATT_005 and adds no minutes', async () => {
    const { close, dayUpdate } = setupCheckoutSuccess();
    close.mockResolvedValue(null as never);
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE })).rejects.toMatchObject({ code: 'ATT_005' });
    expect(dayUpdate).not.toHaveBeenCalled();
  });

  it('records the verified checkout location and device', async () => {
    const { close } = setupCheckoutSuccess();
    await AttendanceService.checkOut({ ...CHECKOUT_BASE });
    expect(checkoutSet(close)).toMatchObject({
      latitude: 12.9, longitude: 77.6, isWithinGeoFence: true, locationProvided: true, deviceFingerprint: FINGERPRINT,
    });
  });
});

// ─── Checkout security: device binding and location policy ─────────────────

describe('U-ATT-CO-SEC: checkout device binding', () => {
  it('rejects a checkout without the device fingerprint header (AUTH_004)', async () => {
    mockFindByIdLean(User, makeUser());
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, deviceFingerprintHeader: '' }))
      .rejects.toMatchObject({ code: 'AUTH_004' });
  });

  it('rejects a checkout from a different device (AUTH_005)', async () => {
    mockFindByIdLean(User, makeUser());
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, deviceFingerprintHeader: 'c'.repeat(64) }))
      .rejects.toMatchObject({ code: 'AUTH_005' });
  });

  it('rejects a deactivated account', async () => {
    mockFindByIdLean(User, makeUser({ isActive: false }));
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE })).rejects.toMatchObject({ code: 'AUTH_007' });
  });
});

describe('U-ATT-CO-GPS: checkout location policy', () => {
  const NO_GPS = { employeeId: EMP_ID, deviceFingerprintHeader: FINGERPRINT, nonce: NONCE, clientTimestamp: TIMESTAMP };

  it('missing coordinates for an ordinary employee → ATT_010, nonce NOT consumed', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
    const nonce = jest.spyOn(UsedNonce, 'create');
    await expect(AttendanceService.checkOut({ ...NO_GPS })).rejects.toMatchObject({ code: 'ATT_010', httpStatus: 422 });
    expect(nonce).not.toHaveBeenCalled();
  });

  it('coordinates outside the fence → ATT_001', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, latitude: 13.5, longitude: 78.5 }))
      .rejects.toMatchObject({ code: 'ATT_001' });
  });

  it('accuracy worse than the threshold → ATT_002', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, accuracy: 500 }))
      .rejects.toMatchObject({ code: 'ATT_002' });
  });

  it('remote/override employee may check out without GPS; recorded as NOT inside the fence', async () => {
    const { close } = setupCheckoutSuccess();
    jest.spyOn(Employee, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ allowOutsideGeofence: true }),
    } as unknown as ReturnType<typeof Employee.findOne>);
    await AttendanceService.checkOut({ ...NO_GPS });
    expect(checkoutSet(close)).toMatchObject({ isWithinGeoFence: false, locationProvided: false });
  });

  it('geofence disabled: no GPS needed; still recorded as unverified', async () => {
    const { close } = setupCheckoutSuccess();
    jest.spyOn(CompanySettings, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeSettings({ geoFence: { isEnabled: false, latitude: 12.9, longitude: 77.6, radiusMeters: 200 } })),
    } as unknown as ReturnType<typeof CompanySettings.findById>);
    await AttendanceService.checkOut({ ...NO_GPS });
    expect(checkoutSet(close).isWithinGeoFence).toBe(false);
  });

  it('office-IP mode: wrong network → ATT_009 (distinct from nonce-replay ATT_004)', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
    jest.spyOn(CompanySettings, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeSettings({ attendanceValidationMode: 'officeIp', allowedOfficeIps: ['203.0.113.10'] })),
    } as unknown as ReturnType<typeof CompanySettings.findById>);
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, clientIp: '198.51.100.1' }))
      .rejects.toMatchObject({ code: 'ATT_009' });
  });

  it('office-IP mode: unknown client IP (untrusted proxy headers) is denied', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
    jest.spyOn(CompanySettings, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeSettings({ attendanceValidationMode: 'officeIp', allowedOfficeIps: ['203.0.113.10'] })),
    } as unknown as ReturnType<typeof CompanySettings.findById>);
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, clientIp: 'unknown' }))
      .rejects.toMatchObject({ code: 'ATT_009' });
  });

  it('office-IP mode: approved network → allowed without GPS', async () => {
    setupCheckoutSuccess();
    jest.spyOn(CompanySettings, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeSettings({ attendanceValidationMode: 'officeIp', allowedOfficeIps: ['203.0.113.10'] })),
    } as unknown as ReturnType<typeof CompanySettings.findById>);
    await expect(AttendanceService.checkOut({ ...NO_GPS, clientIp: '203.0.113.10' })).resolves.toHaveProperty('sessionId');
  });
});

describe('U-ATT-TS: timestamp validation', () => {
  it('an unparseable client timestamp is rejected (no NaN bypass)', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(makeActiveSession() as never);
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, clientTimestamp: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'ATT_007' });
    await expect(AttendanceService.checkIn({
      employeeId: EMP_ID, deviceFingerprintHeader: FINGERPRINT, latitude: 12.9, longitude: 77.6,
      accuracy: 10, nonce: NONCE, clientTimestamp: 'not-a-date',
    })).rejects.toMatchObject({ code: 'ATT_007' });
  });
});

// ─── U-ATT-12: getStatus — when checked in ────────────────────────────────────

describe('U-ATT-12: getStatus when checked in', () => {
  it('returns isCheckedIn:true with currentSession details', async () => {
    const session = makeActiveSession();
    mockFindOneLean(AttendanceDay, makeDay());
    mockFindOneLean(AttendanceSession, session);
    mockFindLean(AttendanceSession, [session]);

    const result = await AttendanceService.getStatus(EMP_ID);
    expect(result.isCheckedIn).toBe(true);
    expect(result.currentSession).not.toBeNull();
    expect(result.currentSession?.sessionId).toBeDefined();
    expect(result.currentSession?.elapsedMinutes).toBeGreaterThanOrEqual(0);
  });
});

// ─── U-ATT-13: getStatus — when not checked in ───────────────────────────────

describe('U-ATT-13: getStatus when not checked in', () => {
  it('returns isCheckedIn:false with currentSession:null', async () => {
    mockFindOneLean(AttendanceDay, null);
    mockFindOneLean(AttendanceSession, null);
    mockFindLean(AttendanceSession, []);

    const result = await AttendanceService.getStatus(EMP_ID);
    expect(result.isCheckedIn).toBe(false);
    expect(result.currentSession).toBeNull();
    expect(result.todaySummary.totalMinutes).toBe(0);
  });
});

// ─── U-ATT-14: getHistory — paginated ────────────────────────────────────────

describe('U-ATT-14: getHistory paginated response', () => {
  it('returns correct meta and day records', async () => {
    const today = new Date().toISOString().split('T')[0];
    const day = makeDay();
    jest.spyOn(AttendanceDay, 'find').mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([day]),
    } as unknown as ReturnType<typeof AttendanceDay.find>);
    jest.spyOn(AttendanceDay, 'countDocuments').mockResolvedValue(1 as never);
    jest.spyOn(Holiday, 'find').mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof Holiday.find>);
    jest.spyOn(AttendanceSession, 'find').mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof AttendanceSession.find>);

    const result = await AttendanceService.getHistory(EMP_ID, {
      startDate: today,
      endDate: today,
      page: 1,
      limit: 10,
    });
    expect(result.meta.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toHaveProperty('dateString', today);
    expect(result.data[0]).toHaveProperty('status');
  });
});

// ─── 24-hour missed check-out rule (unit level; real-DB cases in integration) ─

describe('U-ATT-24H: boundary helpers', () => {
  const ci = new Date('2026-03-02T03:30:00Z');
  it('deadline is exactly check-in + 24 h', () => {
    expect(checkoutDeadline(ci).getTime() - ci.getTime()).toBe(MISSED_CHECKOUT_WINDOW_MS);
  });
  it('1 ms before the deadline: still open', () => {
    expect(isCheckoutWindowExpired(ci, new Date(ci.getTime() + MISSED_CHECKOUT_WINDOW_MS - 1))).toBe(false);
  });
  it('at the deadline: expired (boundary inclusive)', () => {
    expect(isCheckoutWindowExpired(ci, new Date(ci.getTime() + MISSED_CHECKOUT_WINDOW_MS))).toBe(true);
  });
  it('after the deadline: expired', () => {
    expect(isCheckoutWindowExpired(ci, new Date(ci.getTime() + MISSED_CHECKOUT_WINDOW_MS + 60_000))).toBe(true);
  });
});

describe('U-ATT-24H: check-out and check-in at the boundary (controlled clock)', () => {
  const CHECKIN = new Date('2026-03-02T03:30:00Z'); // 09:00 IST
  afterEach(() => jest.useRealTimers());
  function clockAt(ms: number) {
    // Only Date is faked; timers/microtasks keep running normally.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    jest.setSystemTime(new Date(CHECKIN.getTime() + ms));
  }
  function activeAtCheckin() {
    return makeActiveSession({ checkIn: { ...makeActiveSession().checkIn, timestamp: CHECKIN } });
  }

  it('checkout 1 minute before the deadline is accepted (no ATT_011)', async () => {
    clockAt(MISSED_CHECKOUT_WINDOW_MS - 60_000);
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(activeAtCheckin() as never);
    jest.spyOn(UsedNonce, 'create').mockResolvedValue({} as never);
    mockTransaction();
    jest.spyOn(AttendanceSession, 'findOneAndUpdate').mockResolvedValue({ _id: SESSION_OID } as never);
    jest.spyOn(AttendanceDay, 'findByIdAndUpdate').mockResolvedValue(makeDay({ totalMinutes: 1439 }) as never);
    const res = await AttendanceService.checkOut({ ...CHECKOUT_BASE, clientTimestamp: new Date().toISOString() });
    expect(res.durationMinutes).toBe(24 * 60 - 1);
  });

  it('checkout exactly at the deadline is refused with ATT_011; no punch-out written', async () => {
    clockAt(MISSED_CHECKOUT_WINDOW_MS);
    mockFindByIdLean(User, makeUser());
    jest.spyOn(AttendanceSession, 'findOne').mockResolvedValue(activeAtCheckin() as never);
    mockTransaction();
    const expire = jest.spyOn(AttendanceSession, 'findOneAndUpdate').mockResolvedValue({ _id: SESSION_OID } as never);
    jest.spyOn(AttendanceDay, 'findById').mockReturnValue({ session: jest.fn().mockResolvedValue(makeDay()) } as never);
    jest.spyOn(AttendanceDay, 'updateOne').mockResolvedValue({} as never);
    const nonce = jest.spyOn(UsedNonce, 'create');
    await expect(AttendanceService.checkOut({ ...CHECKOUT_BASE, clientTimestamp: new Date().toISOString() }))
      .rejects.toMatchObject({ code: 'ATT_011', httpStatus: 422 });
    const set = (expire.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
    expect(set).toMatchObject({ isActive: false, systemCloseReason: 'missed-checkout', durationMinutes: 0, checkOut: null });
    expect(nonce).not.toHaveBeenCalled();
  });

  it('check-in while the previous session is 23h59m old → ATT_003 (window still open)', async () => {
    clockAt(MISSED_CHECKOUT_WINDOW_MS - 60_000);
    setupCheckinSuccess();
    jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(activeAtCheckin()) } as never);
    await expect(AttendanceService.checkIn({
      employeeId: EMP_ID, deviceFingerprintHeader: FINGERPRINT, latitude: 12.9, longitude: 77.6,
      accuracy: 10, nonce: NONCE, clientTimestamp: new Date().toISOString(),
    })).rejects.toMatchObject({ code: 'ATT_003' });
  });

  it('check-in at the deadline expires the old session (missed) and starts a new one', async () => {
    clockAt(MISSED_CHECKOUT_WINDOW_MS);
    setupCheckinSuccess();
    jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(activeAtCheckin()) } as never);
    const expire = jest.spyOn(AttendanceSession, 'findOneAndUpdate').mockResolvedValue({ _id: SESSION_OID } as never);
    jest.spyOn(AttendanceDay, 'findById').mockReturnValue({ session: jest.fn().mockResolvedValue(makeDay()) } as never);
    const dayUpdate = jest.spyOn(AttendanceDay, 'updateOne').mockResolvedValue({} as never);
    const res = await AttendanceService.checkIn({
      employeeId: EMP_ID, deviceFingerprintHeader: FINGERPRINT, latitude: 12.9, longitude: 77.6,
      accuracy: 10, nonce: NONCE, clientTimestamp: new Date().toISOString(),
    });
    expect(res.status).toBe('checked-in');
    expect((expire.mock.calls[0][1] as { $set: Record<string, unknown> }).$set.systemCloseReason).toBe('missed-checkout');
    expect(dayUpdate.mock.calls[0][1]).toMatchObject({ $set: { status: 'absent', hasUnresolvedMissedCheckout: true } });
  });

  it('a leave / holiday day is NOT overwritten by a missed check-out', async () => {
    clockAt(MISSED_CHECKOUT_WINDOW_MS + 1000);
    setupCheckinSuccess();
    jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(activeAtCheckin()) } as never);
    jest.spyOn(AttendanceSession, 'findOneAndUpdate').mockResolvedValue({ _id: SESSION_OID } as never);
    jest.spyOn(AttendanceDay, 'findById').mockReturnValue({ session: jest.fn().mockResolvedValue(makeDay({ status: 'leave' })) } as never);
    const dayUpdate = jest.spyOn(AttendanceDay, 'updateOne').mockResolvedValue({} as never);
    await AttendanceService.checkIn({
      employeeId: EMP_ID, deviceFingerprintHeader: FINGERPRINT, latitude: 12.9, longitude: 77.6,
      accuracy: 10, nonce: NONCE, clientTimestamp: new Date().toISOString(),
    });
    const set = (dayUpdate.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
    expect(set.status).toBeUndefined();
    expect(set.hasUnresolvedMissedCheckout).toBeUndefined();
  });
});

