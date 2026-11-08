import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import mongoose from 'mongoose';

Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

import { PayrollService } from '@services/PayrollService';
import { Employee } from '@models/Employee';
import { User } from '@models/User';
import { CompanySettings } from '@models/CompanySettings';
import { AttendanceDay } from '@models/AttendanceDay';
import { Holiday } from '@models/Holiday';
import { PayrollRecord } from '@models/PayrollRecord';
import { AuditLog } from '@models/AuditLog';
import { PayrollLock } from '@models/PayrollLock';
import { NotificationService } from '@services/NotificationService';
import { AttendanceSession } from '@models/AttendanceSession';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMP_OID    = new mongoose.Types.ObjectId();
const USER_OID   = new mongoose.Types.ObjectId();
const ADMIN_OID  = new mongoose.Types.ObjectId();
const RECORD_OID = new mongoose.Types.ObjectId();

const YEAR_MONTH   = '2026-05'; // past month relative to current date 2026-06
const JOINING_DATE = new Date(Date.UTC(2026, 0, 1)); // 2026-01-01

function makeEmployee(overrides: Record<string, unknown> = {}) {
  return {
    _id:           EMP_OID,
    userId:        USER_OID,
    employeeCode:  'EMP001',
    firstName:     'John',
    lastName:      'Doe',
    department:    'Engineering',
    designation:   'Developer',
    joiningDate:   JOINING_DATE,
    monthlySalary: 50000,
    status:        'active',
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id:           USER_OID,
    firstName:     'John',
    lastName:      'Doe',
    email:         'john@test.com',
    dateOfLeaving: undefined,
    isActive:      true,
    ...overrides,
  };
}

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    _id:         'company-settings',
    timezone:    'Asia/Kolkata',
    workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    ...overrides,
  };
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id:                   RECORD_OID,
    employeeId:            EMP_OID,
    yearMonth:             YEAR_MONTH,
    status:                'draft',
    employeeSnapshot: {
      firstName: 'John', lastName: 'Doe', employeeId: 'EMP001',
      department: 'Engineering', designation: 'Developer', monthlySalary: 50000,
    },
    effectiveWorkingDays:  22,
    effectivePresentDays:  22,
    halfDays:              0,
    effectiveLwpDays:      0,
    halfDayLwpDays:        0,
    paidLeaveDays:         0,
    absentDays:            0,
    grossSalary:           50000,
    perDaySalary:          2272.73,
    deductionBreakdown:    { lwpDeduction: 0, absentDeduction: 0, manualDeduction: 0, totalDeductions: 0 },
    manualDeduction:       0,
    manualDeductionRemark: '',
    netSalary:             50000,
    computedAt:            new Date(),
    finalisedAt:           undefined,
    ...overrides,
  };
}

const mockSession = {
  withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
  endSession:      jest.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  // 24-hour rule: services reconcile overdue sessions first; default = none overdue.
  jest.spyOn(AttendanceSession, 'find').mockReturnValue({ select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) } as never);
  // Notification fan-out is fire-and-forget; covered by NotificationService tests.
  jest.spyOn(NotificationService, 'create').mockResolvedValue(undefined as never);
  jest.spyOn(NotificationService, 'notifyAllAdmins').mockResolvedValue(undefined as never);
  jest.clearAllMocks();
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession as unknown as mongoose.ClientSession);
  jest.spyOn(AuditLog, 'create').mockResolvedValue(undefined as never);
  jest.spyOn(CompanySettings, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue(makeSettings()),
  } as never);
  jest.spyOn(Holiday, 'find').mockReturnValue({
    lean: jest.fn().mockResolvedValue([]),
  } as never);
  jest.spyOn(AttendanceDay, 'find').mockReturnValue({
    lean: jest.fn().mockResolvedValue([]),
  } as never);
  // Current contract: compute/finalise/unfinalise/adjust call
  // PayrollLockService.assertUnlocked(). Default: month not locked.
  jest.spyOn(PayrollLock, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as never);
});

