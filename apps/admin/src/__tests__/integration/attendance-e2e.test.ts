/**
 * End-to-end attendance through the real ROUTE HANDLERS and a real database
 * (isolated in-memory replica set). Exercises authentication, device binding,
 * validation, business rules, persisted state and the JSON contracts the
 * mobile app / admin portal parse. Only `Date` is faked (controlled clock).
 *
 * Run: MONGOMS_SYSTEM_BINARY=/path/to/mongod npx jest src/__tests__/integration
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import net from 'net';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

const BIN = process.env.MONGOMS_SYSTEM_BINARY;
// Runs when a local mongod binary is supplied, or in CI after the binary was
// pre-downloaded into the mongodb-memory-server cache (RUN_DB_INTEGRATION=1).
const suite = BIN || process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(120_000);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const guard = (globalThis as unknown as { __TEST_NETWORK_GUARD__: { allowLoopbackPort(p: number): void } }).__TEST_NETWORK_GUARD__;
const H = 3_600_000;
const FP = 'c'.repeat(64);
const OTHER_FP = 'd'.repeat(64);
const BASE = 'http://localhost:3000';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => resolve(port)); });
  });
}
function setClock(d: Date) {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  jest.setSystemTime(d);
}
/** IST wall-clock → UTC Date */
const ist = (s: string) => new Date(new Date(`${s}:00Z`).getTime() - 5.5 * H);

