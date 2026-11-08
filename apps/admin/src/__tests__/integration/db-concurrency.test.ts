/**
 * Real-database integration tests: transactions, unique indexes and races.
 *
 * Runs ONLY against an isolated, throw-away in-memory MongoDB replica set
 * started by this file (mongodb-memory-server) on a loopback port that the
 * network guard explicitly allows. It never uses MONGODB_URI.
 *
 * Requires a locally available, checksum-verified MongoDB binary:
 *   MONGOMS_SYSTEM_BINARY=/path/to/mongod npx jest src/__tests__/integration
 * Without it the suite is reported as SKIPPED (blocked), never silently passed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import net from 'net';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';

const BIN = process.env.MONGOMS_SYSTEM_BINARY;
// Runs when a local mongod binary is supplied, or in CI after the binary was
// pre-downloaded into the mongodb-memory-server cache (RUN_DB_INTEGRATION=1).
const suite = BIN || process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(120_000);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
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

suite('integration (isolated in-memory replica set)', () => {
  // Loaded lazily so the module graph is untouched when the suite is skipped.
  let rs: { getUri(): string; stop(): Promise<boolean> };
  let M: {
    User: typeof import('@models/User').User;
    DeviceSession: typeof import('@models/DeviceSession').DeviceSession;
    PasswordResetToken: typeof import('@models/PasswordResetToken').PasswordResetToken;
    AttendanceSession: typeof import('@models/AttendanceSession').AttendanceSession;
    AttendanceDay: typeof import('@models/AttendanceDay').AttendanceDay;
    UsedNonce: typeof import('@models/UsedNonce').UsedNonce;
    Regularization: typeof import('@models/Regularization').Regularization;
    CompanySettings: typeof import('@models/CompanySettings').CompanySettings;
  };
  let AuthService: typeof import('@services/AuthService').AuthService;
  let AttendanceService: typeof import('@services/AttendanceService').AttendanceService;
  let RegularizationService: typeof import('@services/RegularizationService').RegularizationService;

  beforeAll(async () => {
    const port = await freePort();
    guard.allowLoopbackPort(port);
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    rs = await MongoMemoryReplSet.create({
      binary: { systemBinary: BIN },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ port, ip: '127.0.0.1' }],
    });
    await mongoose.connect(rs.getUri(), { dbName: 'genesis-integration-test' });

    M = {
      User: (await import('@models/User')).User,
      DeviceSession: (await import('@models/DeviceSession')).DeviceSession,
      PasswordResetToken: (await import('@models/PasswordResetToken')).PasswordResetToken,
      AttendanceSession: (await import('@models/AttendanceSession')).AttendanceSession,
      AttendanceDay: (await import('@models/AttendanceDay')).AttendanceDay,
      UsedNonce: (await import('@models/UsedNonce')).UsedNonce,
      Regularization: (await import('@models/Regularization')).Regularization,
      CompanySettings: (await import('@models/CompanySettings')).CompanySettings,
    };
    for (const model of Object.values(M)) await model.syncIndexes();
    AuthService = (await import('@services/AuthService')).AuthService;
    AttendanceService = (await import('@services/AttendanceService')).AttendanceService;
    RegularizationService = (await import('@services/RegularizationService')).RegularizationService;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await rs?.stop();
  });

  beforeEach(async () => {
    for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  });

  const FP = 'f'.repeat(64);
  async function seedUser(overrides: Record<string, unknown> = {}) {
    const _id = new mongoose.Types.ObjectId();
    await M.User.collection.insertOne({
      _id, employeeId: `E${_id.toHexString().slice(-6)}`, firstName: 'Test', lastName: 'User',
      email: `${_id.toHexString()}@example.invalid`, passwordHash: await bcrypt.hash('OldPass123', 4),
      role: 'employee', isActive: true, requiresPasswordChange: false,
      registeredDevice: { fingerprintHash: sha(FP), deviceName: 'test', platform: 'android', registeredAt: new Date() },
      leaveBalances: {}, dateOfJoining: new Date('2025-01-01'), monthlySalary: 1, ...overrides,
    });
    return _id;
  }
  async function seedSettings(overrides: Record<string, unknown> = {}) {
    await M.CompanySettings.collection.insertOne({
      _id: 'company-settings', timezone: 'Asia/Kolkata', workStartTime: '09:00', workEndTime: '18:00',
      requiredDailyMinutes: 540, halfDayThresholdMinutes: 270, halfDayLateCheckInTime: '13:00',
      lateArrivalGraceMinutes: 15, workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      geoFence: { isEnabled: true, latitude: 12.9, longitude: 77.6, radiusMeters: 200 },
      gpsAccuracyThresholdMeters: 100, checkinTimestampWindowMinutes: 60, regularizationLookbackDays: 30,
      ...overrides,
    } as never);
  }

  // ── Unique indexes ────────────────────────────────────────────────────────

  it('partial unique index: at most one ACTIVE session per employee', async () => {
    const emp = new mongoose.Types.ObjectId();
    const base = { employeeId: emp, attendanceDayId: new mongoose.Types.ObjectId(), dateString: '2026-03-02', checkIn: {} };
    await M.AttendanceSession.collection.insertOne({ ...base, isActive: true });
    await expect(M.AttendanceSession.collection.insertOne({ ...base, isActive: true })).rejects.toMatchObject({ code: 11000 });
    await expect(M.AttendanceSession.collection.insertOne({ ...base, isActive: false })).resolves.toBeDefined();
  });

  it('nonce replay is rejected by the unique index', async () => {
    const emp = new mongoose.Types.ObjectId();
    await M.UsedNonce.create({ nonce: 'n-1', employeeId: emp, action: 'checkin' });
    await expect(M.UsedNonce.create({ nonce: 'n-1', employeeId: emp, action: 'checkin' })).rejects.toMatchObject({ code: 11000 });
  });

  // ── Password reset token: atomic single use ───────────────────────────────

  it('two concurrent confirmations of one reset token: exactly one succeeds', async () => {
    const userId = await seedUser();
    const user = await M.User.findById(userId).lean();
    const raw = randomBytes(32).toString('hex');
    await M.PasswordResetToken.create({
      userId, email: user!.email, tokenHash: sha(raw), expiresAt: new Date(Date.now() + 600_000), ipAddress: 'x',
    });
    await M.DeviceSession.collection.insertOne({
      employeeId: userId, refreshTokenHash: 'h', isRevoked: false, expiresAt: new Date(Date.now() + 1e9),
      absoluteExpiresAt: new Date(Date.now() + 1e9), deviceInfo: 'x', platform: 'web', ipAddressHash: 'x', lastUsedAt: new Date(),
    });

    const results = await Promise.allSettled([
      AuthService.confirmPasswordReset(user!.email, raw, 'NewPass111'),
      AuthService.confirmPasswordReset(user!.email, raw, 'NewPass222'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await M.DeviceSession.countDocuments({ employeeId: userId, isRevoked: false })).toBe(0);
    // Re-using the consumed link afterwards fails too.
    await expect(AuthService.confirmPasswordReset(user!.email, raw, 'NewPass333')).rejects.toMatchObject({ code: 'AUTH_008' });
  });

  it('an older reset link is dead once a newer one is requested', async () => {
    const userId = await seedUser();
    const user = await M.User.findById(userId).lean();
    const oldRaw = randomBytes(32).toString('hex');
    await M.PasswordResetToken.create({ userId, email: user!.email, tokenHash: sha(oldRaw), expiresAt: new Date(Date.now() + 600_000), ipAddress: 'x' });
    await AuthService.requestPasswordReset(user!.email, '203.0.113.1');
    await expect(AuthService.confirmPasswordReset(user!.email, oldRaw, 'NewPass111')).rejects.toMatchObject({ code: 'AUTH_008' });
  });

  // ── Refresh rotation under concurrency ────────────────────────────────────

  it('two concurrent refreshes with the same token both succeed and agree on the new token', async () => {
    const userId = await seedUser({ role: 'admin' });
    const raw = randomBytes(32).toString('hex');
    const { insertedId } = await M.DeviceSession.collection.insertOne({
      employeeId: userId, refreshTokenHash: sha(raw), isRevoked: false,
      expiresAt: new Date(Date.now() + 1e9), absoluteExpiresAt: new Date(Date.now() + 2e9),
      deviceInfo: 'x', platform: 'web', ipAddressHash: 'x', lastUsedAt: new Date(),
    });
    const sid = insertedId.toHexString();
    const [a, b] = await Promise.all([AuthService.refresh(raw, sid), AuthService.refresh(raw, sid)]);
    expect(a.refreshToken).toBe(b.refreshToken);
    expect(a.refreshToken).not.toBe(raw);
    const stored = await M.DeviceSession.findById(sid).lean();
    expect(stored!.refreshTokenHash).toBe(sha(a.refreshToken));
    expect(stored!.isRevoked).toBe(false);
  });

  // ── Refresh-token guarantees (and limits), stated precisely ──────────────

  async function seedSession(userId: mongoose.Types.ObjectId, raw: string) {
    const { insertedId } = await M.DeviceSession.collection.insertOne({
      employeeId: userId, refreshTokenHash: sha(raw), isRevoked: false,
      expiresAt: new Date(Date.now() + 1e9), absoluteExpiresAt: new Date(Date.now() + 2e9),
      deviceInfo: 'x', platform: 'android', ipAddressHash: 'x', lastUsedAt: new Date(),
    });
    return insertedId.toHexString();
  }

  it('LIMIT: within the 1 h grace, a thief and the real client who both hold the same token both obtain the current token (not detected)', async () => {
    const userId = await seedUser({ role: 'admin' });
    const raw = randomBytes(32).toString('hex');
    const sid = await seedSession(userId, raw);
    const thief = await AuthService.refresh(raw, sid);        // thief uses it first → rotates
    const victim = await AuthService.refresh(raw, sid);       // victim retries old token within grace
    expect(victim.refreshToken).toBe(thief.refreshToken);     // both share the session — not detected
    expect((await M.DeviceSession.findById(sid).lean())!.isRevoked).toBe(false);
  });

  it('GUARANTEE: a rotated-out token presented after the grace window revokes the whole session for everyone', async () => {
    const userId = await seedUser({ role: 'admin' });
    const raw = randomBytes(32).toString('hex');
    const sid = await seedSession(userId, raw);
    const fresh = await AuthService.refresh(raw, sid);
    await M.DeviceSession.updateOne({ _id: sid }, { $set: { rotatedAt: new Date(Date.now() - 2 * 3_600_000) } });
    await expect(AuthService.refresh(raw, sid)).rejects.toMatchObject({ code: 'AUTH_003' });
    expect((await M.DeviceSession.findById(sid).lean())!.revokedReason).toBe('refresh-reuse');
    await expect(AuthService.refresh(fresh.refreshToken, sid)).rejects.toMatchObject({ code: 'AUTH_003' });
  });

  it('GUARANTEE: the database never stores a usable raw refresh token', async () => {
    const userId = await seedUser({ role: 'admin' });
    const raw = randomBytes(32).toString('hex');
    const sid = await seedSession(userId, raw);
    const { refreshToken } = await AuthService.refresh(raw, sid);
    const doc = JSON.stringify(await M.DeviceSession.collection.findOne({}));
    expect(doc).not.toContain(refreshToken);
    expect(doc).not.toContain(raw);
  });

  // ── Regularization: racing reviewer vs employee ───────────────────────────

  it('concurrent reject (admin) and withdraw (employee): exactly one wins and the state is consistent', async () => {
    const empId = await seedUser();
    const reg = await M.Regularization.create({
      employeeId: empId, dateString: '2026-03-02', type: 'workAwayFromOffice', reason: 'client visit today', status: 'pending',
    });
    const results = await Promise.allSettled([
      RegularizationService.reject(reg._id.toHexString(), new mongoose.Types.ObjectId().toHexString(), 'no'),
      RegularizationService.withdraw(reg._id.toHexString(), empId.toHexString()),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ status: string }>[];
    expect(winners).toHaveLength(1);
    const final = await M.Regularization.findById(reg._id).lean();
    expect(final!.status).toBe(winners[0].value.status);
  });

  // ── Attendance: duplicate checkout & duplicate cron ───────────────────────

  async function seedActiveSession(empId: mongoose.Types.ObjectId, checkInAgoMin: number) {
    const dateString = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() - checkInAgoMin * 60_000));
    const day = await M.AttendanceDay.collection.insertOne({
      employeeId: empId, dateString, date: new Date(`${dateString}T00:00:00Z`), year: 2026, month: 3,
      status: 'absent', totalMinutes: 0, requiredMinutes: 540, overtimeMinutes: 0,
      isLateArrival: false, lateByMinutes: 0, isHalfDayCapped: false, isRegularized: false,
    });
    await M.AttendanceSession.collection.insertOne({
      employeeId: empId, attendanceDayId: day.insertedId, dateString, isActive: true, closedBySystem: false, isRemote: false,
      checkIn: { timestamp: new Date(Date.now() - checkInAgoMin * 60_000), latitude: 12.9, longitude: 77.6, accuracy: 5,
        distanceFromOffice: 0, deviceFingerprint: FP, nonce: randomBytes(8).toString('hex'), isWithinGeoFence: true },
      checkOut: null, durationMinutes: null,
      flags: { lowGpsAccuracy: false, outsideGeofence: false, suspiciousTimestamp: false, possibleMockGps: false },
    });
    return { dayId: day.insertedId, dateString };
  }

  it('two concurrent checkouts: one succeeds, minutes are counted once', async () => {
    await seedSettings();
    const empId = await seedUser();
    const { dayId } = await seedActiveSession(empId, 120);
    const input = (nonce: string) => ({
      employeeId: empId.toHexString(), deviceFingerprintHeader: FP, nonce,
      clientTimestamp: new Date().toISOString(), latitude: 12.9, longitude: 77.6, accuracy: 5,
    });
    const results = await Promise.allSettled([
      AttendanceService.checkOut(input('550e8400-e29b-41d4-a716-446655440001')),
      AttendanceService.checkOut(input('550e8400-e29b-41d4-a716-446655440002')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const day = await M.AttendanceDay.findById(dayId).lean();
    expect(day!.totalMinutes).toBeGreaterThanOrEqual(119);
    expect(day!.totalMinutes).toBeLessThanOrEqual(121);
  });

  it('checkout without GPS under an enabled geofence is rejected and the session stays open', async () => {
    await seedSettings();
    const empId = await seedUser();
    await seedActiveSession(empId, 60);
    await expect(AttendanceService.checkOut({
      employeeId: empId.toHexString(), deviceFingerprintHeader: FP,
      nonce: '550e8400-e29b-41d4-a716-446655440003', clientTimestamp: new Date().toISOString(),
    })).rejects.toMatchObject({ code: 'ATT_010' });
    expect(await M.AttendanceSession.countDocuments({ employeeId: empId, isActive: true })).toBe(1);
  });

  it('duplicate concurrent missed-check-out sweeps expire a session once and credit no time', async () => {
    await seedSettings();
    const empId = await seedUser();
    const { dayId } = await seedActiveSession(empId, 26 * 60);
    const [a, b] = await Promise.all([
      AttendanceService.reconcileMissedCheckouts(),
      AttendanceService.reconcileMissedCheckouts(),
    ]);
    expect(a.expired + b.expired).toBe(1);
    const day = await M.AttendanceDay.findById(dayId).lean();
    expect(day!.totalMinutes).toBe(0);
    expect(day!.status).toBe('absent');
    const s = await M.AttendanceSession.findOne({ employeeId: empId }).lean();
    expect(s!.checkOut).toBeNull();
    expect(s!.systemCloseReason).toBe('missed-checkout');
  });
});
