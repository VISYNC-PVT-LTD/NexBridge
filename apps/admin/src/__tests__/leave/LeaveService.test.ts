import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import mongoose from 'mongoose';

// Simulate connected DB
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

import { LeaveService } from '@services/LeaveService';
import { User } from '@models/User';
import { CompanySettings } from '@models/CompanySettings';
import { Leave } from '@models/Leave';
import { LeaveTransaction } from '@models/LeaveTransaction';
import { Holiday } from '@models/Holiday';
import { AttendanceDay } from '@models/AttendanceDay';
import { AttendanceSession } from '@models/AttendanceSession';
import { AuditLog } from '@models/AuditLog';
import { NotificationService } from '@services/NotificationService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMP_ID   = new mongoose.Types.ObjectId().toHexString();
const EMP_OID  = new mongoose.Types.ObjectId(EMP_ID);
const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
const LEAVE_ID = new mongoose.Types.ObjectId().toHexString();
const LEAVE_OID = new mongoose.Types.ObjectId(LEAVE_ID);

// Future date — always valid as startDate
const FUTURE_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  // Advance to Monday if weekend
  while ([0, 6].includes(d.getUTCDay())) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
})();

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    timezone:               'Asia/Kolkata',
    leaveYearStartMonth:    1,
    workingDays:            ['monday','tuesday','wednesday','thursday','friday'],
    requiredDailyMinutes:   540,
    halfDayThresholdMinutes: 270,
    leaveTypes: {
      paidLeave:   { annualAllocation: 12, carryForward: { enabled: true, maxDays: 15, expiryMonths: 3 }, encashable: false },
      sickLeave:   { annualAllocation: 12, carryForward: { enabled: false, maxDays: 0, expiryMonths: 0 }, encashable: false },
      casualLeave: { annualAllocation: 12, carryForward: { enabled: false, maxDays: 0, expiryMonths: 0 }, encashable: false },
    },
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id:      EMP_OID,
    firstName: 'Jane',
    lastName:  'Doe',
    isActive:  true,
    leaveBalances: {
      paidLeave:   { currentYear: 10, carriedForward: 0 },
      sickLeave:   { currentYear: 8,  carriedForward: 0 },
      casualLeave: { currentYear: 6,  carriedForward: 0 },
    },
    ...overrides,
  };
}

function makeLeave(overrides: Record<string, unknown> = {}) {
  const startDate = new Date(FUTURE_DATE + 'T00:00:00Z');
  return {
    _id:          LEAVE_OID,
    employeeId:   EMP_OID,
    leaveType:    'paidLeave',
    duration:     'full',
    startDate,
    endDate:      startDate,
    totalDays:    1,
    leaveYear:    2026,
    reason:       'Vacation',
    status:       'pending',
    affectedDates: [FUTURE_DATE],
    createdAt:    new Date(),
    updatedAt:    new Date(),
    save:         jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockFindByIdLean(model: { findById: (...args: unknown[]) => unknown }, val: unknown) {
  jest.spyOn(model, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue(val),
  } as unknown as ReturnType<typeof User.findById>);
}

function mockFindOneLean(model: { findOne: (...args: unknown[]) => unknown }, val: unknown) {
  jest.spyOn(model, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(val),
  } as unknown as ReturnType<typeof Leave.findOne>);
}

function mockTransaction() {
  const session = {
    withTransaction: jest.fn().mockImplementation(async (fn: () => Promise<void>) => fn()),
    endSession:      jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session as unknown as mongoose.ClientSession);
  return session;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.restoreAllMocks();
  // Current contract: every state transition is a conditional
  // Leave.findOneAndUpdate({ status: <expected> }). Default: the claim succeeds.
  jest.spyOn(Leave, 'findOneAndUpdate').mockResolvedValue({ _id: new mongoose.Types.ObjectId() } as never);
  // Notification fan-out is fire-and-forget; covered by NotificationService tests.
  jest.spyOn(NotificationService, 'create').mockResolvedValue(undefined as never);
  jest.spyOn(NotificationService, 'notifyAllAdmins').mockResolvedValue(undefined as never);

  // Default mocks for ConnectDB (already mocked via readyState)
  jest.spyOn(CompanySettings, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue(makeSettings()),
  } as unknown as ReturnType<typeof CompanySettings.findById>);

  // Holiday.findOne — default: no holidays
  jest.spyOn(Holiday, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof Holiday.findOne>);

  // Holiday.find — default: no holidays
  jest.spyOn(Holiday, 'find').mockReturnValue({
    lean: jest.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof Holiday.find>);

  // Leave.findOne — default: no overlap
  jest.spyOn(Leave, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof Leave.findOne>);

  // AuditLog.create — swallow
  jest.spyOn(AuditLog, 'create').mockResolvedValue(undefined as never);
});

