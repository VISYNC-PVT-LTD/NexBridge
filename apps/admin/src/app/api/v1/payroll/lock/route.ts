import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { LockPayrollSchema, UnlockPayrollSchema } from '@validators/payroll';
import { PayrollLockService } from '@services/PayrollLockService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

async function authenticate(request: NextRequest) {
  let payload;
  try { payload = await getAuthUser(request); }
  catch (err) {
    if (err instanceof AuthError) throw err;
    throw err;
  }
  try { assertAttendanceAdmin(payload); }
  catch (err) {
    if (err instanceof AppError) throw err;
    throw err;
  }
  return payload;
}

// GET /api/v1/payroll/lock?yearMonth=YYYY-MM
export async function GET(request: NextRequest): Promise<NextResponse> {
  try { await authenticate(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  const yearMonth = request.nextUrl.searchParams.get('yearMonth') ?? '';
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return apiError('GEN_001', 'yearMonth query param required (YYYY-MM).', 400);

  try {
    const status = await PayrollLockService.getStatus(yearMonth);
    return success(status, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}

// POST /api/v1/payroll/lock  { yearMonth }
export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload;
  try { payload = await authenticate(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return apiError('GEN_001', 'Invalid JSON body.', 400); }

  let parsed;
  try { parsed = LockPayrollSchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await PayrollLockService.lock({ yearMonth: parsed.yearMonth, adminId: payload.userId });
    return success(result, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}

// DELETE /api/v1/payroll/lock  { yearMonth, reason }
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  let payload;
  try { payload = await authenticate(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return apiError('GEN_001', 'Invalid JSON body.', 400); }

  let parsed;
  try { parsed = UnlockPayrollSchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await PayrollLockService.unlock({ yearMonth: parsed.yearMonth, adminId: payload.userId, reason: parsed.reason });
    return success(result, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
