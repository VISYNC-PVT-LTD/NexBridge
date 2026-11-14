/**
 * forgotCheckIn approval keeps the employee's stated check-out — real DB.
 *
 * Regression: approving a forgotCheckIn that carried BOTH requestedCheckIn and
 * requestedCheckOut created a session WITHOUT a check-out and forced the day to
 * 'present' (the stated check-out was silently dropped). Spec TC-REG-011: the
 * regularization is added as a session and cumulative minutes are updated.
 *
 * Same isolated in-memory replica set setup as missed-checkout.test.ts.
 * Run: MONGOMS_SYSTEM_BINARY=/path/to/mongod npx jest src/__tests__/integration
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import net from 'net';
import mongoose from 'mongoose';
import { stampHeartbeatsWithRealClock } from './real-clock-heartbeat';

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

// "Now" = Thursday 5 March 2026, 10:00 IST; the regularized day is Tuesday 3 March.
const NOW = new Date('2026-03-05T04:30:00Z');
const DAY = '2026-03-03';
const IST = (hhmm: string) => `${DAY}T${hhmm}:00+05:30`;

suite('forgotCheckIn approval with a stated check-out (real DB)', () => {
  let rs: { getUri(): string; stop(): Promise<boolean> };
  let RegularizationService: typeof import('@services/RegularizationService').RegularizationService;
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
    await mongoose.connect(rs.getUri(), { dbName: 'genesis-reg-forgot-checkin-test' });
    stampHeartbeatsWithRealClock();
    M = {
      User: (await import('@models/User')).User,
      Employee: (await import('@models/Employee')).Employee,
      CompanySettings: (await import('@models/CompanySettings')).CompanySettings,
      AttendanceDay: (await import('@models/AttendanceDay')).AttendanceDay,
      AttendanceSession: (await import('@models/AttendanceSession')).AttendanceSession,
      Regularization: (await import('@models/Regularization')).Regularization,
      AuditLog: (await import('@models/AuditLog')).AuditLog,
      PayrollRecord: (await import('@models/PayrollRecord')).PayrollRecord,
      Holiday: (await import('@models/Holiday')).Holiday,
    };
    for (const m of Object.values(M)) await m.syncIndexes();
    RegularizationService = (await import('@services/RegularizationService')).RegularizationService;
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
      leaveYearStartMonth: 1,
    } as never);
  });
  afterEach(() => jest.useRealTimers());

  async function seedEmployee() {
    const _id = new mongoose.Types.ObjectId();
    await M.User.collection.insertOne({
      _id, employeeId: `E${_id.toHexString().slice(-6)}`, firstName: 'Test', lastName: 'Employee',
      email: `${_id.toHexString()}@example.invalid`, passwordHash: 'x', role: 'employee', isActive: true,
      requiresPasswordChange: false, monthlySalary: 30000, dateOfJoining: new Date('2025-01-01'),
      leaveBalances: { paidLeave: { currentYear: 10, carriedForward: 0 }, sickLeave: { currentYear: 5, carriedForward: 0 }, casualLeave: { currentYear: 5, carriedForward: 0 } },
    });
    return _id.toHexString();
  }

  async function request(emp: string, input: Record<string, unknown>) {
    const r = await RegularizationService.create({
      employeeId: emp,
      input: { date: DAY, type: 'forgotCheckIn', reason: 'Phone died at the gate - test', ...input } as never,
    }) as { _id: string };
    return String(r._id);
  }

  it('both times stated: the session keeps the check-out and the day is derived from real minutes', async () => {
    const emp = await seedEmployee();
    setClock(NOW);
    const id = await request(emp, { requestedCheckIn: IST('09:00'), requestedCheckOut: IST('18:00') });
    await RegularizationService.approve(id, ADMIN);

    const s = await M.AttendanceSession.findOne({ employeeId: emp, dateString: DAY }).lean();
    expect(s.checkOut?.timestamp?.toISOString()).toBe(new Date(IST('18:00')).toISOString());
    expect(s.durationMinutes).toBe(540);
    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: DAY }).lean();
    expect(day.totalMinutes).toBe(540);
    expect(day.status).toBe('present');
    expect(day.isRegularized).toBe(true);
  });

  it('a short stated session is NOT inflated to present', async () => {
    const emp = await seedEmployee();
    setClock(NOW);
    const id = await request(emp, { requestedCheckIn: IST('09:00'), requestedCheckOut: IST('11:00') });
    await RegularizationService.approve(id, ADMIN);

    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: DAY }).lean();
    expect(day.totalMinutes).toBe(120);
    expect(day.status).toBe('absent'); // 120 min < 270 min half-day threshold
  });

  it('only a check-in stated: unchanged behaviour (no check-out invented, day present)', async () => {
    const emp = await seedEmployee();
    setClock(NOW);
    const id = await request(emp, { requestedCheckIn: IST('09:00') });
    await RegularizationService.approve(id, ADMIN);

    const s = await M.AttendanceSession.findOne({ employeeId: emp, dateString: DAY }).lean();
    expect(s.checkOut).toBeNull();
    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: DAY }).lean();
    expect(day.status).toBe('present');
  });

  // Regression (found on the phone): regularizing work on a weekly-off day
  // recomputed the status from minutes and stored the Sunday as 'absent'.
  it('work regularized on a weekly-off day keeps the weekend status (minutes still recorded)', async () => {
    const emp = await seedEmployee();
    setClock(NOW);
    const SUN = '2026-03-01';
    await M.AttendanceDay.collection.insertOne({
      employeeId: new mongoose.Types.ObjectId(emp), dateString: SUN, date: new Date(`${SUN}T00:00:00Z`), year: 2026, month: 3,
      status: 'weekend', totalMinutes: 0, requiredMinutes: 540, overtimeMinutes: 0,
    });
    const r = await RegularizationService.create({
      employeeId: emp,
      input: { date: SUN, type: 'forgotCheckIn', reason: 'Weekend deployment support - test', requestedCheckIn: `${SUN}T10:00:00+05:30`, requestedCheckOut: `${SUN}T14:00:00+05:30` } as never,
    }) as { _id: string };
    await RegularizationService.approve(String(r._id), ADMIN);

    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: SUN }).lean();
    expect(day.status).toBe('weekend');
    expect(day.totalMinutes).toBe(240);
    expect(day.isRegularized).toBe(true);
  });

  it('a session recorded after the request was made, overlapping it, is refused at approval (REG_008)', async () => {
    const emp = await seedEmployee();
    setClock(NOW);
    // create() already refuses dates with a completed session (REG_004), so the
    // overlap can only appear between request and approval.
    const id = await request(emp, { requestedCheckIn: IST('09:00'), requestedCheckOut: IST('18:00') });
    const dayId = new mongoose.Types.ObjectId();
    await M.AttendanceDay.collection.insertOne({ _id: dayId, employeeId: new mongoose.Types.ObjectId(emp), dateString: DAY, date: new Date(`${DAY}T00:00:00Z`), year: 2026, month: 3, status: 'absent', totalMinutes: 60, requiredMinutes: 540, overtimeMinutes: 0 });
    await M.AttendanceSession.collection.insertOne({
      employeeId: new mongoose.Types.ObjectId(emp), attendanceDayId: dayId, dateString: DAY,
      checkIn: { timestamp: new Date(IST('10:00')), nonce: 'real-ci' }, checkOut: { timestamp: new Date(IST('11:00')), nonce: 'real-co' },
      durationMinutes: 60, isActive: false, closedBySystem: false,
    });

    await expect(RegularizationService.approve(id, ADMIN)).rejects.toMatchObject({ code: 'REG_008' });
    expect((await M.Regularization.findById(id).lean()).status).toBe('pending');
    expect(await M.AttendanceSession.countDocuments({ employeeId: emp })).toBe(1);
  });
});
