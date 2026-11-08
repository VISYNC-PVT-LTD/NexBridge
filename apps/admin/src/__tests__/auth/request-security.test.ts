import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { getAuthUser } from '@mw/requireAuth';
import { previousKeyIfAllowed, verifyAccessToken, MAX_PREVIOUS_KEY_WINDOW_MS } from '@lib/auth/jwt';
import {
  getClientIp,
  checkRateLimit,
  isWithinRateLimit,
  authLimiter,
  __resetMemoryRateLimits,
} from '@mw/rateLimiter';

const PREV = 'previous-secret-0000000000000000000000000000000000000000000000000000000';

async function sign(secret: string, opts: { exp?: string | number } = {}) {
  return new SignJWT({ userId: '507f1f77bcf86cd799439011', role: 'employee', requiresPasswordChange: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '15m')
    .sign(new TextEncoder().encode(secret));
}

function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, { method: init.method ?? 'GET', headers: init.headers });
}

const ENV_KEYS = ['JWT_SECRET_PREVIOUS', 'JWT_SECRET_PREVIOUS_EXPIRES_AT', 'VERCEL', 'TRUST_PROXY_HEADERS'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─── JWT_SECRET_PREVIOUS ─────────────────────────────────────────────────────

describe('JWT previous-key policy', () => {
  it('previous key is ignored when no expiry is configured', async () => {
    process.env.JWT_SECRET_PREVIOUS = PREV;
    delete process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT;
    expect(previousKeyIfAllowed()).toBeNull();
    await expect(verifyAccessToken(await sign(PREV))).rejects.toThrow();
  });

  it('previous key is ignored once its expiry has passed', async () => {
    process.env.JWT_SECRET_PREVIOUS = PREV;
    process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
    await expect(verifyAccessToken(await sign(PREV))).rejects.toThrow();
  });

  it('previous key is ignored when the expiry is unreasonably far away (> 24h)', () => {
    process.env.JWT_SECRET_PREVIOUS = PREV;
    process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = new Date(Date.now() + MAX_PREVIOUS_KEY_WINDOW_MS + 60_000).toISOString();
    expect(previousKeyIfAllowed()).toBeNull();
  });

  it('previous key works inside a short, explicit rotation window', async () => {
    process.env.JWT_SECRET_PREVIOUS = PREV;
    process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
    await expect(verifyAccessToken(await sign(PREV))).resolves.toMatchObject({ role: 'employee' });
  });

  it('an EXPIRED token is never rescued by the previous key', async () => {
    process.env.JWT_SECRET_PREVIOUS = process.env.JWT_SECRET; // even if misconfigured to match
    process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
    const expired = await sign(process.env.JWT_SECRET!, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(verifyAccessToken(expired)).rejects.toThrow();
  });

  it('rejects tokens signed with alg none / other algorithms', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ userId: 'x', role: 'admin', exp: 9999999999 })).toString('base64url');
    await expect(verifyAccessToken(`${header}.${body}.`)).rejects.toThrow();
  });
});

// ─── CSRF (cookie-authenticated, state-changing requests) ────────────────────

