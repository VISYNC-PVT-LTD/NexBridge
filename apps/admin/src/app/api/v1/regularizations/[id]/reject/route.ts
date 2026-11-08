import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { RejectRegularizationSchema } from '@validators/regularization';
import { RegularizationService } from '@services/RegularizationService';
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
  try { payload = await getAuthUser(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  try { assertAttendanceAdmin(payload); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Forbidden.', err.httpStatus);
    throw err;
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { body = {}; }

  let parsed;
  try { parsed = RejectRegularizationSchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  const { id } = await params;

  try {
    const result = await RegularizationService.reject(id, payload.userId, parsed.reason);
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
