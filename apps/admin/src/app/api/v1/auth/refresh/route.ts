import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { RefreshSchema } from '@validators/auth';
import { cookieRequestOriginAllowed } from '@lib/auth/origin';

export const dynamic = 'force-dynamic';
import { AuthService, AppError } from '@services/AuthService';
import { success, apiError } from '@lib/utils/api-response';
import { refreshLimiter, refreshSessionLimiter, getClientIp, checkRateLimit } from '@mw/rateLimiter';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);
  const limited = await checkRateLimit(refreshLimiter, ip);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('GEN_001', 'Invalid JSON body.', 400);
  }

  // Web portal: the browser sends an empty body and the server uses the
  // HttpOnly `__rt` cookie, which the proxy and this route keep in sync as the
  // token rotates (a JS-held copy would go stale). Same-origin only (CSRF).
  // Mobile and other clients keep sending { refreshToken, sessionId }.
  const hasBodyToken =
    typeof body === 'object' && body !== null && 'refreshToken' in body && 'sessionId' in body;
  if (!hasBodyToken) {
    const rt = request.cookies.get('__rt')?.value ?? '';
    const sep = rt.indexOf(':');
    if (sep <= 0 || !cookieRequestOriginAllowed(request)) {
      return apiError('AUTH_003', 'Unauthorized.', 401);
    }
    body = { sessionId: rt.slice(0, sep), refreshToken: rt.slice(sep + 1) };
  }

  let parsed;
  try {
    parsed = RefreshSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  const sessionLimited = await checkRateLimit(refreshSessionLimiter, parsed.sessionId);
  if (sessionLimited) return sessionLimited;

  try {
    const result = await AuthService.refresh(
      parsed.refreshToken,
      parsed.sessionId,
      ip,
      request.headers.get('user-agent') ?? '',
    );
    const res = success(result);
    // Rotate __session cookie so Edge Middleware continues to accept page-route requests
    res.cookies.set('__session', result.accessToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });
    // Rotated refresh token → keep the web proxy's HttpOnly copy in sync.
    res.cookies.set('__rt', `${parsed.sessionId}:${result.refreshToken}`, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
    return res;
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
