import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import mongoose from 'mongoose';

// Simulate connected DB
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

import { RegularizationService } from '@services/RegularizationService';
import { Regularization } from '@models/Regularization';
import { AttendanceDay } from '@models/AttendanceDay';
import { AttendanceSession } from '@models/AttendanceSession';
import { CompanySettings } from '@models/CompanySettings';
import { PayrollRecord } from '@models/PayrollRecord';
import { AuditLog } from '@models/AuditLog';
import { User } from '@models/User';
import { NotificationService } from '@services/NotificationService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMP_ID  = new mongoose.Types.ObjectId().toHexString();
const EMP_OID = new mongoose.Types.ObjectId(EMP_ID);
const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
const REG_ID  = new mongoose.Types.ObjectId().toHexString();
const REG_OID = new mongoose.Types.ObjectId(REG_ID);
const DAY_OID = new mongoose.Types.ObjectId();

// Yesterday — always within lookback window
const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
})();

// 30 days ago — outside default 7-day lookback
const OLD_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
})();

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    _id:                        'company-settings',
    timezone:                   'Asia/Kolkata',
    regularizationLookbackDays: 7,
    requiredDailyMinutes:       480,
    halfDayThresholdMinutes:    240,
    halfDayLateCheckInTime:     '12:00',
    lateArrivalGraceMinutes:    15,
    workStartTime:              '09:00',
    ...overrides,
  };
}

function makeReg(overrides: Record<string, unknown> = {}) {
  return {
    _id:        REG_OID,
    employeeId: EMP_OID,
    dateString: YESTERDAY,
    type:       'forgotCheckIn',
    reason:     'Forgot to check in',
    status:     'pending',
    createdAt:  new Date(),
    updatedAt:  new Date(),
    ...overrides,
  };
}

const employeePayload = { userId: EMP_ID, role: 'employee' as const, email: 'e@e.com', iat: 0, exp: 9999999999 };

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(NotificationService, 'create').mockResolvedValue(undefined as never);
  jest.spyOn(NotificationService, 'notifyAllAdmins').mockResolvedValue(undefined as never);

  jest.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction: async (fn: () => Promise<void>) => { await fn(); },
    endSession: jest.fn().mockResolvedValue(undefined),
  } as unknown as mongoose.ClientSession);

  jest.spyOn(AuditLog, 'create').mockResolvedValue([] as never);
  jest.spyOn(CompanySettings, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue(makeSettings()),
  } as unknown as ReturnType<typeof CompanySettings.findById>);
  // Current contract defaults:
  //  - create() checks existing sessions for the date (BR-REG-03)
  //  - list() batch-loads employee names
  //  - approve/reject/withdraw claim the request with a conditional
  //    findOneAndUpdate({ status: 'pending' }); default = claim succeeds
  //  - notifications are fire-and-forget (User.findById for email address)
  jest.spyOn(AttendanceSession, 'find').mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof AttendanceSession.find>);
  jest.spyOn(User, 'find').mockReturnValue({
    lean: jest.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof User.find>);
  jest.spyOn(User, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof User.findById>);
  jest.spyOn(Regularization, 'findOneAndUpdate').mockResolvedValue({ _id: REG_OID } as never);
});

// ─── U-REG-01: create within lookback window ──────────────────────────────────

describe('U-REG-01', () => {
  it('creates regularization request within lookback window', async () => {
    jest.spyOn(Regularization, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof Regularization.findOne>);

    const createdDoc = { ...makeReg(), toHexString: () => REG_ID };
    jest.spyOn(Regularization, 'create').mockResolvedValue(createdDoc as never);

    // requestedCheckIn must be on YESTERDAY in IST — use noon UTC on yesterday (well within IST same day)
    const checkInISO = YESTERDAY + 'T07:00:00.000Z'; // 12:30 IST — same calendar day

    const result = await RegularizationService.create({
      employeeId: EMP_ID,
      input: { date: YESTERDAY, type: 'forgotCheckIn', requestedCheckIn: checkInISO, reason: 'Forgot to check in today' },
    });

    expect(result.status).toBe('pending');
    expect(result.date).toBe(YESTERDAY); // API contract field is `date` (formatReg)
    expect(Regularization.create).toHaveBeenCalled();
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'REGULARIZATION_CREATED' }));
  });
});

// ─── U-REG-02: lookback window exceeded ───────────────────────────────────────

