import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import mongoose from 'mongoose';
import { User } from '@models/User';
import { LeaveService } from '@services/LeaveService';

// Model calls are mocked below; simulate a connected DB for the test-db guard.
Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

// Regression: the admin "Leave Balances" page called GET /leaves/balance, which
// returns ONE employee's object ({ paidLeave, sickLeave, casualLeave, asOf }),
// and crashed with "balances.map is not a function". listBalances() is the
// admin list it needed. It only re-shapes the values getBalance() already
// computes — no invented entitled/used figures.

const FUTURE = new Date(Date.now() + 30 * 86_400_000);
const PAST   = new Date(Date.now() - 86_400_000);

function user(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    employeeId: 'TST-EA', firstName: 'Test', lastName: 'Employee A',
    leaveBalances: {
      paidLeave:   { currentYear: 1.5, carriedForward: 0.5, carryForwardExpiry: FUTURE },
      sickLeave:   { currentYear: 8,   carriedForward: 2,   carryForwardExpiry: PAST },
      casualLeave: { currentYear: 0,   carriedForward: 0 },
    },
    ...overrides,
  };
}

let findSpy: ReturnType<typeof jest.spyOn>;
let countSpy: ReturnType<typeof jest.spyOn>;

function mockUsers(users: unknown[], total = users.length) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    sort:   jest.fn().mockReturnThis(),
    skip:   jest.fn().mockReturnThis(),
    limit:  jest.fn().mockReturnThis(),
    lean:   jest.fn().mockResolvedValue(users as never),
  };
  findSpy = jest.spyOn(User, 'find').mockReturnValue(chain as unknown as ReturnType<typeof User.find>);
  countSpy = jest.spyOn(User, 'countDocuments').mockResolvedValue(total as never);
  return chain;
}

beforeEach(() => { jest.restoreAllMocks(); });

describe('LeaveService.listBalances (admin Leave Balances page)', () => {
  it('returns one row per leave type with fractional values preserved', async () => {
    const u = user();
    mockUsers([u]);

    const r = await LeaveService.listBalances({ page: 1, limit: 20 });

    expect(r.data).toHaveLength(3);
    expect(r.data[0]).toEqual({
      employee: { _id: u._id.toHexString(), firstName: 'Test', lastName: 'Employee A', employeeId: 'TST-EA' },
      leaveType: 'paidLeave', currentYear: 1.5, carriedForward: 0.5,
      carryForwardExpiry: FUTURE.toISOString().slice(0, 10), available: 2,
    });
  });

  it('ignores an expired carry-forward exactly like getBalance()', async () => {
    mockUsers([user()]);
    const r = await LeaveService.listBalances({ page: 1, limit: 20 });
    const sick = r.data.find((x) => x.leaveType === 'sickLeave')!;
    expect(sick.carriedForward).toBe(0);
    expect(sick.available).toBe(8);
  });

  it('handles zero balances and whole days', async () => {
    mockUsers([user()]);
    const r = await LeaveService.listBalances({ page: 1, limit: 20 });
    const casual = r.data.find((x) => x.leaveType === 'casualLeave')!;
    expect(casual).toMatchObject({ currentYear: 0, carriedForward: 0, available: 0, carryForwardExpiry: null });
  });

  it('paginates by employee and reports totals', async () => {
    const chain = mockUsers([user(), user({ employeeId: 'TST-EB' })], 41);
    const r = await LeaveService.listBalances({ page: 3, limit: 20 });
    expect(chain.skip).toHaveBeenCalledWith(40);
    expect(chain.limit).toHaveBeenCalledWith(20);
    expect(r.pagination).toEqual({ page: 3, limit: 20, total: 41, totalPages: 3 });
  });

  it('searches name/email/employee id with the input regex-escaped', async () => {
    mockUsers([]);
    await LeaveService.listBalances({ page: 1, limit: 20, search: 'a.b(' });
    const filter = findSpy.mock.calls[0][0] as { $or: Array<Record<string, { $regex: string }>> };
    expect(filter.$or.map((c) => Object.values(c)[0].$regex)).toEqual(Array(4).fill('a\\.b\\('));
    expect(countSpy).toHaveBeenCalledWith(filter);
  });
});