suite('attendance end-to-end (routes + real DB)', () => {
  let rs: { getUri(): string; stop(): Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let M: Record<string, mongoose.Model<any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let R: Record<string, any>;
  let resetLimits: () => void;

  beforeAll(async () => {
    const port = await freePort();
    guard.allowLoopbackPort(port);
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    rs = await MongoMemoryReplSet.create({ binary: { systemBinary: BIN }, replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ port, ip: '127.0.0.1' }] });
    await mongoose.connect(rs.getUri(), { dbName: 'genesis-e2e-test' });
    M = {
      User: (await import('@models/User')).User,
      Employee: (await import('@models/Employee')).Employee,
      CompanySettings: (await import('@models/CompanySettings')).CompanySettings,
      AttendanceDay: (await import('@models/AttendanceDay')).AttendanceDay,
      AttendanceSession: (await import('@models/AttendanceSession')).AttendanceSession,
      UsedNonce: (await import('@models/UsedNonce')).UsedNonce,
      Holiday: (await import('@models/Holiday')).Holiday,
      DeviceSession: (await import('@models/DeviceSession')).DeviceSession,
    };
    for (const m of Object.values(M)) await m.syncIndexes();
    R = {
      login: await import('@/app/api/v1/auth/login/route'),
      checkin: await import('@/app/api/v1/attendance/checkin/route'),
      checkout: await import('@/app/api/v1/attendance/checkout/route'),
      status: await import('@/app/api/v1/attendance/status/route'),
      history: await import('@/app/api/v1/attendance/history/route'),
      adminList: await import('@/app/api/v1/attendance/route'),
      settings: await import('@/app/api/v1/settings/route'),
    };
    resetLimits = (await import('@mw/rateLimiter')).__resetMemoryRateLimits;
  });
  afterAll(async () => { jest.useRealTimers(); await mongoose.disconnect(); await rs?.stop(); });

  const SETTINGS = {
    _id: 'company-settings', timezone: 'Asia/Kolkata', workStartTime: '09:00', workEndTime: '18:00',
    requiredDailyMinutes: 540, halfDayThresholdMinutes: 270, halfDayLateCheckInTime: '13:00',
    lateArrivalGraceMinutes: 15, workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    geoFence: { isEnabled: true, latitude: 12.9, longitude: 77.6, radiusMeters: 200 },
    gpsAccuracyThresholdMeters: 100, checkinTimestampWindowMinutes: 10, regularizationLookbackDays: 30,
    attendanceValidationMode: 'geofence', allowedOfficeIps: [] as string[],
  };
  beforeEach(async () => {
    jest.useRealTimers();
    resetLimits();
    delete process.env.VERCEL;
    for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
    await M.CompanySettings.collection.insertOne({ ...SETTINGS } as never);
  });
  afterEach(() => { jest.useRealTimers(); delete process.env.VERCEL; });

  async function seed(opts: { role?: string; override?: boolean; device?: boolean } = {}) {
    const _id = new mongoose.Types.ObjectId();
    const email = `${_id.toHexString()}@example.invalid`;
    await M.User.collection.insertOne({
      _id, employeeId: `E${_id.toHexString().slice(-6)}`, firstName: 'Asha', lastName: 'Test', email,
      passwordHash: await bcrypt.hash('Passw0rd!', 4), role: opts.role ?? 'employee', isActive: true,
      requiresPasswordChange: false, monthlySalary: 30000, dateOfJoining: new Date('2025-01-01'), department: 'Ops',
      registeredDevice: opts.device === false ? null : { fingerprintHash: sha(FP), deviceName: 't', platform: 'android', registeredAt: new Date() },
      leaveBalances: {},
    });
    await M.Employee.collection.insertOne({ _id, userId: _id, employeeCode: `E${_id.toHexString().slice(-6)}`, firstName: 'Asha', lastName: 'Test',
      joiningDate: new Date('2025-01-01'), monthlySalary: 30000, status: 'active', allowOutsideGeofence: opts.override === true });
    return { id: _id.toHexString(), email };
  }
  const token = (id: string, role = 'employee') => new SignJWT({ userId: id, role, requiresPasswordChange: false })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
  let n = 0;
  const nonce = () => `550e8400-e29b-41d4-a716-${String(++n).padStart(12, '0')}`;
  async function call(route: string, method: string, opts: { id?: string; role?: string; fp?: string | null; body?: unknown; query?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.id) headers.authorization = `Bearer ${await token(opts.id, opts.role)}`;
    if (opts.fp !== null) headers['x-device-fingerprint'] = opts.fp ?? FP;
    const req = new NextRequest(`${BASE}/api/v1/x${opts.query ?? ''}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const res = await R[route][method](req);
    return { status: res.status as number, json: await res.json() };
  }
  const ci = (id: string, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
    call('checkin', 'POST', { id, body: { latitude: 12.9, longitude: 77.6, accuracy: 8, nonce: nonce(), timestamp: new Date().toISOString(), ...extra }, ...opts });
  const co = (id: string, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
    call('checkout', 'POST', { id, body: { latitude: 12.9, longitude: 77.6, accuracy: 8, nonce: nonce(), timestamp: new Date().toISOString(), ...extra }, ...opts });

  // ── Login & device ─────────────────────────────────────────────────────────

  it('login: registered device succeeds; wrong / missing fingerprint and wrong password fail', async () => {
    const e = await seed();
    const ok = await call('login', 'POST', { fp: null, body: { email: e.email, password: 'Passw0rd!', deviceFingerprint: FP } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.accessToken).toEqual(expect.any(String));
    expect(await M.DeviceSession.countDocuments()).toBe(1);
    expect((await call('login', 'POST', { fp: null, body: { email: e.email, password: 'Passw0rd!', deviceFingerprint: OTHER_FP } })).json.error.code).toBe('AUTH_005');
    expect((await call('login', 'POST', { fp: null, body: { email: e.email, password: 'Passw0rd!' } })).json.error.code).toBe('AUTH_005');
    expect((await call('login', 'POST', { fp: null, body: { email: e.email, password: 'wrong-pass', deviceFingerprint: FP } })).json.error.code).toBe('AUTH_001');
  });

  it('check-in rejects missing and unregistered device fingerprints', async () => {
    const e = await seed();
    setClock(ist('2026-03-02T09:00'));
    expect((await ci(e.id, {}, { fp: null })).json.error.code).toBe('AUTH_004');
    expect((await ci(e.id, {}, { fp: OTHER_FP })).json.error.code).toBe('AUTH_005');
    expect(await M.AttendanceSession.countDocuments()).toBe(0);
  });

  // ── Full day through the API; consistent web + mobile views ─────────────────

  it('check-in → status/timer → checkout → history → admin list agree (present, company timezone)', async () => {
    const e = await seed();
    const admin = await seed({ role: 'admin', device: false });
    setClock(ist('2026-03-02T09:05'));
    const a = await ci(e.id);
    expect(a.status).toBe(200);
    expect(a.json.data).toMatchObject({ status: 'checked-in', dateString: '2026-03-02', flags: { isLateArrival: false } });

    setClock(ist('2026-03-02T11:05'));
    const st = await call('status', 'GET', { id: e.id });
    expect(st.json.data).toMatchObject({ isCheckedIn: true, forgotCheckout: false, currentSession: { elapsedMinutes: 120 } });
    expect(st.json.data.currentSession.checkoutDeadline).toBe(ist('2026-03-03T09:05').toISOString());

    setClock(ist('2026-03-02T18:10'));
    const out = await co(e.id);
    expect(out.status).toBe(200);
    expect(out.json.data).toMatchObject({ durationMinutes: 545, day: { status: 'present', totalMinutes: 545, overtimeMinutes: 5 } });

    const hist = await call('history', 'GET', { id: e.id, query: '?startDate=2026-03-02&endDate=2026-03-02' });
    expect(hist.json.data[0]).toMatchObject({ status: 'present', totalMinutes: 545, hasUnresolvedMissedCheckout: false });
    expect(hist.json.data[0].sessions[0]).toMatchObject({ isActive: false, missedCheckout: false, durationMinutes: 545 });

    const list = await call('adminList', 'GET', { id: admin.id, role: 'admin', fp: null, query: '?date=2026-03-02' });
    expect(list.status).toBe(200);
    const row = list.json.data.find((r: { dateString: string }) => r.dateString === '2026-03-02');
    expect(row).toMatchObject({ status: 'present', checkIn: '09:05', checkOut: '18:10', missedCheckout: false });
  });

  it('employee cannot open the admin attendance list (403)', async () => {
    const e = await seed();
    expect((await call('adminList', 'GET', { id: e.id })).status).toBe(403);
  });

  // ── Duplicates / retries / lost responses ─────────────────────────────────

  it('double-tap check-in (two different nonces at once): exactly one session', async () => {
    const e = await seed();
    setClock(ist('2026-03-02T09:00'));
    const [x, y] = await Promise.all([ci(e.id), ci(e.id)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(await M.AttendanceSession.countDocuments({ isActive: true })).toBe(1);
  });

  it('lost response + retry with the same nonce is rejected as a replay; status shows the real state', async () => {
    const e = await seed();
    setClock(ist('2026-03-02T09:00'));
    const body = { latitude: 12.9, longitude: 77.6, accuracy: 8, nonce: nonce(), timestamp: new Date().toISOString() };
    expect((await call('checkin', 'POST', { id: e.id, body })).status).toBe(200);
    const retry = await call('checkin', 'POST', { id: e.id, body });
    expect(retry.json.error.code).toBe('ATT_004');
    expect((await call('status', 'GET', { id: e.id })).json.data.isCheckedIn).toBe(true);
  });

  it('multiple sessions in one day accumulate (check out, check in again)', async () => {
    const e = await seed();
    setClock(ist('2026-03-02T09:00')); await ci(e.id);
    setClock(ist('2026-03-02T13:00')); await co(e.id);
    setClock(ist('2026-03-02T14:00')); await ci(e.id);
    setClock(ist('2026-03-02T19:00'));
    const out = await co(e.id);
    expect(out.json.data.day).toMatchObject({ totalMinutes: 540, status: 'present' });
  });

  // ── GPS / location policy ──────────────────────────────────────────────────

  it('GPS: outside fence, poor accuracy, missing at checkout', async () => {
    const e = await seed();
    setClock(ist('2026-03-02T09:00'));
    expect((await ci(e.id, { latitude: 13.5, longitude: 78.5 })).json.error.code).toBe('ATT_001');
    expect((await ci(e.id, { accuracy: 500 })).json.error.code).toBe('ATT_002');
    expect((await ci(e.id)).status).toBe(200);
    setClock(ist('2026-03-02T18:00'));
    const noGps = await call('checkout', 'POST', { id: e.id, body: { nonce: nonce(), timestamp: new Date().toISOString() } });
    expect(noGps.status).toBe(422);
    expect(noGps.json.error.code).toBe('ATT_010');
    expect((await call('status', 'GET', { id: e.id })).json.data.isCheckedIn).toBe(true); // still open
  });

  it('remote / approved-override employee: check-in far away and check-out without GPS (recorded unverified)', async () => {
    const e = await seed({ override: true });
    setClock(ist('2026-03-02T09:00'));
    const a = await ci(e.id, { latitude: 19.07, longitude: 72.87 });
    expect(a.status).toBe(200);
    setClock(ist('2026-03-02T18:00'));
    const out = await call('checkout', 'POST', { id: e.id, body: { nonce: nonce(), timestamp: new Date().toISOString() } });
    expect(out.status).toBe(200);
    const s = await M.AttendanceSession.findOne({ employeeId: e.id }).lean();
    expect(s.isRemote).toBe(true);
    expect(s.checkOut.isWithinGeoFence).toBe(false);
    expect(s.checkOut.locationProvided).toBe(false);
  });

  it('office-IP mode: approved network allowed (Vercel header), other network ATT_009, spoofed XFF ignored', async () => {
    await M.CompanySettings.updateOne({ _id: 'company-settings' }, { $set: { attendanceValidationMode: 'officeIp', allowedOfficeIps: ['203.0.113.10'] } });
    const e = await seed();
    setClock(ist('2026-03-02T09:00'));
    // Not on Vercel and no trusted proxy: forwarded headers ignored → denied.
    expect((await ci(e.id, {}, { headers: { 'x-forwarded-for': '203.0.113.10' } })).json.error.code).toBe('ATT_009');
    process.env.VERCEL = '1';
    expect((await ci(e.id, {}, { headers: { 'x-vercel-forwarded-for': '198.51.100.7' } })).json.error.code).toBe('ATT_009');
    const ok = await ci(e.id, {}, { headers: { 'x-vercel-forwarded-for': '203.0.113.10', 'x-forwarded-for': '203.0.113.10' } });
    expect(ok.status).toBe(200);
  });

  // ── Day outcomes (existing documented rules) ──────────────────────────────

  async function day(id: string, inAt: string, outAt: string) {
    setClock(ist(inAt)); const a = await ci(id); expect(a.status).toBe(200);
    setClock(ist(outAt)); const b = await co(id); expect(b.status).toBe(200);
    return { checkin: a.json.data, day: b.json.data.day };
  }

  it('late arrival beyond grace is flagged; full hours still present', async () => {
    const e = await seed();
    const r = await day(e.id, '2026-03-02T09:30', '2026-03-02T18:30');
    expect(r.checkin.flags).toMatchObject({ isLateArrival: true, lateByMinutes: 15 });
    expect(r.day.status).toBe('present');
  });

  it('half-day by hours (270–539 min) and absent below the threshold', async () => {
    const a = await seed(); const b = await seed();
    expect((await day(a.id, '2026-03-02T09:00', '2026-03-02T13:30')).day.status).toBe('half-day');
    expect((await day(b.id, '2026-03-02T09:00', '2026-03-02T12:00')).day.status).toBe('absent');
  });

  it('check-in at/after the half-day cut-off caps the day at half-day even with full hours', async () => {
    const e = await seed();
    const r = await day(e.id, '2026-03-02T13:00', '2026-03-02T23:00');
    expect(r.checkin.flags.isHalfDayCapped).toBe(true);
    expect(r.day.status).toBe('half-day');
  });

  it('holiday and weekly-off keep their status even when the employee works', async () => {
    await M.Holiday.collection.insertOne({ dateString: '2026-03-03', name: 'Test Holiday', date: new Date('2026-03-03') } as never);
    const a = await seed(); const b = await seed();
    expect((await day(a.id, '2026-03-03T09:00', '2026-03-03T18:00')).day.status).toBe('holiday');
    expect((await day(b.id, '2026-03-08T09:00', '2026-03-08T18:00')).day.status).toBe('weekend'); // Sunday
  });

  it('timezone: a 00:30 IST check-in belongs to that IST date (not the UTC date)', async () => {
    const e = await seed();
    setClock(ist('2026-03-03T00:30')); // 2026-03-02T19:00Z
    const a = await ci(e.id);
    expect(a.json.data.dateString).toBe('2026-03-03');
  });

  it('month boundary: 31 Mar 22:00 → 1 Apr 06:00 IST stays on 31 Mar', async () => {
    const e = await seed();
    const r = await day(e.id, '2026-03-31T22:00', '2026-04-01T06:00');
    expect(r.day.dateString).toBe('2026-03-31');
    expect(r.day.totalMinutes).toBe(480);
  });

  // ── Missed check-out through the API (what the mobile app sees) ────────────

  it('missed check-out via the API: status timer data reset, no checkout, history absent, ATT_011 on late checkout', async () => {
    const e = await seed();
    setClock(ist('2026-03-02T09:00')); await ci(e.id);
    setClock(ist('2026-03-03T09:00')); // exactly 24 h
    const late = await co(e.id);
    expect(late.json.error.code).toBe('ATT_011');
    const st = (await call('status', 'GET', { id: e.id })).json.data;
    expect(st).toMatchObject({ isCheckedIn: false, currentSession: null, forgotCheckout: true, staleSession: { dateString: '2026-03-02' } });
    const hist = (await call('history', 'GET', { id: e.id, query: '?startDate=2026-03-02&endDate=2026-03-02' })).json.data[0];
    expect(hist).toMatchObject({ status: 'absent', hasUnresolvedMissedCheckout: true });
    expect(hist.sessions[0]).toMatchObject({ checkOutTimestamp: null, durationMinutes: 0, missedCheckout: true });
    // New day can start immediately.
    expect((await ci(e.id)).status).toBe(200);
  });
  // ── Admin settings: validated, persisted, used by attendance ──────────────

  it('settings: invalid values rejected; grace + working days changes take effect for the next check-in', async () => {
    const admin = await seed({ role: 'admin', device: false });
    const e = await seed();
    const patch = (body: unknown) => call('settings', 'PATCH', { id: admin.id, role: 'admin', fp: null, body });
    expect((await patch({ shift: { startTime: '25:00' } })).status).toBe(400);
    expect((await patch({ company: { timezone: 'Mars/Olympus_Mons' } })).status).toBe(400);
    expect((await patch({ workingDays: [] })).status).toBe(400);
    expect((await patch({ attendanceValidation: { mode: 'officeIp', allowedOfficeIps: ['not-an-ip'] } })).status).toBe(400);
    // employee may not change settings
    expect((await call('settings', 'PATCH', { id: e.id, body: { shift: { gracePeriodMinutes: 60 } } })).status).toBe(403);

    // 09:30 is late with 15-min grace …
    expect((await patch({ shift: { gracePeriodMinutes: 45 } })).status).toBe(200);
    const persisted = await M.CompanySettings.findById('company-settings').lean();
    expect(persisted.lateArrivalGraceMinutes).toBe(45);
    setClock(ist('2026-03-02T09:30'));
    const a = await ci(e.id);
    expect(a.json.data.flags.isLateArrival).toBe(false); // … but not with 45-min grace

    // Saturday becomes a working day → no longer 'weekend'
    expect((await patch({ workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] })).status).toBe(200);
    const b = await seed();
    setClock(ist('2026-03-07T09:00')); await ci(b.id);
    setClock(ist('2026-03-07T18:00'));
    expect((await co(b.id)).json.data.day.status).toBe('present');
  });
});
