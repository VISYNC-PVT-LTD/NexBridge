import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ResetPasswordSchema } from '@validators/auth';
import { AuthService, AppError } from '@services/AuthService';
import { passwordResetConfirmLimiter, getClientIp, checkRateLimit } from '@mw/rateLimiter';
import { success, apiError } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);
  const limited = await checkRateLimit(passwordResetConfirmLimiter, ip);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('GEN_001', 'Invalid JSON body.', 400);
  }

  let parsed;
  try {
    parsed = ResetPasswordSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    await AuthService.confirmPasswordReset(parsed.email, parsed.token, parsed.newPassword, ip, request.headers.get('user-agent') ?? '');
    return success({ message: 'Password updated successfully. Please log in again.' });
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
