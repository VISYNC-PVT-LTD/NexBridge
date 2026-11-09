/**
 * @jest-environment node
 *
 * Regression (found in local web testing): after 15 idle minutes the browser
 * drops the __session cookie (its maxAge == access-token TTL), and proxy.ts
 * redirected every page load to /login WITHOUT trying the still-valid __rt
 * refresh cookie — the inline refresh only ran for a present-but-expired token.
 */
import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { proxy } from '@/proxy';

const BASE = 'http://localhost:3000';
const fetchMock = jest.fn<typeof fetch>();

// Real HS256 tokens signed with the (dummy) test JWT_SECRET — same as request-security.test.ts.
async function sign(exp: string | number) {
  return new SignJWT({ userId: '507f1f77bcf86cd799439011', role: 'admin', requiresPasswordChange: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
}

let freshAccess = '';
let expiredAccess = '';
beforeAll(async () => {
  freshAccess = await sign('15m');
  expiredAccess = await sign(Math.floor(Date.now() / 1000) - 60);
});

function refreshOk() {
  fetchMock.mockResolvedValue(new Response(
    JSON.stringify({ success: true, data: { accessToken: freshAccess, refreshToken: 'rotated-rt' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('proxy — page loads after the access cookie has expired', () => {
  it('no __session but a valid __rt: refreshes inline and serves the page (no /login bounce)', async () => {
    refreshOk();
    const res = await proxy(new NextRequest(`${BASE}/regularization`, { headers: { cookie: '__rt=sess1:old-rt' } }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`${BASE}/api/v1/auth/refresh`);
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'old-rt', sessionId: 'sess1' });

    expect(res.headers.get('location')).toBeNull();          // not redirected
    expect(res.cookies.get('__session')?.value).toBe(freshAccess);
    expect(res.cookies.get('__rt')?.value).toBe('sess1:rotated-rt');
  });

  it('expired __session plus valid __rt: still refreshes inline (existing behaviour)', async () => {
    refreshOk();
    const res = await proxy(new NextRequest(`${BASE}/regularization`, { headers: { cookie: `__session=${expiredAccess}; __rt=sess1:old-rt` } }));
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get('__session')?.value).toBe(freshAccess);
  });

  it('no cookies at all: redirects to /login without calling refresh', async () => {
    const res = await proxy(new NextRequest(`${BASE}/regularization`));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(`${BASE}/login`);
  });

  it('refresh rejected (revoked session): redirects to /login', async () => {
    fetchMock.mockResolvedValue(new Response('{"success":false}', { status: 401 }));
    const res = await proxy(new NextRequest(`${BASE}/regularization`, { headers: { cookie: '__rt=sess1:revoked' } }));
    expect(res.headers.get('location')).toBe(`${BASE}/login`);
    expect(res.cookies.get('__session')).toBeUndefined();
  });

  it('API request with no token and no refresh cookie: 401 JSON, no refresh call', async () => {
    const res = await proxy(new NextRequest(`${BASE}/api/v1/leaves`));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
