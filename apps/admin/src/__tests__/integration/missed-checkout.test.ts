/**
 * 24-hour missed-check-out rule — real database, controlled clock.
 *
 * Isolated in-memory MongoDB replica set (see db-concurrency.test.ts for the
 * safety notes). Only `Date` is faked (jest modern fake timers with every
 * timer API excluded), so the MongoDB driver's own timers keep working while
 * the application sees a controlled "now". No production time-control
 * endpoint exists or is needed.
 *
 * Run: MONGOMS_SYSTEM_BINARY=/path/to/mongod npx jest src/__tests__/integration
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import net from 'net';
import mongoose from 'mongoose';
import { stampHeartbeatsWithRealClock } from './real-clock-heartbeat';
import { createHash } from 'crypto';

const BIN = process.env.MONGOMS_SYSTEM_BINARY;
// Runs when a local mongod binary is supplied, or in CI after the binary was
// pre-downloaded into the mongodb-memory-server cache (RUN_DB_INTEGRATION=1).
const suite = BIN || process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(120_000);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const guard = (globalThis as unknown as { __TEST_NETWORK_GUARD__: { allowLoopbackPort(p: number): void } })
  .__TEST_NETWORK_GUARD__;
const H = 60 * 60 * 1000;
const FP = 'e'.repeat(64);

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

suite('24-hour missed check-out (real DB, controlled clock)', () => {
  let rs: { getUri(): string; stop(): Promise<boolean> };
  let AttendanceService: typeof import('@services/AttendanceService').AttendanceService;
  let reconcile: typeof import('@services/AttendanceService').reconcileMissedCheckouts;
  let RegularizationService: typeof import('@services/RegularizationService').RegularizationService;
  let LeaveService: typeof import('@services/LeaveService').LeaveService;
  let PayrollService: typeof import('@services/PayrollService').PayrollService;
  let M: Record<string, mongoose.Model<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let cronRoute: typeof import('@/app/admin/cron/session-auto-close/route');

  beforeAll(async () => {
    const port = await freePort();
    guard.allowLoopbackPort(port);
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    rs = await MongoMemoryReplSet.create({
      binary: { systemBinary: BIN },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ port, ip: '127.0.0.1' }],
    });
    await mongoose.connect(rs.getUri(), { dbName: 'genesis-missed-checkout-test' });
    stampHeartbeatsWithRealClock();
    M = {
      User: (await import('@models/User')).User,
      Employee: (await import('@models/Employee')).Employee,
      CompanySettings: (await import('@models/CompanySettings')).CompanySettings,
      AttendanceDay: (await import('@models/AttendanceDay')).AttendanceDay,
      AttendanceSession: (await import('@models/AttendanceSession')).AttendanceSession,
      UsedNonce: (await import('@models/UsedNonce')).UsedNonce,
      Regularization: (await import('@models/Regularization')).Regularization,
      Leave: (await import('@models/Leave')).Leave,
      AuditLog: (await import('@models/AuditLog')).AuditLog,
      SystemEvent: (await import('@models/SystemEvent')).SystemEvent,
      Holiday: (await import('@models/Holiday')).Holiday,
      PayrollRecord: (await import('@models/PayrollRecord')).PayrollRecord,
    };
    for (const m of Object.values(M)) await m.syncIndexes();
    const att = await import('@services/AttendanceService');
    AttendanceService = att.AttendanceService;
    reconcile = att.reconcileMissedCheckouts;
    RegularizationService = (await import('@services/RegularizationService')).RegularizationService;
    LeaveService = (await import('@services/LeaveService')).LeaveService;
    PayrollService = (await import('@services/PayrollService')).PayrollService;
    cronRoute = await import('@/app/admin/cron/session-auto-close/route');
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
      lateArrivalGraceMinutes: 15, workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
      geoFence: { isEnabled: true, latitude: 12.9, longitude: 77.6, radiusMeters: 200 },
      gpsAccuracyThresholdMeters: 100, checkinTimestampWindowMinutes: 10, regularizationLookbackDays: 30,
      leaveYearStartMonth: 1, leaveTypes: { paidLeave: { annualAllocation: 12 } },
    } as never);
  });
  afterEach(() => jest.useRealTimers());

  async function seedEmployee() {
    const _id = new mongoose.Types.ObjectId();
    await M.User.collection.insertOne({
      _id, employeeId: `E${_id.toHexString().slice(-6)}`, firstName: 'Test', lastName: 'Employee',
      email: `${_id.toHexString()}@example.invalid`, passwordHash: 'x', role: 'employee', isActive: true,
      requiresPasswordChange: false, monthlySalary: 30000, dateOfJoining: new Date('2025-01-01'),
      registeredDevice: { fingerprintHash: sha(FP), deviceName: 'test', platform: 'android', registeredAt: new Date() },
      leaveBalances: {
        paidLeave: { currentYear: 10, carriedForward: 0 },
        sickLeave: { currentYear: 5, carriedForward: 0 },
        casualLeave: { currentYear: 5, carriedForward: 0 },
      },
    });
    await M.Employee.collection.insertOne({
      _id, userId: _id, employeeCode: `E${_id.toHexString().slice(-6)}`, firstName: 'Test', lastName: 'Employee',
      joiningDate: new Date('2025-01-01'), monthlySalary: 30000, status: 'active', allowOutsideGeofence: false,
    });
    return _id.toHexString();
  }

  let nonceSeq = 0;
  const nonce = () => `550e8400-e29b-41d4-a716-${String(++nonceSeq).padStart(12, '0')}`;
  const checkIn = (emp: string) => AttendanceService.checkIn({
    employeeId: emp, deviceFingerprintHeader: FP, latitude: 12.9, longitude: 77.6, accuracy: 5,
    nonce: nonce(), clientTimestamp: new Date().toISOString(),
  });
  const checkOut = (emp: string) => AttendanceService.checkOut({
    employeeId: emp, deviceFingerprintHeader: FP, latitude: 12.9, longitude: 77.6, accuracy: 5,
    nonce: nonce(), clientTimestamp: new Date().toISOString(),
  });

  // Monday 2026-03-02 09:00 IST
  const T0 = new Date('2026-03-02T03:30:00Z');

  // ── Boundary ────────────────────────────────────────────────────────────────

  it('1 second before 24 h: still checked in, timer data intact, checkout allowed', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);

    setClock(new Date(T0.getTime() + 24 * H - 1000));
    const st = await AttendanceService.getStatus(emp);
    expect(st.isCheckedIn).toBe(true);
    expect(st.currentSession!.checkoutDeadline).toBe(new Date(T0.getTime() + 24 * H).toISOString());
    expect(st.forgotCheckout).toBe(false);

    const out = await checkOut(emp);
    expect(out.durationMinutes).toBe(24 * 60 - 1); // a real (long) punch-out, not fabricated
  });

  it('exactly at 24 h: not checked in, no punch-out, 0 minutes, day absent + unresolved, check-out refused', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);

    setClock(new Date(T0.getTime() + 24 * H));
    const st = await AttendanceService.getStatus(emp);
    expect(st.isCheckedIn).toBe(false);
    expect(st.currentSession).toBeNull();
    expect(st.forgotCheckout).toBe(true);
    expect(st.staleSession).toEqual({ dateString: '2026-03-02', checkInTimestamp: T0.toISOString() });

    const s = await M.AttendanceSession.findOne({ employeeId: emp }).lean();
    expect(s.isActive).toBe(false);
    expect(s.checkOut).toBeNull();                       // no fabricated punch-out
    expect(s.durationMinutes).toBe(0);                   // no fabricated hours
    expect(s.systemCloseReason).toBe('missed-checkout');
    expect(new Date(s.checkIn.timestamp).toISOString()).toBe(T0.toISOString()); // original check-in kept

    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-03-02' }).lean();
    expect(day.status).toBe('absent');
    expect(day.totalMinutes).toBe(0);
    expect(day.hasUnresolvedMissedCheckout).toBe(true);

    await expect(checkOut(emp)).rejects.toMatchObject({ code: 'ATT_005' }); // no open session any more
    expect(await M.AuditLog.countDocuments({ action: 'ATTENDANCE_MISSED_CHECKOUT' })).toBe(1);
  });

  it('check-out request arriving at the deadline (before any sweep) is refused with ATT_011', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 24 * H));
    await expect(checkOut(emp)).rejects.toMatchObject({ code: 'ATT_011' });
    const s = await M.AttendanceSession.findOne({ employeeId: emp }).lean();
    expect(s.checkOut).toBeNull();
    expect(s.systemCloseReason).toBe('missed-checkout');
  });

  it('concurrent check-out + sweep at the deadline: consistent result, no minutes credited', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 24 * H));
    const results = await Promise.allSettled([checkOut(emp), reconcile(), reconcile()]);
    expect(results[0].status).toBe('rejected');
    const s = await M.AttendanceSession.findOne({ employeeId: emp }).lean();
    expect(s.systemCloseReason).toBe('missed-checkout');
    const day = await M.AttendanceDay.findOne({ employeeId: emp }).lean();
    expect(day.totalMinutes).toBe(0);
    expect(await M.AuditLog.countDocuments({ action: 'ATTENDANCE_MISSED_CHECKOUT' })).toBe(1);
  });

  it('concurrent check-out + sweep 1 s BEFORE the deadline: check-out wins, sweep does nothing', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 24 * H - 1000));
    const [out, sweep] = await Promise.all([checkOut(emp), reconcile()]);
    expect(out.durationMinutes).toBe(24 * 60 - 1);
    expect(sweep.expired).toBe(0);
  });

  // ── Cron: delayed, repeated, concurrent; restart ────────────────────────────

  it('delayed cron: reads apply the rule on time; a cron days later and repeated runs change nothing', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);

    // Admin opens the attendance list 25 h later — no cron has run.
    setClock(new Date(T0.getTime() + 25 * H));
    const list = await AttendanceService.adminList({ page: 1, limit: 10 });
    const row = list.data.find((r) => r.dateString === '2026-03-02')!;
    expect(row.status).toBe('absent');
    expect(row.checkOut).toBeNull();
    expect(row.missedCheckout).toBe(true);
    expect(row.hasUnresolvedMissedCheckout).toBe(true);

    // Cron finally runs 3 days late, twice, and concurrently.
    setClock(new Date(T0.getTime() + 72 * H));
    const req = () => new (require('next/server').NextRequest)('http://localhost/admin/cron/session-auto-close', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const [a, b] = await Promise.all([cronRoute.GET(req()), cronRoute.GET(req())]);
    const ja = await a.json(); const jb = await b.json();
    expect(ja.sessionsExpired + jb.sessionsExpired).toBe(0);
    expect(await M.AuditLog.countDocuments({ action: 'ATTENDANCE_MISSED_CHECKOUT' })).toBe(1);
  });

  it('cron alone (no reads) expires an overdue session exactly once even when run concurrently', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 30 * H));
    const [x, y, z] = await Promise.all([reconcile(), reconcile(), AttendanceService.reconcileMissedCheckouts()]);
    expect(x.expired + y.expired + z.expired).toBe(1);
  });

  // ── Returning after the deadline / new day ─────────────────────────────────

  it('next morning BEFORE 24 h: cannot start a new session (ATT_003) — the open one must be checked out', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 23 * H)); // Tue 08:00 IST
    await expect(checkIn(emp)).rejects.toMatchObject({ code: 'ATT_003' });
  });

  it('returning AFTER 24 h: new check-in works, new day independent, old day stays absent', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 24 * H + 30 * 60_000)); // Tue 09:30 IST
    const ci = await checkIn(emp);
    expect(ci.dateString).toBe('2026-03-03');
    const st = await AttendanceService.getStatus(emp);
    expect(st.isCheckedIn).toBe(true);
    expect(st.forgotCheckout).toBe(true); // Monday still needs resolving
    expect(st.unresolvedMissedCheckoutDates).toEqual(['2026-03-02']);
    const mon = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-03-02' }).lean();
    expect(mon.status).toBe('absent');
  });

  it('history shows the missed session with no punch-out and the day absent (employee view)', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 26 * H));
    const h = await AttendanceService.getHistory(emp, { startDate: '2026-03-02', endDate: '2026-03-02', page: 1, limit: 10 });
    expect(h.data[0].status).toBe('absent');
    expect(h.data[0].hasUnresolvedMissedCheckout).toBe(true);
    expect(h.data[0].sessions[0]).toMatchObject({ checkOutTimestamp: null, durationMinutes: 0, missedCheckout: true, isActive: false });
  });

  // ── Resolution: regularization ──────────────────────────────────────────────

  it('regularization (forgotCheckOut) with the real check-out time resolves the day; nothing is invented', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 30 * H));
    await AttendanceService.getStatus(emp); // triggers expiry

    const reg = await RegularizationService.create({
      employeeId: emp,
      input: { date: '2026-03-02', type: 'forgotCheckOut', requestedCheckIn: T0.toISOString(),
        requestedCheckOut: '2026-03-02T12:30:00.000Z', reason: 'Forgot to check out at 18:00' },
    });
    const admin = new mongoose.Types.ObjectId().toHexString();
    await RegularizationService.approve(reg._id, admin);

    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-03-02' }).lean();
    expect(day.hasUnresolvedMissedCheckout).toBe(false);
    expect(day.isRegularized).toBe(true);
    expect(day.totalMinutes).toBe(540); // exactly the approved 09:00–18:00
    expect(day.status).toBe('present');
    const s = await M.AttendanceSession.findOne({ employeeId: emp }).lean();
    expect(new Date(s.checkIn.timestamp).toISOString()).toBe(T0.toISOString());
    expect(s.systemCloseReason).toBe('admin-force-close'); // correction is attributed, not a device punch
    const st = await AttendanceService.getStatus(emp);
    expect(st.forgotCheckout).toBe(false);
  });

  it('regularization approval refuses a check-out more than 24 h after check-in (REG_007)', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 48 * H));
    await AttendanceService.getStatus(emp);
    const reg = await RegularizationService.create({
      employeeId: emp,
      input: { date: '2026-03-02', type: 'forgotCheckOut', requestedCheckIn: T0.toISOString(),
        requestedCheckOut: '2026-03-03T12:30:00.000Z', reason: 'Claiming next-day check-out' },
    });
    await expect(RegularizationService.approve(reg._id, new mongoose.Types.ObjectId().toHexString()))
      .rejects.toMatchObject({ code: 'REG_007' });
    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-03-02' }).lean();
    expect(day.hasUnresolvedMissedCheckout).toBe(true); // transaction rolled back
  });

  // ── Resolution: leave ──────────────────────────────────────────────────────

  it('back-dated leave is accepted ONLY for an unresolved missed-check-out day, and approval resolves it', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 49 * H)); // Wed
    await AttendanceService.getStatus(emp);

    // An ordinary past day (Tue) is still refused.
    await expect(LeaveService.apply({ employeeId: emp, leaveType: 'paidLeave', startDate: '2026-03-03', endDate: '2026-03-03', duration: 'full', reason: 'x' } as never))
      .rejects.toMatchObject({ code: 'GEN_001' });

    const leave = await LeaveService.apply({ employeeId: emp, leaveType: 'paidLeave', startDate: '2026-03-02', endDate: '2026-03-02', duration: 'full', reason: 'Was on leave' } as never);
    await LeaveService.approve((leave as { id: string }).id, new mongoose.Types.ObjectId().toHexString());

    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-03-02' }).lean();
    expect(day.status).toBe('leave');
    expect(day.hasUnresolvedMissedCheckout).toBe(false);
    expect(day.missedCheckoutSessionId).toBeDefined(); // audit link kept
  });

  // ── Calendar boundaries ────────────────────────────────────────────────────

  it('year boundary: check-in 31 Dec 23:30 IST, check-out 1 Jan 08:00 IST belongs to 31 Dec', async () => {
    const emp = await seedEmployee();
    const ny = new Date('2026-12-31T18:00:00Z'); // 23:30 IST
    setClock(ny);
    const ci = await checkIn(emp);
    expect(ci.dateString).toBe('2026-12-31');
    setClock(new Date(ny.getTime() + 8.5 * H)); // 08:00 IST 1 Jan 2027
    const out = await checkOut(emp);
    expect(out.day.dateString).toBe('2026-12-31');
    expect(out.durationMinutes).toBe(510);
  });

  it('year boundary missed check-out: deadline is 1 Jan 23:30 IST and the 31 Dec day is marked absent', async () => {
    const emp = await seedEmployee();
    const ny = new Date('2026-12-31T18:00:00Z');
    setClock(ny);
    await checkIn(emp);
    setClock(new Date(ny.getTime() + 24 * H));
    await AttendanceService.getStatus(emp);
    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-12-31' }).lean();
    expect(day.status).toBe('absent');
    expect(day.hasUnresolvedMissedCheckout).toBe(true);
  });

  // ── Payroll interaction ────────────────────────────────────────────────────

  it('payroll compute applies the rule first: an overdue open session never counts as work time', async () => {
    const emp = await seedEmployee();
    setClock(T0);
    await checkIn(emp);
    setClock(new Date(T0.getTime() + 40 * H));
    await PayrollService.compute({ yearMonth: '2026-03', employeeId: emp, actorId: new mongoose.Types.ObjectId().toHexString() }).catch(() => undefined);
    const s = await M.AttendanceSession.findOne({ employeeId: emp }).lean();
    expect(s.systemCloseReason).toBe('missed-checkout');
    const day = await M.AttendanceDay.findOne({ employeeId: emp, dateString: '2026-03-02' }).lean();
    expect(day.totalMinutes).toBe(0);
  });
});
