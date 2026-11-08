import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { UpdateShiftSchema } from '@validators/settings';
import { SettingsService } from '@services/SettingsService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const p = await getAuthUser(request);
    assertAttendanceAdmin(p);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  try {
    const s = await SettingsService.getSettings();
    return success({
      workStartTime:                  s.workStartTime,
      workEndTime:                    s.workEndTime,
      halfDayLateCheckInTime:         s.halfDayLateCheckInTime,
      requiredDailyMinutes:           s.requiredDailyMinutes,
      halfDayThresholdMinutes:        s.halfDayThresholdMinutes,
      sessionAutoClosePaddingMinutes: s.sessionAutoClosePaddingMinutes,
    }, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const p = await getAuthUser(request);
    assertAttendanceAdmin(p);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return apiError('GEN_001', 'Invalid JSON body.', 400); }

  let parsed;
  try { parsed = UpdateShiftSchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', err.errors[0]?.message ?? 'Validation failed.', 400);
    throw err;
  }

  try {
    const s = await SettingsService.updateShift(parsed);
    return success({
      workStartTime:                  s.workStartTime,
      workEndTime:                    s.workEndTime,
      halfDayLateCheckInTime:         s.halfDayLateCheckInTime,
      requiredDailyMinutes:           s.requiredDailyMinutes,
      halfDayThresholdMinutes:        s.halfDayThresholdMinutes,
      sessionAutoClosePaddingMinutes: s.sessionAutoClosePaddingMinutes,
    }, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