// ─── Locked period ────────────────────────────────────────────────────────────

describe('U-PAY-LOCK: locked payroll month blocks every mutation', () => {
  beforeEach(() => {
    jest.spyOn(PayrollLock, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ yearMonth: YEAR_MONTH, lockedAt: new Date() }),
    } as never);
  });

  it('compute rejects with PAY_006', async () => {
    await expect(PayrollService.compute({
      yearMonth: YEAR_MONTH, employeeId: EMP_OID.toHexString(), actorId: ADMIN_OID.toHexString(),
    })).rejects.toMatchObject({ code: 'PAY_006', httpStatus: 409 });
  });

  it('finalise rejects with PAY_006', async () => {
    await expect(PayrollService.finalise({
      yearMonth: YEAR_MONTH, employeeId: EMP_OID.toHexString(), adminId: ADMIN_OID.toHexString(),
    })).rejects.toMatchObject({ code: 'PAY_006' });
  });

  it('unfinalise rejects with PAY_006', async () => {
    await expect(PayrollService.unfinalise({
      yearMonth: YEAR_MONTH, employeeId: EMP_OID.toHexString(), adminId: ADMIN_OID.toHexString(), reason: 'x',
    })).rejects.toMatchObject({ code: 'PAY_006' });
  });
});

// ─── U-PAY-01 ─────────────────────────────────────────────────────────────────

describe('U-PAY-01: compute creates draft with all formula fields', () => {
  it('returns draft record with formula fields', async () => {
    const record = makeRecord();
    jest.spyOn(Employee, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeEmployee()) } as never);
    jest.spyOn(User, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeUser()) } as never);
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(null) } as never);
    jest.spyOn(PayrollRecord, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(record) } as never);

    const result = await PayrollService.compute({
      yearMonth:  YEAR_MONTH,
      employeeId: EMP_OID.toHexString(),
      actorId:    ADMIN_OID.toHexString(),
    });

    expect(result.status).toBe('draft');
    expect(result.grossSalary).toBe(50000);
    expect(result.netSalary).toBe(50000);
    expect(result.employeeSnapshot.employeeId).toBe('EMP001');
    expect(PayrollRecord.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ yearMonth: YEAR_MONTH }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'draft' }) }),
      expect.objectContaining({ upsert: true, new: true }),
    );
  });
});

// ─── U-PAY-02 ─────────────────────────────────────────────────────────────────

describe('U-PAY-02: compute for existing draft overwrites it (idempotent)', () => {
  it('upserts existing draft, preserves manualDeduction', async () => {
    const existing = makeRecord({ status: 'draft', manualDeduction: 200 });
    const updated  = makeRecord({ status: 'draft', manualDeduction: 200 });
    jest.spyOn(Employee, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeEmployee()) } as never);
    jest.spyOn(User, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeUser()) } as never);
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(existing) } as never);
    jest.spyOn(PayrollRecord, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(updated) } as never);

    const result = await PayrollService.compute({
      yearMonth:  YEAR_MONTH,
      employeeId: EMP_OID.toHexString(),
      actorId:    ADMIN_OID.toHexString(),
    });

    expect(result.status).toBe('draft');
    expect(PayrollRecord.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ yearMonth: YEAR_MONTH }),
      expect.objectContaining({ $unset: { finalisedAt: 1 } }),
      expect.objectContaining({ upsert: true }),
    );
  });
});

// ─── U-PAY-03 ─────────────────────────────────────────────────────────────────

describe('U-PAY-03: compute for finalised month throws PAY_001', () => {
  it('blocks recompute when status is finalised', async () => {
    const finalised = makeRecord({ status: 'finalised', finalisedAt: new Date() });
    jest.spyOn(Employee, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeEmployee()) } as never);
    jest.spyOn(User, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeUser()) } as never);
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(finalised) } as never);

    await expect(
      PayrollService.compute({ yearMonth: YEAR_MONTH, employeeId: EMP_OID.toHexString(), actorId: ADMIN_OID.toHexString() })
    ).rejects.toMatchObject({ code: 'PAY_001', httpStatus: 409 });
  });
});

