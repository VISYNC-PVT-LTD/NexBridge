import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { LoginSchema } from '@validators/auth';

export const dynamic = 'force-dynamic';
import { AuthService, AppError } from '@services/AuthService';
import { authLimiter, loginAccountLimiter, loginIpLimiter, getClientIp, checkRateLimits } from '@mw/rateLimiter';
import { success, apiError } from '@lib/utils/api-response';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes — matches JWT expiry
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // matches DeviceSession sliding expiresAt

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('GEN_001', 'Invalid JSON body.', 400);
  }

  let parsed;
  try {
    parsed = LoginSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return apiError('GEN_001', 'Validation failed.', 400);
    }
    throw err;
  }

  // Keyed per ip+account, per account and per IP so colleagues behind one
  // office IP do not lock each other out, while one account cannot be
  // brute-forced from many IPs. Same 429 whether or not the account exists.
  const emailKey = parsed.email.toLowerCase().trim();
  const limited = await checkRateLimits([
    [authLimiter, `${ip}|${emailKey}`],
    [loginAccountLimiter, emailKey],
    [loginIpLimiter, ip],
  ]);
  if (limited) return limited;

  try {
    const result = await AuthService.login(
      parsed.email,
      parsed.password,
      parsed.deviceFingerprint,
      ip,
      request.headers.get('user-agent') ?? '',
    );
    const res = success(result);
    // Set __session cookie so Edge Middleware can validate page-route access
    res.cookies.set('__session', result.accessToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });
    // Additive: mirrors the refresh token (already returned in the response body
    // for the mobile app) into an HttpOnly cookie so the web proxy can silently
    // refresh expired sessions without bouncing the user to /login.
    res.cookies.set('__rt', `${result.sessionId}:${result.refreshToken}`, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
    return res;
  } catch (err) {
    if (err instanceof AppError) {
      return apiError(err.code, err.message, err.httpStatus);
    }
    throw err;
  }
}
