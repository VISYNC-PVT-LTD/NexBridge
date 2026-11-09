/**
 * Phase 15.21 — Authentication Runtime Verification
 * Run: npx tsx scripts/phase1521-verify.ts
 *
 * Rate-limit budget: authLimiter = 10/min per IP.
 * Login + confirm + change-password all share the same counter.
 * Four IPs used to keep each phase under 10 calls.
 */
import './bootstrap-env';
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { User } from '../src/models/User';
import { PasswordResetToken } from '../src/models/PasswordResetToken';
import { AuditLog } from '../src/models/AuditLog';
import { DeviceSession } from '../src/models/DeviceSession';
import { getAppUrl } from '../src/lib/utils/app-url';

// Never hard-code credentials. Supply the test admin password via the environment.
const VERIFY_ADMIN_PASSWORD = process.env.VERIFY_ADMIN_PASSWORD ?? '';
if (!VERIFY_ADMIN_PASSWORD) throw new Error('VERIFY_ADMIN_PASSWORD is not set.');

const BASE = 'http://localhost:3000';

const KNOWN_RAW_TOKEN = 'e'.repeat(64);
const KNOWN_TOKEN_HASH = createHash('sha256').update(KNOWN_RAW_TOKEN).digest('hex');

// Each phase gets its own IP to avoid sharing the 10/min authLimiter quota
// RFC 5737 / RFC 3849 documentation ranges — safe to spoof in tests
const randOctet = () => Math.floor(Math.random() * 200) + 1;
const IP_FLOW     = `192.0.2.${randOctet()}`;      // Scenarios 1-4  (≤10 auth calls)
const IP_CP       = `198.51.100.${randOctet()}`;   // Scenario 5 change-password
const IP_SECURITY = `203.0.113.${randOctet()}`;    // Security tests
const IP_REFRESH  = `100.64.${randOctet()}.1`;     // Token refresh

// Mutable — updated at start of each phase
let currentIp = IP_FLOW;

const results: Array<{ section: string; label: string; status: 'PASS' | 'FAIL'; detail: string }> = [];
let currentSection = '';

function section(name: string) {
  currentSection = name;
  console.log(`\n── ${name} ──`);
}

function log(label: string, pass: boolean, detail = '') {
  const status: 'PASS' | 'FAIL' = pass ? 'PASS' : 'FAIL';
  console.log(`${pass ? '✓' : '✗'} [${status}] ${label}${detail ? ': ' + detail : ''}`);
  results.push({ section: currentSection, label, status, detail });
}

async function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': currentIp,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json();
  return { res, body: json };
}

async function patch(path: string, body: unknown, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Forwarded-For': currentIp,
    },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

async function get(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': currentIp },
  });
  return { res, body: await res.json() };
}

async function loginAs(email: string, password: string, fp: string, ua?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': currentIp,
  };
  if (ua) headers['User-Agent'] = ua;
  const loginPayload: Record<string, string> = { email, password };
  if (fp) loginPayload['deviceFingerprint'] = fp;
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers, body: JSON.stringify(loginPayload),
  });
  const json = await res.json();
  return { res, body: json, accessToken: (json.data?.accessToken ?? '') as string };
}

async function insertKnownToken(email: string, userId: mongoose.Types.ObjectId, expiryMs = 24 * 60 * 60 * 1000) {
  // Only delete UNUSED known tokens — preserve used-token history for audit
  await PasswordResetToken.deleteMany({ email, tokenHash: KNOWN_TOKEN_HASH, isUsed: false });
  await PasswordResetToken.create({
    userId,
    email,
    tokenHash: KNOWN_TOKEN_HASH,
    expiresAt: new Date(Date.now() + expiryMs),
    ipAddress: 'test',
  });
}