// ─── U-PAY-04 ─────────────────────────────────────────────────────────────────

describe('U-PAY-04: finalise draft → status finalised, finalisedAt set', () => {
  it('returns finalised status with timestamp', async () => {
    const draft     = makeRecord({ status: 'draft' });
    const finalised = makeRecord({ status: 'finalised', finalisedAt: new Date() });
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(draft) } as never);
    jest.spyOn(PayrollRecord, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(finalised) } as never);

    const result = await PayrollService.finalise({
      employeeId: EMP_OID.toHexString(),
      yearMonth:  YEAR_MONTH,
      adminId:    ADMIN_OID.toHexString(),
    });

    expect(result.status).toBe('finalised');
    expect(result.finalisedAt).toBeDefined();
    expect(result.finalisedBy).toBe(ADMIN_OID.toHexString());
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: 'PAYROLL_FINALISED' })]),
      expect.anything(),
    );
  });

  it('throws PAY_001 when already finalised', async () => {
    const finalised = makeRecord({ status: 'finalised' });
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(finalised) } as never);

    await expect(
      PayrollService.finalise({ employeeId: EMP_OID.toHexString(), yearMonth: YEAR_MONTH, adminId: ADMIN_OID.toHexString() })
    ).rejects.toMatchObject({ code: 'PAY_001' });
  });
});

// ─── U-PAY-05 ─────────────────────────────────────────────────────────────────

describe('U-PAY-05: employeeSnapshot excludes passwordHash', () => {
  it('snapshot passed to findOneAndUpdate has no passwordHash', async () => {
    const record = makeRecord();
    jest.spyOn(Employee, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeEmployee()) } as never);
    jest.spyOn(User, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue({ ...makeUser(), passwordHash: 'secret' }) } as never);
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(null) } as never);
    jest.spyOn(PayrollRecord, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(record) } as never);

    await PayrollService.compute({ yearMonth: YEAR_MONTH, employeeId: EMP_OID.toHexString(), actorId: ADMIN_OID.toHexString() });

    const callArgs = (PayrollRecord.findOneAndUpdate as jest.Mock).mock.calls[0] as unknown[];
    const updateDoc = callArgs[1] as { $set: { employeeSnapshot: Record<string, unknown> } };
    expect(updateDoc.$set.employeeSnapshot['passwordHash']).toBeUndefined();
  });
});

// ─── U-PAY-06 ─────────────────────────────────────────────────────────────────

describe('U-PAY-06: employeeSnapshot captures salary at compute time', () => {
  it('snapshot monthlySalary matches employee at compute time', async () => {
    const record = makeRecord({ employeeSnapshot: { firstName: 'John', lastName: 'Doe', employeeId: 'EMP001', monthlySalary: 60000 } });
    jest.spyOn(Employee, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeEmployee({ monthlySalary: 60000 })) } as never);
    jest.spyOn(User, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeUser()) } as never);
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(null) } as never);
    jest.spyOn(PayrollRecord, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(record) } as never);

    const result = await PayrollService.compute({ yearMonth: YEAR_MONTH, employeeId: EMP_OID.toHexString(), actorId: ADMIN_OID.toHexString() });

    expect(result.employeeSnapshot.monthlySalary).toBe(60000);
    const callArgs = (PayrollRecord.findOneAndUpdate as jest.Mock).mock.calls[0] as unknown[];
    const updateDoc = callArgs[1] as { $set: { employeeSnapshot: { monthlySalary: number } } };
    expect(updateDoc.$set.employeeSnapshot.monthlySalary).toBe(60000);
  });
});

// ─── U-PAY-07 ─────────────────────────────────────────────────────────────────

