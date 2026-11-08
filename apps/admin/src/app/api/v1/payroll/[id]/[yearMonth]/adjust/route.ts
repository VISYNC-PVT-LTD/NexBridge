import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AdjustPayrollSchema } from '@validators/payroll';
import { PayrollService } from '@services/PayrollService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; yearMonth: string }> },
): Promise<NextResponse> {
  let payload;
  try { payload = await getAuthUser(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  try { assertAttendanceAdmin(payload); }
  catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  const { id, yearMonth } = await context.params;

  if (!/^[0-9a-f]{24}$/i.test(id)) return apiError('GEN_001', 'Invalid payroll record id.', 400);
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return apiError('GEN_001', 'Invalid yearMonth format.', 400);

  let body: unknown;
  try { body = await request.json(); }
  catch { return apiError('GEN_001', 'Invalid JSON body.', 400); }

  let parsed;
  try { parsed = AdjustPayrollSchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await PayrollService.adjustByRecordId({
      recordId:        id,
      manualDeduction: parsed.manualDeduction,
      remark:          parsed.remark ?? '',
      adminId:         payload.userId,
    });
    return success(result, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
