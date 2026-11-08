import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import mongoose from 'mongoose';

// Simulate already-connected DB so connectDB returns immediately
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

// Mock Brevo so no real emails are sent during tests
jest.mock('@lib/email/brevo', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

import { EmployeeService } from '@services/EmployeeService';
import { User } from '@models/User';
import { Employee } from '@models/Employee';
import { DeviceSession } from '@models/DeviceSession';
import { AuditLog } from '@models/AuditLog';
import { CompanySettings } from '@models/CompanySettings';
import { PasswordResetToken } from '@models/PasswordResetToken';
import { NotificationService } from '@services/NotificationService';

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
const EMP_ID = new mongoose.Types.ObjectId().toHexString();

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(EMP_ID),
    employeeId: 'EMP001',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    role: 'employee',
    phone: undefined,
    department: 'Engineering',
    designation: 'Developer',
    monthlySalary: 50000,
    dateOfJoining: new Date('2024-01-01'),
    dateOfLeaving: undefined,
    isActive: true,
    requiresPasswordChange: true,
    registeredDevice: null,
    leaveBalances: {
      paidLeave: { currentYear: 12, carriedForward: 0 },
      sickLeave: { currentYear: 8, carriedForward: 0 },
      casualLeave: { currentYear: 6, carriedForward: 0 },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockSettings(month = 1) {
  jest.spyOn(CompanySettings, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue({ leaveYearStartMonth: month }),
  } as unknown as ReturnType<typeof CompanySettings.findById>);
}

function makeQueryChain(resolveWith: unknown[]) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(resolveWith),
  };
  return chain as unknown as ReturnType<typeof User.find>;
}

