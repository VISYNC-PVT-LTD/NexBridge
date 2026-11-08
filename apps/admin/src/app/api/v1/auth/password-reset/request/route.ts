import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ForgotPasswordSchema } from '@validators/auth';
import { AuthService } from '@services/AuthService';
import { passwordResetLimiter, getClientIp, isWithinRateLimit } from '@mw/rateLimiter';
import { success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

const ALWAYS_OK = { message: 'If that email is registered, a reset link has been sent.' };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return success(ALWAYS_OK);
  }

  let parsed;
  try {
    parsed = ForgotPasswordSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return success(ALWAYS_OK);
    throw err;
  }

  const emailKey = `email:${parsed.email.toLowerCase()}`;
  const ipKey = `ip:${ip}`;

  // Never throws (Redis outage → per-instance fallback limits). Over-limit
  // requests get the same generic response, so limits reveal nothing.
  const [emailCheck, ipCheck] = await Promise.all([
    isWithinRateLimit(passwordResetLimiter, emailKey),
    isWithinRateLimit(passwordResetLimiter, ipKey),
  ]);

  if (!emailCheck.ok || !ipCheck.ok) return success(ALWAYS_OK);

  try {
    await AuthService.requestPasswordReset(parsed.email, ip);
  } catch {
    // Swallowed — enumeration prevention requires always returning OK
  }

  return success(ALWAYS_OK);
}