describe('U-REG-02', () => {
  it('throws REG_001 when date is outside lookback window', async () => {
    await expect(
      RegularizationService.create({
        employeeId: EMP_ID,
        input: { date: OLD_DATE, type: 'workAwayFromOffice', reason: 'Was on official trip that day' },
      }),
    ).rejects.toMatchObject({ code: 'REG_001', httpStatus: 422 });
  });
});

// ─── U-REG-03: duplicate request ──────────────────────────────────────────────

describe('U-REG-03', () => {
  it('throws REG_002 when pending request already exists for same employee+date', async () => {
    jest.spyOn(Regularization, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg()),
    } as unknown as ReturnType<typeof Regularization.findOne>);

    await expect(
      RegularizationService.create({
        employeeId: EMP_ID,
        input: { date: YESTERDAY, type: 'workAwayFromOffice', reason: 'Another request for same day please' },
      }),
    ).rejects.toMatchObject({ code: 'REG_002', httpStatus: 409 });
  });
});

// ─── U-REG-04: approve updates AttendanceDay atomically ───────────────────────

describe('U-REG-04', () => {
  it('approves workAwayFromOffice and marks AttendanceDay as present+regularized', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg({ type: 'workAwayFromOffice' })),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);

    const dayDoc = { _id: DAY_OID };
    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue(dayDoc as never);
    jest.spyOn(AttendanceDay, 'findByIdAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Regularization, 'findByIdAndUpdate').mockResolvedValue(null as never);

    const result = await RegularizationService.approve(REG_ID, ADMIN_ID);

    expect(result.status).toBe('approved');
    expect(result.updatedDayStatus).toBe('present');
    expect(AttendanceDay.findByIdAndUpdate).toHaveBeenCalledWith(
      DAY_OID,
      expect.objectContaining({ $set: expect.objectContaining({ status: 'present', isRegularized: true }) }),
      expect.anything(),
    );
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'REGULARIZATION_APPROVED' }));
  });
});

// ─── U-REG-05: reject — status changes, no attendance changes ────────────────

describe('U-REG-05', () => {
  it('rejects regularization, writes audit log, no attendance change', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg()),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(Regularization, 'findByIdAndUpdate').mockResolvedValue(null as never);
    const attendanceSpy = jest.spyOn(AttendanceDay, 'findByIdAndUpdate');

    const result = await RegularizationService.reject(REG_ID, ADMIN_ID, 'Not eligible');

    expect(result.status).toBe('rejected');
    expect(attendanceSpy).not.toHaveBeenCalled();
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'REGULARIZATION_REJECTED' }));
  });
});

// ─── U-REG-06: withdraw pending → withdrawn ───────────────────────────────────

describe('U-REG-06', () => {
  it('withdraws own pending regularization', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg()),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(Regularization, 'findByIdAndUpdate').mockResolvedValue(null as never);

    const result = await RegularizationService.withdraw(REG_ID, EMP_ID);

    expect(result.status).toBe('withdrawn');
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'REGULARIZATION_WITHDRAWN' }));
  });

  it('throws REG_003 when withdrawing non-pending request', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg({ status: 'approved' })),
    } as unknown as ReturnType<typeof Regularization.findById>);

    await expect(RegularizationService.withdraw(REG_ID, EMP_ID))
      .rejects.toMatchObject({ code: 'REG_003', httpStatus: 422 });
  });
});

// ─── U-REG-07: approve forgotCheckOut closes session (H1 fix) ────────────────