beforeEach(() => {
  // Notification fan-out is fire-and-forget; covered by NotificationService tests.
  jest.spyOn(NotificationService, 'create').mockResolvedValue(undefined as never);
  jest.spyOn(NotificationService, 'notifyAllAdmins').mockResolvedValue(undefined as never);
  jest.spyOn(AuditLog, 'create').mockResolvedValue({} as never);
  jest.spyOn(Employee, 'create').mockResolvedValue({} as never);
  jest.spyOn(PasswordResetToken, 'create').mockResolvedValue({} as never);
  // Current contract: getById/update also read the Employee (payroll) profile
  // for allowOutsideGeofence. Default: no profile document.
  jest.spyOn(Employee, 'findOne').mockReturnValue({
    lean: jest.fn().mockResolvedValue(null),
  } as unknown as ReturnType<typeof Employee.findOne>);
  mockSettings();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('EmployeeService.list', () => {
  const query = { page: 1, limit: 20, sortBy: 'createdAt', sortOrder: 'desc' as const };

  it('throws AUTH_006 when requester is employee', async () => {
    await expect(EmployeeService.list(query, 'employee')).rejects.toMatchObject({ code: 'AUTH_006' });
  });

  it('returns paginated results for admin', async () => {
    jest.spyOn(User, 'find').mockReturnValue(makeQueryChain([makeUser()]));
    jest.spyOn(User, 'countDocuments').mockResolvedValue(1 as never);
    const result = await EmployeeService.list(query, 'admin');
    expect(result.pagination.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toHaveProperty('employeeId', 'EMP001');
  });

  it('applies search filter as $or regex', async () => {
    const findSpy = jest.spyOn(User, 'find').mockReturnValue(makeQueryChain([]));
    jest.spyOn(User, 'countDocuments').mockResolvedValue(0 as never);
    await EmployeeService.list({ ...query, search: 'Jane' }, 'admin');
    expect(findSpy.mock.calls[0][0]).toHaveProperty('$or');
  });

  it('applies isActive filter', async () => {
    const findSpy = jest.spyOn(User, 'find').mockReturnValue(makeQueryChain([]));
    jest.spyOn(User, 'countDocuments').mockResolvedValue(0 as never);
    await EmployeeService.list({ ...query, isActive: false }, 'admin');
    expect((findSpy.mock.calls[0][0] as Record<string, unknown>).isActive).toBe(false);
  });

  it('returns correct pagination meta', async () => {
    jest.spyOn(User, 'find').mockReturnValue(makeQueryChain([]));
    jest.spyOn(User, 'countDocuments').mockResolvedValue(45 as never);
    const result = await EmployeeService.list({ ...query, limit: 10, page: 2 }, 'admin');
    expect(result.pagination.totalPages).toBe(5);
    expect(result.pagination.page).toBe(2);
  });
});

// ─── create ───────────────────────────────────────────────────────────────────

describe('EmployeeService.create', () => {
  const data = {
    employeeId: 'EMP001', firstName: 'Jane', lastName: 'Doe',
    email: 'jane@example.com', role: 'employee' as const,
    monthlySalary: 50000, dateOfJoining: '2024-01-01',
  };

  it('creates user, sends invite email, and returns id/employeeId/email', async () => {
    jest.spyOn(User, 'create').mockResolvedValue(makeUser() as never);
    const result = await EmployeeService.create(data, ADMIN_ID);
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('employeeId');
    expect(result).toHaveProperty('email');
    expect(result).not.toHaveProperty('temporaryPassword');
    expect(PasswordResetToken.create).toHaveBeenCalled();
  });

  it('passes requiresPasswordChange: true to User.create', async () => {
    const createSpy = jest.spyOn(User, 'create').mockResolvedValue(makeUser() as never);
    await EmployeeService.create(data, ADMIN_ID);
    expect((createSpy.mock.calls[0][0] as Record<string, unknown>).requiresPasswordChange).toBe(true);
  });

  it('writes EMPLOYEE_CREATED audit log', async () => {
    jest.spyOn(User, 'create').mockResolvedValue(makeUser() as never);
    await EmployeeService.create(data, ADMIN_ID);
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EMPLOYEE_CREATED' }),
    );
  });

  it('throws GEN_006 on duplicate key (code 11000)', async () => {
    jest.spyOn(User, 'create').mockRejectedValue({ code: 11000 } as never);
    await expect(EmployeeService.create(data, ADMIN_ID)).rejects.toMatchObject({ code: 'GEN_006' });
  });

  it('rethrows non-duplicate errors', async () => {
    jest.spyOn(User, 'create').mockRejectedValue(new Error('DB timeout') as never);
    await expect(EmployeeService.create(data, ADMIN_ID)).rejects.toThrow('DB timeout');
  });

  it('normalises employeeId to uppercase', async () => {
    const createSpy = jest.spyOn(User, 'create').mockResolvedValue(makeUser() as never);
    await EmployeeService.create({ ...data, employeeId: 'emp001' }, ADMIN_ID);
    expect((createSpy.mock.calls[0][0] as Record<string, unknown>).employeeId).toBe('EMP001');
  });

  it('normalises email to lowercase', async () => {
    const createSpy = jest.spyOn(User, 'create').mockResolvedValue(makeUser() as never);
    await EmployeeService.create({ ...data, email: 'JANE@EXAMPLE.COM' }, ADMIN_ID);
    expect((createSpy.mock.calls[0][0] as Record<string, unknown>).email).toBe('jane@example.com');
  });
});

// ─── getById ──────────────────────────────────────────────────────────────────

describe('EmployeeService.getById', () => {
  it('throws AUTH_006 when requester is employee', async () => {
    await expect(EmployeeService.getById(EMP_ID, 'employee')).rejects.toMatchObject({ code: 'AUTH_006' });
  });

  it('throws GEN_002 on invalid ObjectId', async () => {
    await expect(EmployeeService.getById('not-an-id', 'admin')).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('throws GEN_002 when user not found', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(null);
    await expect(EmployeeService.getById(EMP_ID, 'admin')).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('returns full employee profile', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    const result = await EmployeeService.getById(EMP_ID, 'admin');
    expect(result).toHaveProperty('employeeId', 'EMP001');
    expect(result).toHaveProperty('monthlySalary', 50000);
    expect(result).toHaveProperty('leaveBalances');
    expect(result).toHaveProperty('hasRegisteredDevice', false);
  });
});

// ─── update ───────────────────────────────────────────────────────────────────

describe('EmployeeService.update', () => {
  it('throws GEN_002 on invalid ObjectId', async () => {
    await expect(EmployeeService.update('bad', {}, ADMIN_ID)).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('throws GEN_002 when user not found', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(null);
    await expect(EmployeeService.update(EMP_ID, { firstName: 'X' }, ADMIN_ID)).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('updates firstName and writes EMPLOYEE_UPDATED audit log', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    jest.spyOn(User, 'findByIdAndUpdate').mockResolvedValue(makeUser({ firstName: 'Updated' }) as never);
    const result = await EmployeeService.update(EMP_ID, { firstName: 'Updated' }, ADMIN_ID);
    expect(result.firstName).toBe('Updated');
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'EMPLOYEE_UPDATED' }));
  });

  it('uses $unset when phone set to null', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser({ phone: '+911234567890' }) as never);
    const updateSpy = jest.spyOn(User, 'findByIdAndUpdate').mockResolvedValue(makeUser() as never);
    await EmployeeService.update(EMP_ID, { phone: null }, ADMIN_ID);
    const op = updateSpy.mock.calls[0][1] as Record<string, Record<string, unknown>>;
    expect(op.$unset).toHaveProperty('phone');
  });

  it('uses $set when phone is string', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    const updateSpy = jest.spyOn(User, 'findByIdAndUpdate').mockResolvedValue(makeUser() as never);
    await EmployeeService.update(EMP_ID, { phone: '+911234567890' }, ADMIN_ID);
    const op = updateSpy.mock.calls[0][1] as Record<string, Record<string, unknown>>;
    expect(op.$set).toHaveProperty('phone', '+911234567890');
  });
});

