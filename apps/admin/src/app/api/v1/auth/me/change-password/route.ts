import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ChangePasswordSchema } from '@validators/auth';
import { AuthService, AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { changePasswordLimiter, getClientIp, checkRateLimit } from '@mw/rateLimiter';
import { success, apiError } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);

  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  // Per user, not per IP (offices share IPs).
  const limited = await checkRateLimit(changePasswordLimiter, payload.userId);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('GEN_001', 'Invalid JSON body.', 400);
  }

  let parsed;
  try {
    parsed = ChangePasswordSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await AuthService.changePassword(
      payload.userId,
      parsed.currentPassword,
      parsed.newPassword,
      ip,
      request.headers.get('user-agent') ?? '',
      parsed.sessionId,
    );
    const res = success({
      message: result.currentSessionKept
        ? 'Password changed successfully. Other devices have been logged out.'
        : 'Password changed successfully. All sessions have been logged out; please sign in again on other devices.',
      accessToken: result.accessToken,
      currentSessionKept: result.currentSessionKept,
    });
    // Replace the page-auth cookie: the old token still says
    // requiresPasswordChange=true and would bounce the user back here.
    res.cookies.set('__session', result.accessToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 15 * 60,
    });
    return res;
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
