import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AttendanceMonthlyQuerySchema } from '@validators/attendance';
import { AttendanceService } from '@services/AttendanceService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  const { searchParams } = new URL(request.url);
  let query;
  try {
    query = AttendanceMonthlyQuerySchema.parse(Object.fromEntries(searchParams));
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  // Admin can query any employee; employee can only query self
  let targetEmployeeId = payload.userId;
  if (query.employeeId) {
    if (!isAttendanceAdmin(payload.role)) return apiError('AUTH_006', 'Forbidden.', 403);
    targetEmployeeId = query.employeeId;
  }

  try {
    const result = await AttendanceService.getMonthly(targetEmployeeId, query.yearMonth);
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
