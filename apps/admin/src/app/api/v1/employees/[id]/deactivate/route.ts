import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { DeactivateEmployeeSchema } from '@validators/employee';
import { EmployeeService } from '@services/EmployeeService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { success, apiError } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function PATCH(
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

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // body is optional
  }

  let parsed;
  try {
    parsed = DeactivateEmployeeSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await EmployeeService.deactivate(id, parsed.reason, payload.userId);
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