// ─── U-LVE-01: Apply with sufficient balance ──────────────────────────────────

describe('U-LVE-01: apply() with sufficient balance', () => {
  it('creates LeaveRequest with status pending; balance NOT deducted', async () => {
    mockFindByIdLean(User, makeUser());
    const createdLeave = makeLeave();
    jest.spyOn(Leave, 'create').mockResolvedValue(createdLeave as never);

    const result = await LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'paidLeave',
      startDate:  FUTURE_DATE,
      endDate:    FUTURE_DATE,
      duration:   'full',
    });

    expect(result.status).toBe('pending');
    expect(result.totalDays).toBeGreaterThanOrEqual(1);
    // Balance update NOT called
    expect(User.findById).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ session: expect.anything() }));
  });
});

// ─── U-LVE-02: Apply with zero balance ────────────────────────────────────────

describe('U-LVE-02: apply() with zero balance', () => {
  it('throws LVE_001 LEAVE_BALANCE_INSUFFICIENT', async () => {
    mockFindByIdLean(User, makeUser({
      leaveBalances: {
        paidLeave:   { currentYear: 0, carriedForward: 0 },
        sickLeave:   { currentYear: 8, carriedForward: 0 },
        casualLeave: { currentYear: 6, carriedForward: 0 },
      },
    }));

    await expect(LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'paidLeave',
      startDate:  FUTURE_DATE,
      endDate:    FUTURE_DATE,
      duration:   'full',
    })).rejects.toMatchObject({ code: 'LVE_001', httpStatus: 422 });
  });
});

// ─── U-LVE-03: Apply overlapping approved leave ────────────────────────────────

describe('U-LVE-03: apply() overlapping approved leave', () => {
  it('throws LVE_002 LEAVE_DATE_CONFLICT', async () => {
    mockFindByIdLean(User, makeUser());
    jest.spyOn(Leave, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(makeLeave({ status: 'approved' })),
    } as unknown as ReturnType<typeof Leave.findOne>);

    await expect(LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'paidLeave',
      startDate:  FUTURE_DATE,
      endDate:    FUTURE_DATE,
      duration:   'full',
    })).rejects.toMatchObject({ code: 'LVE_002', httpStatus: 409 });
  });
});

// ─── U-LVE-04: Apply on weekend ────────────────────────────────────────────────

describe('U-LVE-04: apply() on weekend', () => {
  it('throws LVE_004 LEAVE_ON_WEEKEND', async () => {
    // Find next Saturday
    const sat = new Date();
    while (sat.getUTCDay() !== 6) sat.setDate(sat.getDate() + 1);
    // Ensure it's in the future
    if (sat <= new Date()) sat.setDate(sat.getDate() + 7);
    const satStr = sat.toISOString().slice(0, 10);

    await expect(LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'paidLeave',
      startDate:  satStr,
      endDate:    satStr,
      duration:   'full',
    })).rejects.toMatchObject({ code: 'LVE_004', httpStatus: 422 });
  });
});

// ─── U-LVE-05: Apply on holiday ────────────────────────────────────────────────

describe('U-LVE-05: apply() on holiday', () => {
  it('throws LVE_003 LEAVE_ON_HOLIDAY', async () => {
    jest.spyOn(Holiday, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([{ dateString: FUTURE_DATE }]),
    } as unknown as ReturnType<typeof Holiday.find>);

    await expect(LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'paidLeave',
      startDate:  FUTURE_DATE,
      endDate:    FUTURE_DATE,
      duration:   'full',
    })).rejects.toMatchObject({ code: 'LVE_003', httpStatus: 422 });
  });
});

// ─── U-LVE-06: leaveYear computed correctly ────────────────────────────────────

describe('U-LVE-06: leaveYear computed from startDate + leaveYearStartMonth', () => {
  it('sets leaveYear = 2026 for Jan fiscal year when applying in June 2026', async () => {
    mockFindByIdLean(User, makeUser());
    const created = makeLeave();
    jest.spyOn(Leave, 'create').mockResolvedValue(created as never);

    const result = await LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'paidLeave',
      startDate:  FUTURE_DATE,
      endDate:    FUTURE_DATE,
      duration:   'full',
    });

    expect(result.leaveYear).toBeGreaterThanOrEqual(2026);
  });
});