describe('U-REG-07', () => {
  it('closes midnight-rolled session on forgotCheckOut approval (H1 fix — real-world scenario)', async () => {
    // Real-world: employee forgot to check out yesterday.
    // Midnight rollover ran and closed session: isActive=false, closedBySystem=true, systemCloseReason='midnight-rollover'.
    const checkInTs  = new Date(YESTERDAY + 'T04:00:00.000Z');
    const checkOutTs = new Date(YESTERDAY + 'T14:00:00.000Z'); // 10h = 600min → present

    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(
        makeReg({ type: 'forgotCheckOut', requestedCheckOut: checkOutTs }),
      ),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);

    const dayDoc = { _id: DAY_OID };
    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue(dayDoc as never);

    // Midnight-rolled session — isActive: false (as would exist in real DB after cron)
    const midnightRolledSession = {
      _id:     new mongoose.Types.ObjectId(),
      checkIn: { timestamp: checkInTs },
      isActive: false,
      closedBySystem: true,
      systemCloseReason: 'midnight-rollover',
    };

    jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({
      sort:    jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean:    jest.fn().mockResolvedValue(midnightRolledSession),
    } as unknown as ReturnType<typeof AttendanceSession.findOne>);

    jest.spyOn(AttendanceSession, 'findByIdAndUpdate').mockResolvedValue(null as never);

    jest.spyOn(AttendanceSession, 'find').mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean:    jest.fn().mockResolvedValue([{ durationMinutes: 600 }]),
    } as unknown as ReturnType<typeof AttendanceSession.find>);

    jest.spyOn(AttendanceDay, 'findByIdAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Regularization, 'findByIdAndUpdate').mockResolvedValue(null as never);

    const result = await RegularizationService.approve(REG_ID, ADMIN_ID);

    expect(result.updatedDayStatus).toBe('present');
    expect(AttendanceSession.findByIdAndUpdate).toHaveBeenCalledWith(
      midnightRolledSession._id,
      expect.objectContaining({
        $set: expect.objectContaining({
          isActive:          false,
          closedBySystem:    true,
          systemCloseReason: 'admin-force-close',
          durationMinutes:   600,
        }),
      }),
      expect.anything(),
    );
    // Verify query includes midnight-rollover in $or (indirectly via mock call args)
    const findOneCall = (AttendanceSession.findOne as jest.MockedFunction<typeof AttendanceSession.findOne>).mock.calls[0][0] as Record<string, unknown>;
    expect(findOneCall.$or).toBeDefined();
  });

  it('also handles still-active session (same-day edge case)', async () => {
    // Edge case: employee submits forgotCheckOut on same day before midnight (very unlikely but valid)
    const checkInTs  = new Date(YESTERDAY + 'T04:00:00.000Z');
    const checkOutTs = new Date(YESTERDAY + 'T14:00:00.000Z');

    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(
        makeReg({ type: 'forgotCheckOut', requestedCheckOut: checkOutTs }),
      ),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);

    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue({ _id: DAY_OID } as never);

    // Active session (isActive: true — same-day edge case)
    const activeSession = {
      _id:     new mongoose.Types.ObjectId(),
      checkIn: { timestamp: checkInTs },
      isActive: true,
    };

    jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({
      sort:    jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean:    jest.fn().mockResolvedValue(activeSession),
    } as unknown as ReturnType<typeof AttendanceSession.findOne>);

    jest.spyOn(AttendanceSession, 'findByIdAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(AttendanceSession, 'find').mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean:    jest.fn().mockResolvedValue([{ durationMinutes: 600 }]),
    } as unknown as ReturnType<typeof AttendanceSession.find>);

    jest.spyOn(AttendanceDay, 'findByIdAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Regularization, 'findByIdAndUpdate').mockResolvedValue(null as never);

    const result = await RegularizationService.approve(REG_ID, ADMIN_ID);
    expect(result.updatedDayStatus).toBe('present');
  });

  it('throws REG_006 when no eligible session exists for forgotCheckOut', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(
        makeReg({ type: 'forgotCheckOut', requestedCheckOut: new Date() }),
      ),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);

    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue({ _id: DAY_OID } as never);

    // No session at all (employee never checked in)
    jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({
      sort:    jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean:    jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof AttendanceSession.findOne>);

    await expect(RegularizationService.approve(REG_ID, ADMIN_ID))
      .rejects.toMatchObject({ code: 'REG_006', httpStatus: 422 });
  });
});

// ─── U-REG-08: approve forgotCheckIn creates synthetic session ────────────────

describe('U-REG-08', () => {
  it('creates synthetic session for forgotCheckIn and sets day to present', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(
        makeReg({ type: 'forgotCheckIn', requestedCheckIn: new Date(YESTERDAY + 'T04:00:00.000Z') }),
      ),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);

    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue({ _id: DAY_OID } as never);
    jest.spyOn(AttendanceSession, 'create').mockResolvedValue([] as never);
    jest.spyOn(AttendanceDay, 'findByIdAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Regularization, 'findByIdAndUpdate').mockResolvedValue(null as never);

    const result = await RegularizationService.approve(REG_ID, ADMIN_ID);

    expect(result.updatedDayStatus).toBe('present');
    expect(AttendanceSession.create).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          isActive:          false,
          closedBySystem:    true,
          systemCloseReason: 'admin-force-close',
        }),
      ]),
      expect.anything(),
    );
  });
});

