import { NextRequest, NextResponse } from 'next/server';
import { AuditService } from '@services/AuditService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  if (!isAttendanceAdmin(payload.role)) return apiError('AUTH_006', 'Forbidden.', 403);

  const { id } = await context.params;

  try {
    const data = await AuditService.getById(id);
    return success(data);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