// ─── U-LVE-07: affectedDates excludes weekends and holidays ───────────────────

describe('U-LVE-07: affectedDates excludes weekends and holidays', () => {
  it('excludes weekend from affectedDates for a week-long range', async () => {
    mockFindByIdLean(User, makeUser({ leaveBalances: {
      paidLeave: { currentYear: 10, carriedForward: 0 },
      sickLeave: { currentYear: 8, carriedForward: 0 },
      casualLeave: { currentYear: 6, carriedForward: 0 },
    }}));

    // Find a Monday and go to the following Sunday (7 days: Mon-Sun)
    const mon = new Date(FUTURE_DATE + 'T00:00:00Z');
    while (mon.getUTCDay() !== 1) mon.setDate(mon.getDate() + 1);
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    const monStr = mon.toISOString().slice(0, 10);
    const sunStr = sun.toISOString().slice(0, 10);

    const created = makeLeave({ affectedDates: [monStr], totalDays: 5 });
    jest.spyOn(Leave, 'create').mockResolvedValue(created as never);

    const result = await LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'paidLeave',
      startDate:  monStr,
      endDate:    sunStr,
      duration:   'full',
    });

    // affectedDates should not contain Saturday/Sunday
    for (const d of result.affectedDates) {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      expect([0, 6]).not.toContain(dow);
    }
  });
});

function setupApproveMocks() {
  jest.spyOn(User, 'findOneAndUpdate').mockResolvedValue({} as never);
  jest.spyOn(LeaveTransaction, 'create').mockResolvedValue([] as never);
  jest.spyOn(AttendanceDay, 'findOneAndUpdate').mockResolvedValue(null as never);
  jest.spyOn(AttendanceSession, 'findOne').mockReturnValue({
    session: jest.fn().mockReturnThis(),
    lean:    jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof AttendanceSession.findOne>);
  jest.spyOn(Leave, 'findByIdAndUpdate').mockResolvedValue({} as never);
}

// ─── U-LVE-08: Approve — atomic deduction + AttendanceDay + LeaveTransaction ──

describe('U-LVE-08: approve() deducts balance atomically', () => {
  it('calls User.findOneAndUpdate and creates LeaveTransaction deduction-approval', async () => {
    const txSession = mockTransaction();
    mockFindByIdLean(Leave, makeLeave());
    mockFindByIdLean(User, makeUser());
    const findOneAndUpdateSpy = jest.spyOn(User, 'findOneAndUpdate').mockResolvedValue({} as never);
    setupApproveMocks();

    const result = await LeaveService.approve(LEAVE_ID, ADMIN_ID);

    expect(txSession.withTransaction).toHaveBeenCalled();
    expect(findOneAndUpdateSpy).toHaveBeenCalled();
    expect(result.status).toBe('approved');
    expect(result.balanceAfter).toBeDefined();
  });
});

// ─── U-LVE-09: Approve with carry-forward — consumed first ────────────────────

describe('U-LVE-09: approve() carry-forward consumed first', () => {
  it('deducts carriedForward before currentYear', async () => {
    mockTransaction();
    const leave = makeLeave({ totalDays: 4 });
    mockFindByIdLean(Leave, leave);
    mockFindByIdLean(User, makeUser({
      leaveBalances: {
        paidLeave:   { currentYear: 3, carriedForward: 2, carryForwardExpiry: new Date(Date.now() + 86_400_000 * 90) },
        sickLeave:   { currentYear: 8, carriedForward: 0 },
        casualLeave: { currentYear: 6, carriedForward: 0 },
      },
    }));
    const updateSpy = jest.spyOn(User, 'findOneAndUpdate').mockResolvedValue({} as never);
    setupApproveMocks();

    await LeaveService.approve(LEAVE_ID, ADMIN_ID);

    // Filter should include carriedForward constraint (deduct from CF first)
    // key is a literal dot-string (not nested), use bracket access
    const callArg = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg['leaveBalances.paidLeave.carriedForward']).toBeDefined();
  });
});

// ─── U-LVE-10: Approve with exact balance → reaches 0 ────────────────────────

describe('U-LVE-10: approve() with exact balance reaches 0', () => {
  it('balance reaches 0 without underflow', async () => {
    mockTransaction();
    const leave = makeLeave({ totalDays: 3 });
    mockFindByIdLean(Leave, leave);
    mockFindByIdLean(User, makeUser({
      leaveBalances: {
        paidLeave:   { currentYear: 3, carriedForward: 0 },
        sickLeave:   { currentYear: 8, carriedForward: 0 },
        casualLeave: { currentYear: 6, carriedForward: 0 },
      },
    }));
    setupApproveMocks();

    const result = await LeaveService.approve(LEAVE_ID, ADMIN_ID);

    expect(result.balanceAfter?.currentYear).toBe(0);
    expect(result.status).toBe('approved');
  });
});