// ─── activate ─────────────────────────────────────────────────────────────────

describe('EmployeeService.activate', () => {
  it('throws GEN_002 when user not found', async () => {
    jest.spyOn(User, 'findByIdAndUpdate').mockResolvedValue(null);
    await expect(EmployeeService.activate(EMP_ID, ADMIN_ID)).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('sets isActive true and writes EMPLOYEE_REACTIVATED audit log', async () => {
    jest.spyOn(User, 'findByIdAndUpdate').mockResolvedValue(makeUser({ isActive: true }) as never);
    const result = await EmployeeService.activate(EMP_ID, ADMIN_ID);
    expect(result.message).toMatch(/activated/i);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'EMPLOYEE_REACTIVATED' }));
  });
});

// ─── deactivate ───────────────────────────────────────────────────────────────

describe('EmployeeService.deactivate', () => {
  function setupTransaction() {
    const session = {
      withTransaction: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session as unknown as mongoose.ClientSession);
    jest.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true, modifiedCount: 1, matchedCount: 1, upsertedCount: 0, upsertedId: null });
    jest.spyOn(DeviceSession, 'updateMany').mockResolvedValue({ acknowledged: true, modifiedCount: 0 } as never);
    return session;
  }

  it('throws GEN_002 when user not found', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(null);
    await expect(EmployeeService.deactivate(EMP_ID, undefined, ADMIN_ID)).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('deactivates user and revokes sessions in a transaction', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    const session = setupTransaction();
    await EmployeeService.deactivate(EMP_ID, 'Resigned', ADMIN_ID);
    expect(session.withTransaction).toHaveBeenCalled();
    expect(User.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { isActive: false } },
      expect.objectContaining({ session }),
    );
    expect(DeviceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ isRevoked: false }),
      expect.objectContaining({ $set: expect.objectContaining({ isRevoked: true }) }),
      expect.objectContaining({ session }),
    );
  });

  it('writes EMPLOYEE_DEACTIVATED with reason', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    setupTransaction();
    await EmployeeService.deactivate(EMP_ID, 'Contract ended', ADMIN_ID);
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EMPLOYEE_DEACTIVATED', changes: { reason: 'Contract ended' } }),
    );
  });

  it('writes EMPLOYEE_DEACTIVATED without changes when no reason', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    setupTransaction();
    await EmployeeService.deactivate(EMP_ID, undefined, ADMIN_ID);
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EMPLOYEE_DEACTIVATED', changes: undefined }),
    );
  });
});

// ─── registerDevice ───────────────────────────────────────────────────────────

