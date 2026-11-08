import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { RejectLeaveSchema } from '@validators/leave';
import { LeaveService } from '@services/LeaveService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
    assertAttendanceAdmin(payload);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  let body: unknown = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }

  let parsed;
  try { parsed = RejectLeaveSchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  const { id } = await params;
  try {
    const result = await LeaveService.reject(id, payload.userId, parsed.reason);
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