describe('getAuthUser — CSRF protection for cookie auth', () => {
  const APP = 'http://localhost:3000';

  it('Bearer requests are unaffected by Origin (mobile app has none)', async () => {
    const token = await sign(process.env.JWT_SECRET!);
    await expect(getAuthUser(req(`${APP}/api/v1/attendance/checkin`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    }))).resolves.toMatchObject({ role: 'employee' });
  });

  it('cookie GET is allowed without Origin', async () => {
    const token = await sign(process.env.JWT_SECRET!);
    await expect(getAuthUser(req(`${APP}/api/v1/auth/me`, { headers: { cookie: `__session=${token}` } })))
      .resolves.toMatchObject({ role: 'employee' });
  });

  it('cookie POST from the same origin is allowed', async () => {
    const token = await sign(process.env.JWT_SECRET!);
    await expect(getAuthUser(req(`${APP}/api/v1/leaves`, {
      method: 'POST', headers: { cookie: `__session=${token}`, origin: APP },
    }))).resolves.toBeDefined();
  });

  it('cookie POST from another origin is rejected (AUTH_012 / 403)', async () => {
    const token = await sign(process.env.JWT_SECRET!);
    await expect(getAuthUser(req(`${APP}/api/v1/leaves`, {
      method: 'POST', headers: { cookie: `__session=${token}`, origin: 'https://evil.example' },
    }))).rejects.toMatchObject({ code: 'AUTH_012', httpStatus: 403 });
  });

  it('cookie PATCH with no Origin and no Referer is rejected', async () => {
    const token = await sign(process.env.JWT_SECRET!);
    await expect(getAuthUser(req(`${APP}/api/v1/regularizations/x/approve`, {
      method: 'PATCH', headers: { cookie: `__session=${token}` },
    }))).rejects.toMatchObject({ code: 'AUTH_012' });
  });

  it('Sec-Fetch-Site: cross-site is rejected even with a forged same Origin', async () => {
    const token = await sign(process.env.JWT_SECRET!);
    await expect(getAuthUser(req(`${APP}/api/v1/leaves`, {
      method: 'DELETE', headers: { cookie: `__session=${token}`, origin: APP, 'sec-fetch-site': 'cross-site' },
    }))).rejects.toMatchObject({ code: 'AUTH_012' });
  });

  it('missing/invalid token → AUTH_003', async () => {
    await expect(getAuthUser(req(`${APP}/api/v1/auth/me`))).rejects.toMatchObject({ code: 'AUTH_003', httpStatus: 401 });
    await expect(getAuthUser(req(`${APP}/api/v1/auth/me`, { headers: { authorization: 'Bearer garbage' } })))
      .rejects.toMatchObject({ code: 'AUTH_003' });
  });
});

// ─── Client IP ───────────────────────────────────────────────────────────────

describe('getClientIp — forwarded headers are trusted only behind a trusted proxy', () => {
  it('ignores X-Forwarded-For when not on Vercel and no trusted proxy is configured', () => {
    delete process.env.VERCEL; delete process.env.TRUST_PROXY_HEADERS;
    expect(getClientIp(req('http://x/', { headers: { 'x-forwarded-for': '10.0.0.1' } }))).toBe('unknown');
  });

  it('on Vercel prefers x-vercel-forwarded-for over a client-supplied X-Forwarded-For', () => {
    process.env.VERCEL = '1';
    expect(getClientIp(req('http://x/', {
      headers: { 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '10.9.9.9' },
    }))).toBe('203.0.113.7');
  });

  it('rejects non-IP garbage in forwarded headers', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    expect(getClientIp(req('http://x/', { headers: { 'x-forwarded-for': '<script>, 1.2.3.4' } }))).toBe('unknown');
    expect(getClientIp(req('http://x/', { headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' } }))).toBe('198.51.100.4');
  });
});

// ─── Rate limiting during a Redis outage ─────────────────────────────────────

describe('rate limiting — Redis outage falls back to in-memory limits (not fail-open)', () => {
  beforeEach(() => __resetMemoryRateLimits());

  it('enforces the configured limit when Redis is unavailable (tests have no Redis)', async () => {
    for (let i = 0; i < authLimiter.max; i++) {
      expect((await isWithinRateLimit(authLimiter, 'ip|a@b.c')).ok).toBe(true);
    }
    const res = await checkRateLimit(authLimiter, 'ip|a@b.c');
    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toMatch(/^\d+$/);
    const body = await res!.json();
    expect(JSON.stringify(body)).not.toMatch(/a@b\.c/);
  });

  it('buckets are independent per key (colleagues on one office IP)', async () => {
    for (let i = 0; i < authLimiter.max; i++) await isWithinRateLimit(authLimiter, '1.1.1.1|alice@x.com');
    expect((await isWithinRateLimit(authLimiter, '1.1.1.1|alice@x.com')).ok).toBe(false);
    expect((await isWithinRateLimit(authLimiter, '1.1.1.1|bob@x.com')).ok).toBe(true);
  });
});