describe('EmployeeService.registerDevice', () => {
  const HEX64 = 'a'.repeat(64);

  it('throws GEN_002 when user not found', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(null);
    await expect(EmployeeService.registerDevice(EMP_ID, HEX64, undefined, ADMIN_ID)).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('stores SHA-256 hash of fingerprint, not raw value', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser({ registeredDevice: null }) as never);
    const updateSpy = jest.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true, modifiedCount: 1, matchedCount: 1, upsertedCount: 0, upsertedId: null });
    await EmployeeService.registerDevice(EMP_ID, HEX64, 'Pixel 8', ADMIN_ID);
    const op = updateSpy.mock.calls[0][1] as Record<string, Record<string, Record<string, string>>>;
    expect(op.$set.registeredDevice.fingerprintHash).not.toBe(HEX64);
    expect(op.$set.registeredDevice.fingerprintHash).toHaveLength(64);
  });

  it('writes DEVICE_REGISTERED audit log', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser({ registeredDevice: null }) as never);
    jest.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true, modifiedCount: 1, matchedCount: 1, upsertedCount: 0, upsertedId: null });
    await EmployeeService.registerDevice(EMP_ID, HEX64, 'Pixel 8', ADMIN_ID);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_REGISTERED' }));
  });
});

// ─── resetDevice ──────────────────────────────────────────────────────────────

describe('EmployeeService.resetDevice', () => {
  function setupTransaction() {
    const session = {
      withTransaction: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session as unknown as mongoose.ClientSession);
    jest.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true, modifiedCount: 1, matchedCount: 1, upsertedCount: 0, upsertedId: null });
    jest.spyOn(DeviceSession, 'updateMany').mockResolvedValue({ acknowledged: true, modifiedCount: 0 } as never);
    return session;
  }

  it('throws GEN_002 when user not found', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(null);
    await expect(EmployeeService.resetDevice(EMP_ID, ADMIN_ID)).rejects.toMatchObject({ code: 'GEN_002' });
  });

  it('clears registeredDevice and revokes sessions with device-change reason', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    const session = setupTransaction();
    await EmployeeService.resetDevice(EMP_ID, ADMIN_ID);
    expect(User.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: { registeredDevice: null } }),
      expect.objectContaining({ session }),
    );
    expect(DeviceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ isRevoked: false }),
      expect.objectContaining({ $set: expect.objectContaining({ revokedReason: 'device-change' }) }),
      expect.objectContaining({ session }),
    );
  });

  it('writes DEVICE_REVOKED audit log', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    setupTransaction();
    await EmployeeService.resetDevice(EMP_ID, ADMIN_ID);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DEVICE_REVOKED' }));
  });
});

// ─── leave balance pro-rating ─────────────────────────────────────────────────

describe('leave balance pro-rating', () => {
  it('allocates full 12 PL days when joining Jan 1 (leave year start)', async () => {
    mockSettings(1);
    let capturedArg: Record<string, unknown> = {};
    jest.spyOn(User, 'create').mockImplementation((args: unknown) => {
      capturedArg = args as Record<string, unknown>;
      return Promise.resolve(makeUser() as never);
    });
    const now = new Date();
    await EmployeeService.create(
      { employeeId: 'X01', firstName: 'A', lastName: 'B', email: 'a@b.com', role: 'employee', monthlySalary: 1, dateOfJoining: `${now.getFullYear()}-01-01` },
      ADMIN_ID,
    );
    const lb = capturedArg.leaveBalances as { paidLeave: { currentYear: number } };
    expect(lb.paidLeave.currentYear).toBe(12);
  });

  it('allocates pro-rated days when joining mid-year (July)', async () => {
    mockSettings(1);
    let capturedArg: Record<string, unknown> = {};
    jest.spyOn(User, 'create').mockImplementation((args: unknown) => {
      capturedArg = args as Record<string, unknown>;
      return Promise.resolve(makeUser() as never);
    });
    const now = new Date();
    await EmployeeService.create(
      { employeeId: 'X02', firstName: 'A', lastName: 'B', email: 'c@d.com', role: 'employee', monthlySalary: 1, dateOfJoining: `${now.getFullYear()}-07-01` },
      ADMIN_ID,
    );
    const lb = capturedArg.leaveBalances as { paidLeave: { currentYear: number } };
    expect(lb.paidLeave.currentYear).toBeGreaterThan(0);
    expect(lb.paidLeave.currentYear).toBeLessThan(12);
  });
});
