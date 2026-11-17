import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { LeaveBalancesListQuerySchema } from '@validators/leave';
import { LeaveService } from '@services/LeaveService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/leaves/balances — HR admins only.
 * Every employee's leave balances for the admin "Leave Balances" page.
 * (GET /leaves/balance, singular, stays the per-employee endpoint used by mobile.)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
    assertAttendanceAdmin(payload);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  let query;
  try { query = LeaveBalancesListQuerySchema.parse(sp); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await LeaveService.listBalances(query);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
