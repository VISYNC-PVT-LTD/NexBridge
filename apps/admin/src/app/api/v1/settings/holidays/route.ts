import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CreateHolidaySchema } from '@validators/settings';
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

  const yearParam = request.nextUrl.searchParams.get('year');
  const year = yearParam ? parseInt(yearParam, 10) : undefined;
  if (yearParam && (isNaN(year!) || year! < 2000 || year! > 2100)) {
    return apiError('GEN_001', 'Invalid year parameter.', 400);
  }

  try {
    const holidays = await SettingsService.listHolidays(year);
    return success({ data: holidays, meta: { total: holidays.length } }, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
    assertAttendanceAdmin(payload);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return apiError('GEN_001', 'Invalid JSON body.', 400); }

  let parsed;
  try { parsed = CreateHolidaySchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', err.errors[0]?.message ?? 'Validation failed.', 400);
    throw err;
  }

  try {
    const holiday = await SettingsService.createHoliday(parsed, payload.userId);
    return success(holiday, 201);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
