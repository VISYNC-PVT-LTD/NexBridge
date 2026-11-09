/**
 * Leave withdraw/revoke must not fabricate "absent" days in the future — real DB.
 *
 * Regression (found in local web testing): approving a future leave creates an
 * AttendanceDay(status 'leave'); withdrawing/revoking it recomputed the status
 * from 0 minutes and left a FUTURE day marked 'absent' in the admin portal
 * (and available to reports/payroll). A day that only existed to hold the leave
 * must be removed; past days keep the existing recomputation.
 *
 * Same isolated in-memory replica set setup as missed-checkout.test.ts.
 * Run: MONGOMS_SYSTEM_BINARY=/path/to/mongod npx jest src/__tests__/integration
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import net from 'net';
import mongoose from 'mongoose';

const BIN = process.env.MONGOMS_SYSTEM_BINARY;
const suite = BIN || process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(120_000);

const guard = (globalThis as unknown as { __TEST_NETWORK_GUARD__: { allowLoopbackPort(p: number): void } })
  .__TEST_NETWORK_GUARD__;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function setClock(d: Date) {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
  jest.setSystemTime(d);
}

// Monday 2 March 2026, 09:00 IST.
const MON = new Date('2026-03-02T03:30:00Z');

suite('leave withdraw/revoke vs future AttendanceDays (real DB)', () => {
  let rs: { getUri(): string; stop(): Promise<boolean> };
  let LeaveService: typeof import('@services/LeaveService').LeaveService;
  let M: Record<string, mongoose.Model<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ADMIN = new mongoose.Types.ObjectId().toHexString();

  beforeAll(async () => {
    const port = await freePort();
    guard.allowLoopbackPort(port);
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    rs = await MongoMemoryReplSet.create({
      binary: { systemBinary: BIN },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ port, ip: '127.0.0.1' }],
    });
    await mongoose.connect(rs.getUri(), { dbName: 'genesis-leave-revert-test' });
    M = {
      User: (await import('@models/User')).User,
      CompanySettings: (await import('@models/CompanySettings')).CompanySettings,
      AttendanceDay: (await import('@models/AttendanceDay')).AttendanceDay,
      AttendanceSession: (await import('@models/AttendanceSession')).AttendanceSession,
      Leave: (await import('@models/Leave')).Leave,
      LeaveTransaction: (await import('@models/LeaveTransaction')).LeaveTransaction,
      AuditLog: (await import('@models/AuditLog')).AuditLog,
      Holiday: (await import('@models/Holiday')).Holiday,
      PayrollRecord: (await import('@models/PayrollRecord')).PayrollRecord,
    };
    for (const m of Object.values(M)) await m.syncIndexes();
    LeaveService = (await import('@services/LeaveService')).LeaveService;
  });

  afterAll(async () => {
    jest.useRealTimers();
    await mongoose.disconnect();
    await rs?.stop();
  });

  beforeEach(async () => {
    jest.useRealTimers();
    for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
    await M.CompanySettings.collection.insertOne({
      _id: 'company-settings', timezone: 'Asia/Kolkata', workStartTime: '09:00', workEndTime: '18:00',
      requiredDailyMinutes: 540, halfDayThresholdMinutes: 270, halfDayLateCheckInTime: '13:00',
      lateArrivalGraceMinutes: 15, workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      geoFence: { isEnabled: true, latitude: 12.9, longitude: 77.6, radiusMeters: 200 },
      gpsAccuracyThresholdMeters: 100, checkinTimestampWindowMinutes: 10, regularizationLookbackDays: 30,
      leaveYearStartMonth: 1, leaveTypes: { casualLeave: { annualAllocation: 6 } },
    } as never);
  });
  afterEach(() => jest.useRealTimers());

  async function seedEmployee() {
    const _id = new mongoose.Types.ObjectId();
    await M.User.collection.insertOne({
      _id, employeeId: `E${_id.toHexString().slice(-6)}`, firstName: 'Test', lastName: 'Employee',
      email: `${_id.toHexString()}@example.invalid`, passwordHash: 'x', role: 'employee', isActive: true,
      requiresPasswordChange: false, monthlySalary: 30000, dateOfJoining: new Date('2025-01-01'),
      leaveBalances: {
        paidLeave: { currentYear: 10, carriedForward: 0 },
        sickLeave: { currentYear: 5, carriedForward: 0 },
        casualLeave: { currentYear: 5, carriedForward: 0 },
      },
    });
    return _id.toHexString();
  }

  async function approvedLeave(emp: string, date: string) {
    const leave = await LeaveService.apply({ employeeId: emp, leaveType: 'casualLeave', startDate: date, endDate: date, duration: 'full', reason: 'test' } as never) as { id: string };
    await LeaveService.approve(leave.id, ADMIN);
    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: date }).lean();
    expect(day?.status).toBe('leave'); // approval created the day
    return leave.id;
  }

  const casualBalance = async (emp: string) =>
    ((await M.User.findById(emp).lean()) as { leaveBalances: { casualLeave: { currentYear: number } } }).leaveBalances.casualLeave.currentYear;

  it('withdrawing a future leave removes the leave-only day instead of marking it absent', async () => {
    const emp = await seedEmployee();
    setClock(MON);
    const id = await approvedLeave(emp, '2026-03-05');
    expect(await casualBalance(emp)).toBe(4);

    await LeaveService.withdraw(id, emp, 'plans changed');

    expect(await M.AttendanceDay.countDocuments({ employeeId: emp, dateString: '2026-03-05' })).toBe(0);
    expect(await M.AttendanceDay.countDocuments({ employeeId: emp, status: 'absent' })).toBe(0);
    expect(await casualBalance(emp)).toBe(5);
    expect((await M.Leave.findById(id).lean())?.status).toBe('withdrawn');
  });

  it('revoking a future leave removes the leave-only day instead of marking it absent', async () => {
    const emp = await seedEmployee();
    setClock(MON);
    const id = await approvedLeave(emp, '2026-03-06');

    await LeaveService.revoke(id, ADMIN, 'Revoked for local regression test');

    expect(await M.AttendanceDay.countDocuments({ employeeId: emp, dateString: '2026-03-06' })).toBe(0);
    expect((await M.Leave.findById(id).lean())?.status).toBe('revoked');
  });

  it('control: revoking after the leave day has passed still records it as absent (unchanged behaviour)', async () => {
    const emp = await seedEmployee();
    setClock(MON);
    const id = await approvedLeave(emp, '2026-03-03');

    setClock(new Date('2026-03-04T06:00:00Z')); // Wed — the leave day (Tue) is in the past
    await LeaveService.revoke(id, ADMIN, 'Revoked for local regression test');

    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-03-03' }).lean();
    expect(day?.status).toBe('absent');
    expect(day?.leaveRequestId).toBeUndefined();
  });
});
