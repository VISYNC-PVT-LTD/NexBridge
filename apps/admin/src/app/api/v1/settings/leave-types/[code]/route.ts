import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { UpdateLeaveTypeSchema, LEAVE_TYPE_CODES } from '@validators/settings';
import type { LeaveTypeCode } from '@validators/settings';
import { SettingsService } from '@services/SettingsService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  try {
    const p = await getAuthUser(request);
    assertAttendanceAdmin(p);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  const { code } = await context.params;
  if (!(LEAVE_TYPE_CODES as readonly string[]).includes(code)) {
    return apiError('GEN_002', `Invalid leave type code. Must be one of: ${LEAVE_TYPE_CODES.join(', ')}.`, 400);
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return apiError('GEN_001', 'Invalid JSON body.', 400); }

  let parsed;
  try { parsed = UpdateLeaveTypeSchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', err.errors[0]?.message ?? 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await SettingsService.updateLeaveType(code as LeaveTypeCode, parsed);
    return success(result, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