// ─── U-LVE-11: Reject — no balance change ─────────────────────────────────────

describe('U-LVE-11: reject() pending leave', () => {
  it('sets status rejected; no balance change; no LeaveTransaction', async () => {
    const leave = makeLeave();
    mockFindByIdLean(Leave, leave);
    jest.spyOn(Leave, 'findById').mockResolvedValue(leave as never);
    const createSpy = jest.spyOn(LeaveTransaction, 'create');

    const result = await LeaveService.reject(LEAVE_ID, ADMIN_ID, 'Not approved');

    expect(result.status).toBe('rejected');
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ─── U-LVE-12: Cancel pending leave by employee ───────────────────────────────

describe('U-LVE-12: cancel() pending leave by employee', () => {
  it('sets status cancelled; no balance change', async () => {
    const leave = makeLeave();
    jest.spyOn(Leave, 'findById').mockResolvedValue(leave as never);

    const result = await LeaveService.cancel(LEAVE_ID, EMP_ID);

    expect(result.status).toBe('cancelled');
    // Conditional on owner + pending (replaces the old unconditional doc.save()).
    expect(Leave.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      { $set: { status: 'cancelled' } },
      expect.anything(),
    );
  });
});

// ─── U-LVE-13: Cancel approved leave by employee ──────────────────────────────

describe('U-LVE-13: cancel() approved leave by employee', () => {
  it('throws LVE_007 LEAVE_CANCELLATION_NOT_ALLOWED', async () => {
    const leave = makeLeave({ status: 'approved' });
    jest.spyOn(Leave, 'findById').mockResolvedValue(leave as never);

    await expect(LeaveService.cancel(LEAVE_ID, EMP_ID))
      .rejects.toMatchObject({ code: 'LVE_007', httpStatus: 422 });
  });
});

// ─── U-LVE-14: Revoke approved leave ──────────────────────────────────────────

describe('U-LVE-14: revoke() approved leave', () => {
  it('restores balance, creates restoration-revocation transaction, reverts AttendanceDay', async () => {
    const txSession = mockTransaction();
    const leave = makeLeave({ status: 'approved' });
    mockFindByIdLean(Leave, leave);
    mockFindByIdLean(User, makeUser({ leaveBalances: {
      paidLeave:   { currentYear: 9, carriedForward: 0 },
      sickLeave:   { currentYear: 8, carriedForward: 0 },
      casualLeave: { currentYear: 6, carriedForward: 0 },
    }}));

    jest.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({} as never);
    const txCreateSpy = jest.spyOn(LeaveTransaction, 'create').mockResolvedValue([] as never);
    jest.spyOn(AttendanceDay, 'findOne').mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean:    jest.fn().mockResolvedValue({ _id: new mongoose.Types.ObjectId(), totalMinutes: 0, requiredMinutes: 540 }),
    } as unknown as ReturnType<typeof AttendanceDay.findOne>);
    jest.spyOn(AttendanceDay, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never);
    jest.spyOn(Leave, 'findByIdAndUpdate').mockResolvedValue({} as never);
    jest.spyOn(require('@models/PayrollRecord').PayrollRecord, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const result = await LeaveService.revoke(LEAVE_ID, ADMIN_ID, 'Revocation for testing purposes');

    expect(txSession.withTransaction).toHaveBeenCalled();
    expect(txCreateSpy).toHaveBeenCalled();
    expect(result.status).toBe('revoked');
    expect(result.balanceAfter?.currentYear).toBe(10); // 9 + 1
  });
});

// ─── U-LVE-15: Revoke non-approved leave ──────────────────────────────────────

describe('U-LVE-15: revoke() non-approved leave', () => {
  it('throws LVE_006 LEAVE_REVOCATION_NOT_ALLOWED', async () => {
    const leave = makeLeave({ status: 'pending' });
    mockFindByIdLean(Leave, leave);

    await expect(LeaveService.revoke(LEAVE_ID, ADMIN_ID, 'Trying to revoke pending'))
      .rejects.toMatchObject({ code: 'LVE_006', httpStatus: 422 });
  });
});

// ─── U-LVE-16: Half-day deducts 0.5 days ─────────────────────────────────────

describe('U-LVE-16: apply() half-day leave deducts 0.5 days', () => {
  it('totalDays = 0.5 for half-day duration', async () => {
    mockFindByIdLean(User, makeUser());
    const created = makeLeave({ totalDays: 0.5, duration: 'half' });
    jest.spyOn(Leave, 'create').mockResolvedValue(created as never);

    const result = await LeaveService.apply({
      employeeId:   EMP_ID,
      leaveType:    'paidLeave',
      startDate:    FUTURE_DATE,
      endDate:      FUTURE_DATE,
      duration:     'half',
      halfDayPeriod: 'morning',
    } as Parameters<typeof LeaveService.apply>[0]);

    expect(result.totalDays).toBe(0.5);
  });
});

// ─── U-LVE-17: LWP — no balance check ────────────────────────────────────────

describe('U-LVE-17: apply() LWP — no balance check', () => {
  it('creates lwp leave without checking balance', async () => {
    // No User.findById call expected for LWP
    const userSpy = jest.spyOn(User, 'findById');
    const created = makeLeave({ leaveType: 'lwp' });
    jest.spyOn(Leave, 'create').mockResolvedValue(created as never);

    await LeaveService.apply({
      employeeId: EMP_ID,
      leaveType:  'lwp',
      startDate:  FUTURE_DATE,
      endDate:    FUTURE_DATE,
      duration:   'full',
    });

    expect(userSpy).not.toHaveBeenCalled();
  });
});

// ─── Concurrency: duplicate/racing state transitions ─────────────────────────

describe('U-LVE-RACE: conditional state transitions', () => {
  it('a second concurrent approval aborts before deducting balance', async () => {
    mockTransaction();
    mockFindByIdLean(Leave, makeLeave());
    mockFindByIdLean(User, makeUser());
    jest.spyOn(Leave, 'findOneAndUpdate').mockResolvedValue(null as never); // already approved
    const deduct = jest.spyOn(User, 'findOneAndUpdate');
    await expect(LeaveService.approve(LEAVE_ID, ADMIN_ID)).rejects.toMatchObject({ code: 'LVE_005' });
    expect(deduct).not.toHaveBeenCalled();
  });

  it('cancel loses cleanly when the leave was approved in between', async () => {
    jest.spyOn(Leave, 'findById').mockResolvedValue(makeLeave() as never);
    jest.spyOn(Leave, 'findOneAndUpdate').mockResolvedValue(null as never);
    await expect(LeaveService.cancel(LEAVE_ID, EMP_ID)).rejects.toMatchObject({ code: 'LVE_007' });
  });

  it('reject loses cleanly when the leave was cancelled in between', async () => {
    jest.spyOn(Leave, 'findById').mockResolvedValue(makeLeave() as never);
    jest.spyOn(Leave, 'findOneAndUpdate').mockResolvedValue(null as never);
    await expect(LeaveService.reject(LEAVE_ID, ADMIN_ID, 'x')).rejects.toMatchObject({ code: 'LVE_005' });
  });
});

// ─── Authorization: manager / executive are not HR admins ────────────────────

describe('U-LVE-AUTHZ: non-HR-admin roles see only their own leave', () => {
  it.each(['manager', 'executive'] as const)('%s list is forced to own employeeId', async (role) => {
    const find = jest.spyOn(Leave, 'find').mockReturnValue({
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    } as never);
    jest.spyOn(Leave, 'countDocuments').mockResolvedValue(0 as never);
    const actor = new mongoose.Types.ObjectId().toHexString();
    await LeaveService.list({ actorId: actor, role, employeeId: EMP_ID, page: 1, limit: 20, sortBy: 'createdAt' } as never);
    expect(String((find.mock.calls[0][0] as Record<string, unknown>).employeeId)).toBe(actor);
  });

  it.each(['manager', 'executive'] as const)('%s cannot read another employee leave by id', async (role) => {
    mockFindByIdLean(Leave, makeLeave());
    const actor = new mongoose.Types.ObjectId().toHexString();
    await expect(LeaveService.getById(LEAVE_ID, actor, role)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('super_admin may read any leave (consistent with admin)', async () => {
    mockFindByIdLean(Leave, makeLeave());
    mockFindByIdLean(User, { firstName: 'Asha', lastName: 'Rao' });
    // The detail view now carries the same employee name the admin list shows
    // (it previously returned employeeName: null and the portal showed a raw id).
    await expect(LeaveService.getById(LEAVE_ID, ADMIN_ID, 'super_admin')).resolves.toMatchObject({ employeeName: 'Asha Rao' });
  });
});
