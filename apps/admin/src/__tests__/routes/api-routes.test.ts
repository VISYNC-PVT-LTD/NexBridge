/**
 * Route-handler level tests: authentication, role checks, validation, headers,
 * cookies and error shapes. Services are mocked — these exercise the HTTP
 * contract, not business logic (covered by service tests).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

import * as loginRoute from '@/app/api/v1/auth/login/route';
import * as refreshRoute from '@/app/api/v1/auth/refresh/route';
import * as changePwRoute from '@/app/api/v1/auth/me/change-password/route';
import * as resetRequestRoute from '@/app/api/v1/auth/password-reset/request/route';
import * as attendanceAdminRoute from '@/app/api/v1/attendance/route';
import * as checkoutRoute from '@/app/api/v1/attendance/checkout/route';
import * as regApproveRoute from '@/app/api/v1/regularizations/[id]/approve/route';
import * as regWithdrawRoute from '@/app/api/v1/regularizations/[id]/withdraw/route';
import * as payrollListRoute from '@/app/api/v1/payroll/route';
import * as reportsRoute from '@/app/api/v1/reports/attendance/route';
import { AuthService, AppError } from '@services/AuthService';
import { AttendanceService } from '@services/AttendanceService';
import { RegularizationService } from '@services/RegularizationService';
import { PayrollService } from '@services/PayrollService';
import { ReportService } from '@services/ReportService';
import { __resetMemoryRateLimits } from '@mw/rateLimiter';

const BASE = 'http://localhost:3000';
const USER_ID = '507f1f77bcf86cd799439011';
const FP = 'a'.repeat(64);
type Role = 'employee' | 'manager' | 'executive' | 'admin' | 'super_admin';

async function token(role: Role, extra: Record<string, unknown> = {}) {
  return new SignJWT({ userId: USER_ID, role, requiresPasswordChange: false, ...extra })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
}

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const bearer = async (role: Role) => ({ authorization: `Bearer ${await token(role)}` });
const idParams = { params: Promise.resolve({ id: '507f1f77bcf86cd799439012' }) };

beforeEach(() => __resetMemoryRateLimits());
afterEach(() => jest.restoreAllMocks());

// ─── Authentication ──────────────────────────────────────────────────────────

describe('protected routes require authentication', () => {
  it('no token → 401 AUTH_003 with a generic message', async () => {
    const res = await attendanceAdminRoute.GET(req('/api/v1/attendance'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, error: { code: 'AUTH_003' } });
  });

  it('forged token (wrong key) → 401', async () => {
    const forged = await new SignJWT({ userId: USER_ID, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('15m')
      .sign(new TextEncoder().encode('attacker-key-0000000000000000000000000000000000000000'));
    const res = await attendanceAdminRoute.GET(req('/api/v1/attendance', { headers: { authorization: `Bearer ${forged}` } }));
    expect(res.status).toBe(401);
  });
});

// ─── Role checks: HR data is admin + super_admin only ────────────────────────

describe('HR admin endpoints: admin and super_admin allowed; others 403', () => {
  const cases: Array<[string, (h: Record<string, string>) => Promise<Response>, () => void]> = [
    ['GET /attendance (all employees)', (h) => attendanceAdminRoute.GET(req('/api/v1/attendance', { headers: h })),
      () => jest.spyOn(AttendanceService, 'adminList').mockResolvedValue({ data: [], meta: {} } as never)],
    ['GET /payroll', (h) => payrollListRoute.GET(req('/api/v1/payroll', { headers: h })),
      () => jest.spyOn(PayrollService, 'listAdmin').mockResolvedValue({ data: [], pagination: {} } as never)],
    ['GET /reports/attendance', (h) => reportsRoute.GET(req('/api/v1/reports/attendance?startDate=2026-01-01&endDate=2026-01-31', { headers: h })),
      () => jest.spyOn(ReportService, 'attendanceReport' as never).mockResolvedValue({} as never)],
    ['PATCH /regularizations/:id/approve', (h) => regApproveRoute.PATCH(req('/api/v1/regularizations/x/approve', { method: 'PATCH', headers: h }), idParams),
      () => jest.spyOn(RegularizationService, 'approve').mockResolvedValue({ id: 'x', status: 'approved' } as never)],
  ];

  it.each(cases)('%s: employee, manager, executive → 403', async (_name, call) => {
    for (const role of ['employee', 'manager', 'executive'] as const) {
      const res = await call(await bearer(role));
      expect(res.status).toBe(403);
    }
  });

  it.each(cases)('%s: super_admin is treated like admin (not 403)', async (_name, call, mock) => {
    mock();
    for (const role of ['admin', 'super_admin'] as const) {
      const res = await call(await bearer(role));
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    }
  });
});

describe('employee-only actions', () => {
  it('PATCH /regularizations/:id/withdraw is employee-only and passes the caller id', async () => {
    const svc = jest.spyOn(RegularizationService, 'withdraw').mockResolvedValue({ id: 'x', status: 'withdrawn' });
    const ok = await regWithdrawRoute.PATCH(req('/x', { method: 'PATCH', headers: await bearer('employee') }), idParams);
    expect(ok.status).toBe(200);
    expect(svc).toHaveBeenCalledWith('507f1f77bcf86cd799439012', USER_ID);
    const denied = await regWithdrawRoute.PATCH(req('/x', { method: 'PATCH', headers: await bearer('admin') }), idParams);
    expect(denied.status).toBe(403);
  });
});

// ─── Attendance checkout route ───────────────────────────────────────────────

describe('POST /attendance/checkout', () => {
  it('forwards the X-Device-Fingerprint header to the service', async () => {
    const svc = jest.spyOn(AttendanceService, 'checkOut').mockResolvedValue({} as never);
    const res = await checkoutRoute.POST(req('/api/v1/attendance/checkout', {
      method: 'POST',
      headers: { ...(await bearer('employee')), 'x-device-fingerprint': FP },
      body: { nonce: '550e8400-e29b-41d4-a716-446655440000', timestamp: new Date().toISOString(), latitude: 1, longitude: 1, accuracy: 5 },
    }));
    expect(res.status).toBe(200);
    expect(svc.mock.calls[0][0]).toMatchObject({ employeeId: USER_ID, deviceFingerprintHeader: FP });
  });

  it('invalid body → 400 GEN_001 without echoing input', async () => {
    const res = await checkoutRoute.POST(req('/api/v1/attendance/checkout', {
      method: 'POST', headers: await bearer('employee'), body: { nonce: 'not-a-uuid', timestamp: 'x' },
    }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('not-a-uuid');
  });

  it('service error codes are passed through (ATT_010 location required)', async () => {
    jest.spyOn(AttendanceService, 'checkOut').mockRejectedValue(new AppError('ATT_010', 422, 'Location is required to check out.'));
    const res = await checkoutRoute.POST(req('/api/v1/attendance/checkout', {
      method: 'POST', headers: { ...(await bearer('employee')), 'x-device-fingerprint': FP },
      body: { nonce: '550e8400-e29b-41d4-a716-446655440000', timestamp: new Date().toISOString() },
    }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'ATT_010' } });
  });
});

// ─── Auth routes ─────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('validation failure → 400 GEN_001', async () => {
    const res = await loginRoute.POST(req('/api/v1/auth/login', { method: 'POST', body: { email: 'nope' } }));
    expect(res.status).toBe(400);
  });

  it('rate-limits repeated failures for one account with 429 + Retry-After (Redis down → in-memory)', async () => {
    jest.spyOn(AuthService, 'login').mockRejectedValue(new AppError('AUTH_001', 401));
    const body = { email: 'jane@example.com', password: 'wrongpass1' };
    for (let i = 0; i < 10; i++) {
      expect((await loginRoute.POST(req('/api/v1/auth/login', { method: 'POST', body }))).status).toBe(401);
    }
    const limited = await loginRoute.POST(req('/api/v1/auth/login', { method: 'POST', body }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    // A colleague on the same (office) IP is unaffected.
    const colleague = await loginRoute.POST(req('/api/v1/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'wrongpass1' } }));
    expect(colleague.status).toBe(401);
  });

  it('successful login sets HttpOnly SameSite=Strict cookies', async () => {
    jest.spyOn(AuthService, 'login').mockResolvedValue({
      accessToken: 'at', refreshToken: 'rt', sessionId: 'sid', employee: {} as never,
    } as never);
    const res = await loginRoute.POST(req('/api/v1/auth/login', { method: 'POST', body: { email: 'jane@example.com', password: 'rightpass1' } }));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/__session=at/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
  });
});

describe('POST /auth/refresh', () => {
  it('returns the rotated refresh token and updates the __rt cookie', async () => {
    jest.spyOn(AuthService, 'refresh').mockResolvedValue({ accessToken: 'new-at', refreshToken: 'new-rt' });
    const res = await refreshRoute.POST(req('/api/v1/auth/refresh', {
      method: 'POST', body: { refreshToken: 'old-rt', sessionId: '507f1f77bcf86cd799439013' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { accessToken: 'new-at', refreshToken: 'new-rt' } });
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__rt=507f1f77bcf86cd799439013%3Anew-rt|__rt=507f1f77bcf86cd799439013:new-rt/);
  });

  it('web: empty body uses the HttpOnly __rt cookie (same origin)', async () => {
    const svc = jest.spyOn(AuthService, 'refresh').mockResolvedValue({ accessToken: 'a', refreshToken: 'b' });
    const res = await refreshRoute.POST(req('/api/v1/auth/refresh', {
      method: 'POST', body: {},
      headers: { cookie: '__rt=507f1f77bcf86cd799439013:cookie-rt', origin: BASE },
    }));
    expect(res.status).toBe(200);
    expect(svc.mock.calls[0].slice(0, 2)).toEqual(['cookie-rt', '507f1f77bcf86cd799439013']);
  });

  it('web: cookie refresh from another origin is refused', async () => {
    const svc = jest.spyOn(AuthService, 'refresh');
    const res = await refreshRoute.POST(req('/api/v1/auth/refresh', {
      method: 'POST', body: {},
      headers: { cookie: '__rt=507f1f77bcf86cd799439013:cookie-rt', origin: 'https://evil.example' },
    }));
    expect(res.status).toBe(401);
    expect(svc).not.toHaveBeenCalled();
  });

  it('invalid token → 401 (mobile then signs out); 429 is distinct from 401', async () => {
    jest.spyOn(AuthService, 'refresh').mockRejectedValue(new AppError('AUTH_003', 401));
    const res = await refreshRoute.POST(req('/api/v1/auth/refresh', {
      method: 'POST', body: { refreshToken: 'x', sessionId: '507f1f77bcf86cd799439013' },
    }));
    expect(res.status).toBe(401);
  });
});

describe('PATCH /auth/me/change-password', () => {
  it('cookie-authenticated cross-origin request is rejected (CSRF) before any work', async () => {
    const svc = jest.spyOn(AuthService, 'changePassword');
    const res = await changePwRoute.PATCH(req('/api/v1/auth/me/change-password', {
      method: 'PATCH',
      headers: { cookie: `__session=${await token('employee')}`, origin: 'https://evil.example' },
      body: { currentPassword: 'OldPass123', newPassword: 'NewPass123' },
    }));
    expect(res.status).toBe(403);
    expect(svc).not.toHaveBeenCalled();
  });

  it('passes the caller session id and refreshes the __session cookie', async () => {
    const svc = jest.spyOn(AuthService, 'changePassword').mockResolvedValue({ accessToken: 'fresh', currentSessionKept: true });
    const res = await changePwRoute.PATCH(req('/api/v1/auth/me/change-password', {
      method: 'PATCH',
      headers: await bearer('employee'),
      body: { currentPassword: 'OldPass123', newPassword: 'NewPass123', sessionId: '507f1f77bcf86cd799439013' },
    }));
    expect(res.status).toBe(200);
    expect(svc.mock.calls[0][5]).toBe('507f1f77bcf86cd799439013');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__session=fresh/);
  });
});

describe('POST /auth/password-reset/request', () => {
  it('always returns the same generic response (no account enumeration), even when rate-limited', async () => {
    const svc = jest.spyOn(AuthService, 'requestPasswordReset').mockResolvedValue(undefined);
    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await resetRequestRoute.POST(req('/api/v1/auth/password-reset/request', { method: 'POST', body: { email: 'jane@example.com' } }));
      expect(res.status).toBe(200);
      bodies.push(JSON.stringify(await res.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(svc).toHaveBeenCalledTimes(3); // limit 3/h per email; extra requests silently dropped
  });
});
