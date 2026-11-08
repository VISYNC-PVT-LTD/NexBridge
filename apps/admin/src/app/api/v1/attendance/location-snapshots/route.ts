import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ListLocationSnapshotsSchema } from '@validators/locationSnapshot';
import { LocationSnapshotService } from '@services/LocationSnapshotService';
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

  const sp = request.nextUrl.searchParams;
  const raw = {
    employeeId: sp.get('employeeId') ?? undefined,
    dateString: sp.get('dateString') ?? undefined,
    page:       sp.get('page') ?? undefined,
    limit:      sp.get('limit') ?? undefined,
  };

  let query;
  try {
    query = ListLocationSnapshotsSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', err.errors[0]?.message ?? 'Validation failed.', 400);
    throw err;
  }

  try {
    const result = await LocationSnapshotService.list(query);
    return success(result);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
