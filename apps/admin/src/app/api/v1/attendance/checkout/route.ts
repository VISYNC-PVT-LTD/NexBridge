import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CheckOutSchema } from '@validators/attendance';
import { AttendanceService } from '@services/AttendanceService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { apiError, success } from '@lib/utils/api-response';
import { attendanceLimiter, checkRateLimit, getClientIp } from '@mw/rateLimiter';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  const limitResponse = await checkRateLimit(attendanceLimiter, payload.userId);
  if (limitResponse) return limitResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('GEN_001', 'Invalid JSON body.', 400);
  }

  let parsed;
  try {
    parsed = CheckOutSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await AttendanceService.checkOut({
      employeeId: payload.userId,
      deviceFingerprintHeader: request.headers.get('X-Device-Fingerprint') ?? '',
      nonce: parsed.nonce,
      clientTimestamp: parsed.timestamp,
      clientIp: getClientIp(request),
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      accuracy: parsed.accuracy,
    });
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
