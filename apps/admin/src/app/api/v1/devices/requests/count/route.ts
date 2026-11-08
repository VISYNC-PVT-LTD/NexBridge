import { NextRequest, NextResponse } from 'next/server';
import { DeviceService } from '@services/DeviceService';
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

  if (!isAttendanceAdmin(payload.role)) return apiError('AUTH_006', 'Forbidden.', 403);

  const count = await DeviceService.countPendingRequests();
  return success({ count });
}
