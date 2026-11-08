import { NextRequest, NextResponse } from 'next/server';
import { SettingsService } from '@services/SettingsService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const p = await getAuthUser(request);
    assertAttendanceAdmin(p);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  const { id } = await context.params;

  try {
    await SettingsService.deleteHoliday(id);
    return success({ message: 'Holiday deleted.' }, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