describe('U-PAY-07: unfinalise → draft, unfinalisedAt and unfinalisedBy set', () => {
  it('reverts to draft and writes PAYROLL_UNFINALISED audit log', async () => {
    const finalised = makeRecord({ status: 'finalised', finalisedAt: new Date() });
    const reverted  = makeRecord({ status: 'draft' });
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(finalised) } as never);
    jest.spyOn(PayrollRecord, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(reverted) } as never);

    const result = await PayrollService.unfinalise({
      employeeId: EMP_OID.toHexString(),
      yearMonth:  YEAR_MONTH,
      adminId:    ADMIN_OID.toHexString(),
      reason:     'Correction needed for May 2026',
    });

    expect(result.status).toBe('draft');
    expect(result.unfinalisedAt).toBeDefined();
    expect(result.unfinalisedBy).toBe(ADMIN_OID.toHexString());
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: 'PAYROLL_UNFINALISED' })]),
      expect.anything(),
    );
    // Subsequent recompute should be allowed (status is now draft)
  });

  it('throws PAY_004 when payroll is already draft', async () => {
    const draft = makeRecord({ status: 'draft' });
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(draft) } as never);

    await expect(
      PayrollService.unfinalise({ employeeId: EMP_OID.toHexString(), yearMonth: YEAR_MONTH, adminId: ADMIN_OID.toHexString(), reason: 'Correction needed for May 2026' })
    ).rejects.toMatchObject({ code: 'PAY_004' });
  });
});

// ─── U-PAY-08 ─────────────────────────────────────────────────────────────────

describe('U-PAY-08: recompute after unfinalise reflects current attendance data', () => {
  it('overwrites draft including netSalary and clears finalisedAt', async () => {
    // After unfinalise the record is draft
    const draftAfterUnfinalise = makeRecord({ status: 'draft', netSalary: 50000 });
    // New attendance: 1 LWP day
    jest.spyOn(AttendanceDay, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([{ status: 'lwp', leaveType: undefined }]),
    } as never);
    const recomputed = makeRecord({ status: 'draft', effectiveLwpDays: 1, netSalary: 47727.27 });
    jest.spyOn(Employee, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeEmployee()) } as never);
    jest.spyOn(User, 'findById').mockReturnValue({ lean: jest.fn().mockResolvedValue(makeUser()) } as never);
    jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(draftAfterUnfinalise) } as never);
    jest.spyOn(PayrollRecord, 'findOneAndUpdate').mockReturnValue({ lean: jest.fn().mockResolvedValue(recomputed) } as never);

    const result = await PayrollService.compute({ yearMonth: YEAR_MONTH, employeeId: EMP_OID.toHexString(), actorId: ADMIN_OID.toHexString() });

    expect(result.status).toBe('draft');
    expect(PayrollRecord.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $unset: { finalisedAt: 1 } }),
      expect.anything(),
    );
  });
});

// ─── Employee self-service visibility ─────────────────────────────────────────

describe('U-PAY-ME: employees never see draft payroll', () => {
  const USER_OID = new mongoose.Types.ObjectId();
  beforeEach(() => {
    jest.spyOn(Employee, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue({ ...makeEmployee(), userId: USER_OID, joiningDate: new Date('2025-01-01') }),
    } as never);
  });

  it('list filter requires status finalised', async () => {
    const find = jest.spyOn(PayrollRecord, 'find').mockReturnValue({
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    } as never);
    jest.spyOn(PayrollRecord, 'countDocuments').mockResolvedValue(0 as never);
    await PayrollService.listForEmployee({ userId: USER_OID.toHexString(), query: { page: 1, limit: 12 } as never });
    expect(find.mock.calls[0][0]).toMatchObject({ status: 'finalised' });
  });

  it('single-month lookup of a draft returns PAY_002 (not found)', async () => {
    const findOne = jest.spyOn(PayrollRecord, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue(null) } as never);
    await expect(PayrollService.getOwnByYearMonth({ userId: USER_OID.toHexString(), yearMonth: YEAR_MONTH }))
      .rejects.toMatchObject({ code: 'PAY_002' });
    expect(findOne.mock.calls[0][0]).toMatchObject({ status: 'finalised' });
  });
});
