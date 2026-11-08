import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { UpdateCompanySchema } from '@validators/settings';
import { SettingsService } from '@services/SettingsService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

async function getAdmin(request: NextRequest) {
  try {
    const payload = await getAuthUser(request);
    assertAttendanceAdmin(payload);
    return payload;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (err instanceof AppError) throw err;
    throw err;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try { await getAdmin(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  try {
    const s = await SettingsService.getSettings();
    return success({
      companyName:                   s.companyName,
      timezone:                      s.timezone,
      currency:                      s.currency,
      lateArrivalGraceMinutes:       s.lateArrivalGraceMinutes,
      leaveYearStartMonth:           s.leaveYearStartMonth,
      regularizationLookbackDays:    s.regularizationLookbackDays,
      payrollCutoffDay:              s.payrollCutoffDay,
      attendanceReminderEnabled:     s.attendanceReminderEnabled,
      attendanceReminderTime:        s.attendanceReminderTime,
      gpsAccuracyThresholdMeters:    s.gpsAccuracyThresholdMeters,
      checkinTimestampWindowMinutes: s.checkinTimestampWindowMinutes,
    }, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try { await getAdmin(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return apiError('GEN_001', 'Invalid JSON body.', 400); }

  let parsed;
  try { parsed = UpdateCompanySchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', err.errors[0]?.message ?? 'Validation failed.', 400);
    throw err;
  }

  try {
    const s = await SettingsService.updateCompany(parsed);
    return success({
      companyName:                   s.companyName,
      timezone:                      s.timezone,
      currency:                      s.currency,
      lateArrivalGraceMinutes:       s.lateArrivalGraceMinutes,
      leaveYearStartMonth:           s.leaveYearStartMonth,
      regularizationLookbackDays:    s.regularizationLookbackDays,
      payrollCutoffDay:              s.payrollCutoffDay,
      attendanceReminderEnabled:     s.attendanceReminderEnabled,
      attendanceReminderTime:        s.attendanceReminderTime,
      gpsAccuracyThresholdMeters:    s.gpsAccuracyThresholdMeters,
      checkinTimestampWindowMinutes: s.checkinTimestampWindowMinutes,
    }, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