// ─── U-REG-09: payroll warning when month is finalised ────────────────────────

describe('U-REG-09', () => {
  it('includes payroll warning when month is already finalised', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg({ type: 'officialTravel' })),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ status: 'finalised' }),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);

    jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue({ _id: DAY_OID } as never);
    jest.spyOn(AttendanceDay, 'findByIdAndUpdate').mockResolvedValue(null as never);
    jest.spyOn(Regularization, 'findByIdAndUpdate').mockResolvedValue(null as never);

    const result = await RegularizationService.approve(REG_ID, ADMIN_ID);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/finalised/i);
  });
});

// ─── U-REG-10: approve non-pending → REG_003 ─────────────────────────────────

describe('U-REG-10', () => {
  it('throws REG_003 when approving already-rejected request', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg({ status: 'rejected' })),
    } as unknown as ReturnType<typeof Regularization.findById>);

    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);

    await expect(RegularizationService.approve(REG_ID, ADMIN_ID))
      .rejects.toMatchObject({ code: 'REG_003', httpStatus: 422 });
  });
});

// ─── U-REG-11: getById — employee can only see own ───────────────────────────

describe('U-REG-11', () => {
  it('allows employee to fetch their own regularization', async () => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg()),
    } as unknown as ReturnType<typeof Regularization.findById>);

    const result = await RegularizationService.getById(REG_ID, employeePayload);
    // API contract: formatReg() returns `_id` (consumed as `_id` by the mobile
    // RegularizationRequest model and the admin portal list page).
    expect(result._id).toBe(REG_ID);
  });

  it('throws 403 when employee fetches another employee request', async () => {
    const otherId = new mongoose.Types.ObjectId().toHexString();
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg()),
    } as unknown as ReturnType<typeof Regularization.findById>);

    await expect(RegularizationService.getById(REG_ID, { ...employeePayload, userId: otherId }))
      .rejects.toMatchObject({ httpStatus: 403 });
  });
});

// ─── U-REG-12: list — employee sees only own ─────────────────────────────────

describe('U-REG-12', () => {
  it('employee list is scoped to their own employeeId', async () => {
    jest.spyOn(Regularization, 'find').mockReturnValue({
      sort:  jest.fn().mockReturnThis(),
      skip:  jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean:  jest.fn().mockResolvedValue([makeReg()]),
    } as unknown as ReturnType<typeof Regularization.find>);
    jest.spyOn(Regularization, 'countDocuments').mockResolvedValue(1 as never);

    const result = await RegularizationService.list({ page: 1, limit: 20 }, employeePayload);

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    const findCall = (Regularization.find as jest.MockedFunction<typeof Regularization.find>).mock.calls[0][0] as Record<string, unknown>;
    expect(findCall.employeeId?.toString()).toBe(EMP_OID.toHexString());
  });
});

// ─── U-REG-13: M2 boundary validation — requestedCheckIn wrong day ────────────

describe('U-REG-13', () => {
  it('throws GEN_001 when requestedCheckIn is on a different calendar day (IST)', async () => {
    jest.spyOn(Regularization, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof Regularization.findOne>);

    // requestedCheckIn is two days before YESTERDAY — wrong day
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const wrongDayISO = twoDaysAgo.toISOString();

    await expect(
      RegularizationService.create({
        employeeId: EMP_ID,
        input: { date: YESTERDAY, type: 'forgotCheckIn', requestedCheckIn: wrongDayISO, reason: 'Forgot to check in yesterday' },
      }),
    ).rejects.toMatchObject({ code: 'GEN_001', httpStatus: 400 });
  });

  it('throws GEN_001 when requestedCheckOut is more than one day after date', async () => {
    jest.spyOn(Regularization, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof Regularization.findOne>);

    // requestedCheckOut is three days after YESTERDAY — wrong day
    const threeDaysAfter = new Date(YESTERDAY + 'T00:00:00Z');
    threeDaysAfter.setDate(threeDaysAfter.getDate() + 3);
    const wrongDayISO = threeDaysAfter.toISOString();

    await expect(
      RegularizationService.create({
        employeeId: EMP_ID,
        input: { date: YESTERDAY, type: 'forgotCheckOut', requestedCheckOut: wrongDayISO, reason: 'Need correct checkout time please' },
      }),
    ).rejects.toMatchObject({ code: 'GEN_001', httpStatus: 400 });
  });
});

