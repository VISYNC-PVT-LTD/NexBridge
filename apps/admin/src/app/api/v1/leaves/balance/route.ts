import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { LeaveBalanceQuerySchema } from '@validators/leave';
import { LeaveService } from '@services/LeaveService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let payload;
  try { payload = await getAuthUser(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  let query;
  try { query = LeaveBalanceQuerySchema.parse(sp); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  if (!isAttendanceAdmin(payload.role) && query.employeeId && query.employeeId !== payload.userId) {
    return apiError('AUTH_006', 'Access denied.', 403);
  }

  try {
    const result = await LeaveService.getBalance(payload.userId, payload.role, query.employeeId);
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
