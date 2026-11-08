import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AttendanceAdminListQuerySchema } from '@validators/attendance';
import { AttendanceService } from '@services/AttendanceService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { apiError } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  if (!isAttendanceAdmin(payload.role)) return apiError('AUTH_006', 'Forbidden.', 403);

  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  let query;
  try {
    query = AttendanceAdminListQuerySchema.parse(sp);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await AttendanceService.adminList(query);
    return NextResponse.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
