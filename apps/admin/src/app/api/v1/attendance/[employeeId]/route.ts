import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AttendanceHistoryQuerySchema } from '@validators/attendance';
import { AttendanceService } from '@services/AttendanceService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { apiError } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ employeeId: string }> },
): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  if (!isAttendanceAdmin(payload.role)) return apiError('AUTH_006', 'Forbidden.', 403);

  const { employeeId } = await context.params;

  const { searchParams } = new URL(request.url);
  let query;
  try {
    query = AttendanceHistoryQuerySchema.parse(Object.fromEntries(searchParams));
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await AttendanceService.getHistory(employeeId, query);
    return NextResponse.json({ success: true, data: result.data, meta: result.meta });
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