async function run() {
  const uri = process.env.MONGODB_URI!;
  await mongoose.connect(uri);
  console.log(`[DB] Connected`);
  console.log(`[IP] FLOW=${IP_FLOW} | CP=${IP_CP} | SEC=${IP_SECURITY} | REFRESH=${IP_REFRESH}\n`);

  // ── ENV VERIFICATION ─────────────────────────────────────────────────────────
  section('ENV VERIFICATION');
  const appUrl = getAppUrl();
  log('NEXT_PUBLIC_APP_URL != placeholder', !appUrl.includes('your-app.vercel.app'), appUrl);
  log('getAppUrl() returns http://localhost:3000', appUrl === 'http://localhost:3000', appUrl);
  const inviteUrl = `${appUrl}/reset-password?token=TOKEN&email=user%40example.com`;
  log('Invite URL domain correct', inviteUrl.startsWith('http://localhost:3000'), inviteUrl);

  // ══════════════════════════════════════════════════════════════════════════════
  // SCENARIOS 1-4  (IP_FLOW — budget: 10 auth-rate-limited calls)
  // call budget: 4 confirm + 5 login = 9 calls ✓
  // ══════════════════════════════════════════════════════════════════════════════
  currentIp = IP_FLOW;

  // ── ADMIN LOGIN ───────────────────────────────────────────────────────────────
  section('ADMIN LOGIN');
  const { res: loginRes, body: loginBody, accessToken: adminToken } = await loginAs(
    'admin@genesis.com', VERIFY_ADMIN_PASSWORD, '',  // call 1 of IP_FLOW
  );
  log('Admin login → 200', loginRes.status === 200, `HTTP ${loginRes.status}`);
  log('Access token issued', !!adminToken);
  log('Refresh token issued', !!loginBody.data?.refreshToken);
  log('Session ID issued', !!loginBody.data?.sessionId);
  log('Role = admin', loginBody.data?.employee?.role === 'admin');
  log('requiresPasswordChange = false', loginBody.data?.employee?.requiresPasswordChange === false);

  // ── SCENARIO 1: INVITE FLOW ───────────────────────────────────────────────────
  section('SCENARIO 1: INVITE FLOW');
  const ts = Date.now();
  const empEmail = `s1.${ts}@testhrms.local`;
  const ANDROID_UA = 'Genesis HRMS/1.0 (Android 14; Pixel 7)';
  const fingerprint = 'f'.repeat(64);

  const { res: createRes, body: createBody } = await post('/api/v1/employees', {
    employeeId: `S1${ts.toString().slice(-4)}`, firstName: 'Scenario', lastName: 'One',
    email: empEmail, role: 'employee', monthlySalary: 50000, dateOfJoining: '2024-01-01',
  }, adminToken);
  log('Create employee → 201', createRes.status === 201, `HTTP ${createRes.status}`);
  const empId: string = createBody.data?.id ?? '';
  log('Employee id in response', !!empId, empId);
  log('No temporaryPassword in response', !createBody.data?.temporaryPassword);

  // DB: User record
  const empUser = await User.findOne({ email: empEmail });
  log('User record exists in DB', !!empUser, empUser?.email ?? 'not found');
  log('requiresPasswordChange = true on new user', empUser?.requiresPasswordChange === true);

  // DB: Invite token
  const inviteToken = await PasswordResetToken.findOne({ email: empEmail }).sort({ createdAt: -1 });
  log('PasswordResetToken exists for employee', !!inviteToken);
  log('Token isUsed = false', inviteToken?.isUsed === false);
  log('Token ipAddress = system (invite marker)', inviteToken?.ipAddress === 'system');
  log('Token expiresAt ~24h in future', !!inviteToken && inviteToken.expiresAt > new Date(Date.now() + 23 * 60 * 60 * 1000),
    inviteToken ? `expires ${inviteToken.expiresAt.toISOString()}` : 'n/a');
  log('TokenHash is SHA-256 (64 hex chars)', inviteToken?.tokenHash.length === 64);

  // DB: Audit EMPLOYEE_CREATED
  const createAudit = await AuditLog.findOne({ action: 'EMPLOYEE_CREATED', targetId: empId });
  log('AuditLog EMPLOYEE_CREATED written', !!createAudit);

  // Simulate employee clicking invite email link
  await insertKnownToken(empEmail, empUser!._id as mongoose.Types.ObjectId);
  const { res: confirmRes, body: confirmBody } = await post('/api/v1/auth/password-reset/confirm', {  // call 2 of IP_FLOW
    token: KNOWN_RAW_TOKEN, email: empEmail, newPassword: 'EmpPwd@123456',
  });
  log('Confirm invite → 200', confirmRes.status === 200, `HTTP ${confirmRes.status}`);
  log('Success message in response', confirmBody.data?.message?.includes('Password updated') === true,
    confirmBody.data?.message);

  // DB: Token marked used
  const usedInviteToken = await PasswordResetToken.findOne({ email: empEmail, tokenHash: KNOWN_TOKEN_HASH });
  log('Token isUsed = true after confirm', usedInviteToken?.isUsed === true);
  log('Token usedAt set', !!usedInviteToken?.usedAt);

  // DB: requiresPasswordChange cleared
  const updatedUser = await User.findOne({ email: empEmail });
  log('requiresPasswordChange = false after setup', updatedUser?.requiresPasswordChange === false);

  // DB: AUTH_PASSWORD_SETUP audit
  const setupAudit = await AuditLog.findOne({ action: 'AUTH_PASSWORD_SETUP', targetId: empId });
  log('AuditLog AUTH_PASSWORD_SETUP written', !!setupAudit);

  // Token REPLAY → AUTH_008
  const { body: replayBody } = await post('/api/v1/auth/password-reset/confirm', {  // call 3 of IP_FLOW
    token: KNOWN_RAW_TOKEN, email: empEmail, newPassword: 'Replay@123456',
  });
  log('Token replay → AUTH_008', replayBody.error?.code === 'AUTH_008', replayBody.error?.code);

  // ── SCENARIO 2: LOGIN ─────────────────────────────────────────────────────────
  section('SCENARIO 2: LOGIN (employee role)');

  const { res: regRes } = await patch(`/api/v1/employees/${empId}/register-device`, {
    deviceFingerprint: fingerprint, deviceName: 'Pixel 7', platform: 'android',
  }, adminToken);
  log('Register device → 200', regRes.status === 200, `HTTP ${regRes.status}`);

  const { res: empLoginRes, body: empLoginBody, accessToken: empToken1 } = await loginAs(  // call 4 of IP_FLOW
    empEmail, 'EmpPwd@123456', fingerprint, ANDROID_UA,
  );
  log('Employee login → 200', empLoginRes.status === 200, `HTTP ${empLoginRes.status}`);
  log('Employee access token issued', !!empToken1);
  log('Employee role = employee', empLoginBody.data?.employee?.role === 'employee');
  log('requiresPasswordChange = false', empLoginBody.data?.employee?.requiresPasswordChange === false);

  const { body: meBody } = await get('/api/v1/auth/me', empToken1);
  log('/me returns correct email', meBody.data?.email === empEmail, meBody.data?.email);
  log('/me returns id field', !!meBody.data?.id);

  // DB: DeviceSession platform determined by User-Agent
  const session = await DeviceSession.findOne({ employeeId: updatedUser!._id, isRevoked: false });
  log('DeviceSession created in DB', !!session);
  log('DeviceSession platform = android (Android UA)', session?.platform === 'android',
    session ? `platform=${session.platform}` : 'no session');

  // ── SCENARIO 3: ADMIN-INITIATED PASSWORD RESET ─────────────────────────────────
  section('SCENARIO 3: ADMIN-INITIATED PASSWORD RESET');

  const { res: fpRes } = await post('/api/v1/auth/password-reset/request', { email: empEmail });
  log('Password reset request → 200', fpRes.status === 200, `HTTP ${fpRes.status}`);

  // DB: Token with 15-min expiry, ipAddress = IP_FLOW
  const resetToken = await PasswordResetToken.findOne({
    email: empEmail, isUsed: false, ipAddress: IP_FLOW,
  }).sort({ createdAt: -1 });
  log('New PasswordResetToken created (15-min)', !!resetToken);
  log('Token expiresAt ≤ 16min from now', !!resetToken && resetToken.expiresAt <= new Date(Date.now() + 16 * 60 * 1000),
    resetToken ? `expires ${resetToken.expiresAt.toISOString()}` : 'n/a');

  await insertKnownToken(empEmail, updatedUser!._id as mongoose.Types.ObjectId);
  const { res: resetConfirmRes } = await post('/api/v1/auth/password-reset/confirm', {  // call 5 of IP_FLOW
    token: KNOWN_RAW_TOKEN, email: empEmail, newPassword: 'Reset@123456',
  });
  log('Password reset confirm → 200', resetConfirmRes.status === 200, `HTTP ${resetConfirmRes.status}`);

  const { body: oldPwdBody } = await loginAs(empEmail, 'EmpPwd@123456', fingerprint, ANDROID_UA);  // call 6
  log('Old password rejected after reset', oldPwdBody.error?.code === 'AUTH_001', oldPwdBody.error?.code);

  const { res: newLoginRes } = await loginAs(empEmail, 'Reset@123456', fingerprint, ANDROID_UA);  // call 7
  log('New password accepted', newLoginRes.status === 200, `HTTP ${newLoginRes.status}`);

  const revokedSessions = await DeviceSession.find({ employeeId: updatedUser!._id, isRevoked: true });
  log('Previous sessions revoked on reset', revokedSessions.length > 0, `${revokedSessions.length} revoked`);

  const resetAuditAll = await AuditLog.find({ action: 'AUTH_PASSWORD_SETUP', targetId: empId });
  log('AUTH_PASSWORD_SETUP entries ≥ 2', resetAuditAll.length >= 2, `${resetAuditAll.length} entries`);

  // ── SCENARIO 4: FORGOT PASSWORD FLOW ─────────────────────────────────────────
  section('SCENARIO 4: FORGOT PASSWORD FLOW');

  const { res: fp2Res } = await post('/api/v1/auth/password-reset/request', { email: empEmail });
  log('Forgot-password → 200 (always)', fp2Res.status === 200);

  const { res: fp2FakeRes } = await post('/api/v1/auth/password-reset/request', { email: 'fake@nobody.invalid' });
  log('Non-existent email → 200 (enumeration prevention)', fp2FakeRes.status === 200);

  await insertKnownToken(empEmail, updatedUser!._id as mongoose.Types.ObjectId);
  const { res: fpConfirmRes } = await post('/api/v1/auth/password-reset/confirm', {  // call 8 of IP_FLOW
    token: KNOWN_RAW_TOKEN, email: empEmail, newPassword: 'ForgotNew@123456',
  });
  log('Forgot-password confirm → 200', fpConfirmRes.status === 200, `HTTP ${fpConfirmRes.status}`);

  // Extract token from this login — avoids an extra auth call
  const { res: fpLoginRes, accessToken: empToken3 } = await loginAs(  // call 9 of IP_FLOW
    empEmail, 'ForgotNew@123456', fingerprint, ANDROID_UA,
  );
  log('Login after forgot-password → 200', fpLoginRes.status === 200);
  log('Token obtained for scenario 5', !!empToken3, empToken3 ? 'ok' : 'empty');

  const { body: oldResetBody } = await loginAs(empEmail, 'Reset@123456', fingerprint, ANDROID_UA);  // call 10 of IP_FLOW
  log('Previous password rejected', oldResetBody.error?.code === 'AUTH_001', oldResetBody.error?.code);

  // ══════════════════════════════════════════════════════════════════════════════
  // SCENARIO 5  (IP_CP — fresh 10-call budget for change-password tests)
  // budget: 4 change-password + 2 login = 6 calls ✓
  // ══════════════════════════════════════════════════════════════════════════════
  currentIp = IP_CP;
  section('SCENARIO 5: AUTHENTICATED CHANGE PASSWORD');

  const { body: cpMissingBody } = await patch('/api/v1/auth/me/change-password',
    { newPassword: 'NewPwd@123456' }, empToken3);                              // call 1 of IP_CP
  log('Missing currentPassword → GEN_001', cpMissingBody.error?.code === 'GEN_001', cpMissingBody.error?.code);

  const { body: cpWrongBody } = await patch('/api/v1/auth/me/change-password',
    { currentPassword: 'Wrong@123456', newPassword: 'Changed@123456' }, empToken3);  // call 2 of IP_CP
  log('Wrong currentPassword → AUTH_001', cpWrongBody.error?.code === 'AUTH_001', cpWrongBody.error?.code);

  const { body: cpSameBody } = await patch('/api/v1/auth/me/change-password',
    { currentPassword: 'ForgotNew@123456', newPassword: 'ForgotNew@123456' }, empToken3);  // call 3 of IP_CP
  log('Same password → GEN_001', cpSameBody.error?.code === 'GEN_001', cpSameBody.error?.code);

  const { res: cpRes, body: cpBody } = await patch('/api/v1/auth/me/change-password',
    { currentPassword: 'ForgotNew@123456', newPassword: 'Changed@123456' }, empToken3);  // call 4 of IP_CP
  log('Change-password → 200', cpRes.status === 200, `HTTP ${cpRes.status}`);
  log('New accessToken returned', !!cpBody.data?.accessToken);
  log('Success message returned', cpBody.data?.message?.includes('changed') === true,
    cpBody.data?.message ?? '(no message)');

  const { body: cpOldBody } = await loginAs(empEmail, 'ForgotNew@123456', fingerprint, ANDROID_UA);  // call 5 of IP_CP
  log('Old password rejected after change', cpOldBody.error?.code === 'AUTH_001', cpOldBody.error?.code);

  const { res: cpLoginRes } = await loginAs(empEmail, 'Changed@123456', fingerprint, ANDROID_UA);  // call 6 of IP_CP
  log('New password accepted', cpLoginRes.status === 200, `HTTP ${cpLoginRes.status}`);

  const changedAudit = await AuditLog.findOne({ action: 'AUTH_PASSWORD_CHANGED', targetId: empId });
  log('AuditLog AUTH_PASSWORD_CHANGED written', !!changedAudit);

  // ══════════════════════════════════════════════════════════════════════════════
  // SECURITY TESTS  (IP_SECURITY — fresh 10-call budget)
  // budget: 4 confirm + 3 login = 7 calls ✓
  // ══════════════════════════════════════════════════════════════════════════════
  currentIp = IP_SECURITY;

  section('SECURITY: EXPIRED TOKEN');
  await insertKnownToken(empEmail, updatedUser!._id as mongoose.Types.ObjectId, -1000);
  const { body: expBody } = await post('/api/v1/auth/password-reset/confirm', {  // call 1 of IP_SECURITY
    token: KNOWN_RAW_TOKEN, email: empEmail, newPassword: 'Expire@123456',
  });
  log('Expired token → AUTH_009', expBody.error?.code === 'AUTH_009', expBody.error?.code);
  // confirmPasswordReset throws before marking used — clean up so subsequent tests find valid tokens
  await PasswordResetToken.deleteMany({ email: empEmail, tokenHash: KNOWN_TOKEN_HASH, isUsed: false });

  section('SECURITY: INVALID TOKEN (random 64-char hex)');
  const { body: invBody } = await post('/api/v1/auth/password-reset/confirm', {  // call 2 of IP_SECURITY
    token: 'b'.repeat(64), email: empEmail, newPassword: 'Invalid@123456',
  });
  log('Invalid token → AUTH_008', invBody.error?.code === 'AUTH_008', invBody.error?.code);

  section('SECURITY: MODIFIED TOKEN (1-char diff)');
  const modifiedToken = KNOWN_RAW_TOKEN.slice(0, 63) + 'f';
  const { body: modBody } = await post('/api/v1/auth/password-reset/confirm', {  // call 3 of IP_SECURITY
    token: modifiedToken, email: empEmail, newPassword: 'Modified@123456',
  });
  log('Modified token → AUTH_008', modBody.error?.code === 'AUTH_008', modBody.error?.code);

  section('SECURITY: WRONG EMAIL + VALID TOKEN');
  await insertKnownToken(empEmail, updatedUser!._id as mongoose.Types.ObjectId);
  const { body: wrongEmailBody } = await post('/api/v1/auth/password-reset/confirm', {  // call 4 of IP_SECURITY
    token: KNOWN_RAW_TOKEN, email: 'wrong@example.com', newPassword: 'Wrong@123456',
  });
  log('Wrong email + valid token → AUTH_008', wrongEmailBody.error?.code === 'AUTH_008', wrongEmailBody.error?.code);
  await PasswordResetToken.deleteMany({ email: empEmail, tokenHash: KNOWN_TOKEN_HASH, isUsed: false });

  section('SECURITY: MULTIPLE RESET REQUESTS');
  await post('/api/v1/auth/password-reset/request', { email: empEmail });
  await post('/api/v1/auth/password-reset/request', { email: empEmail });
  const multipleTokens = await PasswordResetToken.countDocuments({ email: empEmail, isUsed: false });
  log('Multiple unused reset tokens coexist', multipleTokens >= 2, `${multipleTokens} unused tokens`);

  section('SECURITY: WRONG DEVICE FINGERPRINT');
  const { body: wrongFpBody } = await loginAs(empEmail, 'Changed@123456', 'a'.repeat(64), ANDROID_UA);  // call 5 of IP_SECURITY
  log('Wrong fingerprint → AUTH_005', wrongFpBody.error?.code === 'AUTH_005', wrongFpBody.error?.code);

  section('SECURITY: NO DEVICE FINGERPRINT (employee role)');
  const noFpRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': currentIp },
    body: JSON.stringify({ email: empEmail, password: 'Changed@123456' }),
  });
  const noFpBody = await noFpRes.json();
  log('No fingerprint → AUTH_004 or AUTH_005', ['AUTH_004', 'AUTH_005'].includes(noFpBody.error?.code),  // call 6 of IP_SECURITY
    noFpBody.error?.code);

  section('SECURITY: INACTIVE USER');
  await patch(`/api/v1/employees/${empId}/deactivate`, {}, adminToken);
  const { body: inactiveBody } = await loginAs(empEmail, 'Changed@123456', fingerprint, ANDROID_UA);  // call 7 of IP_SECURITY
  log('Inactive user → AUTH_007', inactiveBody.error?.code === 'AUTH_007', inactiveBody.error?.code);
  await patch(`/api/v1/employees/${empId}/activate`, {}, adminToken);

  // ══════════════════════════════════════════════════════════════════════════════
  // TOKEN REFRESH  (IP_REFRESH — fresh 10-call budget)
  // budget: 1 login + 1 non-rate-limited refresh = 1 call ✓
  // ══════════════════════════════════════════════════════════════════════════════
  currentIp = IP_REFRESH;
  section('TOKEN REFRESH');

  const { body: freshLogin } = await loginAs('admin@genesis.com', VERIFY_ADMIN_PASSWORD, '');  // call 1 of IP_REFRESH
  const { res: refreshRes, body: refreshBody } = await post('/api/v1/auth/refresh', {
    refreshToken: freshLogin.data?.refreshToken,
    sessionId: freshLogin.data?.sessionId,
  });
  log('Token refresh → 200', refreshRes.status === 200, `HTTP ${refreshRes.status}`);
  log('New accessToken on refresh', !!refreshBody.data?.accessToken);

  // ══════════════════════════════════════════════════════════════════════════════
  // DATABASE VALIDATION (no rate-limited calls)
  // ══════════════════════════════════════════════════════════════════════════════
  section('DATABASE: ORPHAN CHECK');
  const allUserIds = await User.find({}).distinct('_id');
  const orphanTokens = await PasswordResetToken.countDocuments({
    userId: { $nin: allUserIds },
  });
  log('No orphan PasswordResetTokens', orphanTokens === 0, `${orphanTokens} orphans`);

  const allAuditForEmp = await AuditLog.countDocuments({ targetId: empId });
  log('AuditLog ≥5 entries for employee', allAuditForEmp >= 5, `${allAuditForEmp} entries`);

  section('DATABASE: TOKEN LIFECYCLE');
  const usedTokenCount = await PasswordResetToken.countDocuments({ email: empEmail, isUsed: true });
  const unusedTokenCount = await PasswordResetToken.countDocuments({ email: empEmail, isUsed: false });
  log('Used tokens exist (invite + reset + forgot)', usedTokenCount >= 3, `${usedTokenCount} used`);
  log('Unused tokens present (multiple reset requests)', unusedTokenCount >= 2, `${unusedTokenCount} unused`);

  const expiredTokenCount = await PasswordResetToken.countDocuments({
    email: empEmail, expiresAt: { $lt: new Date() },
  });
  log('Expired tokens pending TTL cleanup', true,
    `${expiredTokenCount} expired (MongoDB TTL cleans asynchronously)`);

  section('DATABASE: AUDIT COMPLETENESS');
  const auditActions = await AuditLog.distinct('action', { targetId: empId });
  log('EMPLOYEE_CREATED audit exists', auditActions.includes('EMPLOYEE_CREATED'));
  log('AUTH_PASSWORD_SETUP audit exists', auditActions.includes('AUTH_PASSWORD_SETUP'));
  log('AUTH_PASSWORD_CHANGED audit exists', auditActions.includes('AUTH_PASSWORD_CHANGED'));
  log('AUTH_LOGIN audit exists', auditActions.includes('AUTH_LOGIN'));

  // ── SUMMARY ───────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════');
  console.log('SUMMARY');
  console.log('══════════════════════════════');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ✗ [${r.section}] ${r.label}${r.detail ? ': ' + r.detail : ''}`);
    });
  }

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