// ─── Authorization: manager / executive are NOT HR admins ─────────────────────

describe('U-REG-AUTHZ: non-HR-admin roles see only their own requests', () => {
  const OTHER_ID = new mongoose.Types.ObjectId().toHexString();

  it.each(['manager', 'executive'] as const)('%s list is scoped to own employeeId even with ?employeeId=', async (role) => {
    jest.spyOn(Regularization, 'find').mockReturnValue({
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof Regularization.find>);
    jest.spyOn(Regularization, 'countDocuments').mockResolvedValue(0 as never);

    await RegularizationService.list(
      { page: 1, limit: 20, employeeId: EMP_ID } as never,
      { ...employeePayload, userId: OTHER_ID, role },
    );
    const filter = (Regularization.find as jest.MockedFunction<typeof Regularization.find>).mock.calls[0][0] as Record<string, unknown>;
    expect(String(filter.employeeId)).toBe(OTHER_ID);
  });

  it.each(['manager', 'executive'] as const)('%s cannot fetch another employee request by id', async (role) => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg()),
    } as unknown as ReturnType<typeof Regularization.findById>);
    await expect(RegularizationService.getById(REG_ID, { ...employeePayload, userId: OTHER_ID, role }))
      .rejects.toMatchObject({ httpStatus: 403 });
  });

  it.each(['admin', 'super_admin'] as const)('%s may filter by any employeeId', async (role) => {
    jest.spyOn(Regularization, 'find').mockReturnValue({
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof Regularization.find>);
    jest.spyOn(Regularization, 'countDocuments').mockResolvedValue(0 as never);
    await RegularizationService.list(
      { page: 1, limit: 20, employeeId: EMP_ID } as never,
      { ...employeePayload, userId: ADMIN_ID, role },
    );
    const filter = (Regularization.find as jest.MockedFunction<typeof Regularization.find>).mock.calls[0][0] as Record<string, unknown>;
    expect(String(filter.employeeId)).toBe(EMP_ID);
  });

  it('invalid id returns GEN_002 instead of a CastError 500', async () => {
    await expect(RegularizationService.getById('not-an-id', employeePayload)).rejects.toMatchObject({ code: 'GEN_002' });
    await expect(RegularizationService.withdraw('not-an-id', EMP_ID)).rejects.toMatchObject({ code: 'GEN_002' });
  });
});

// ─── Concurrency: state transitions are conditional on status: 'pending' ──────

describe('U-REG-RACE: concurrent state changes', () => {
  beforeEach(() => {
    jest.spyOn(Regularization, 'findById').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeReg()),
    } as unknown as ReturnType<typeof Regularization.findById>);
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof PayrollRecord.findOne>);
  });

  it('withdraw loses cleanly (REG_003) when an admin approved in between', async () => {
    jest.spyOn(Regularization, 'findOneAndUpdate').mockResolvedValue(null as never);
    await expect(RegularizationService.withdraw(REG_ID, EMP_ID)).rejects.toMatchObject({ code: 'REG_003' });
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  it('withdraw update is conditional on owner and pending status', async () => {
    await RegularizationService.withdraw(REG_ID, EMP_ID);
    expect(Regularization.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: EMP_OID, status: 'pending' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('withdraw by a different employee is forbidden', async () => {
    const other = new mongoose.Types.ObjectId().toHexString();
    await expect(RegularizationService.withdraw(REG_ID, other)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('reject loses cleanly when the request was withdrawn in between', async () => {
    jest.spyOn(Regularization, 'findOneAndUpdate').mockResolvedValue(null as never);
    await expect(RegularizationService.reject(REG_ID, ADMIN_ID, 'x')).rejects.toMatchObject({ code: 'REG_003' });
  });

  it('second concurrent approval aborts before touching attendance', async () => {
    jest.spyOn(Regularization, 'findOneAndUpdate').mockResolvedValue(null as never);
    const dayUpsert = jest.spyOn(AttendanceDay, 'findOneAndUpdate');
    const sessionCreate = jest.spyOn(AttendanceSession, 'create');
    await expect(RegularizationService.approve(REG_ID, ADMIN_ID)).rejects.toMatchObject({ code: 'REG_003' });
    expect(dayUpsert).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });
});
