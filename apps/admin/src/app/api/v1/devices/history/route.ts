import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { DeviceService } from '@services/DeviceService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({ userId: z.string().min(1) });

export async function GET(request: NextRequest): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  if (!isAttendanceAdmin(payload.role)) return apiError('AUTH_006', 'Forbidden.', 403);

  const { searchParams } = new URL(request.url);
  let parsed;
  try {
    parsed = QuerySchema.parse(Object.fromEntries(searchParams));
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await DeviceService.getDeviceHistory(parsed.userId);
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
