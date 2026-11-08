import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { SettingsService } from '@services/SettingsService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError, success } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

const MonthlySlabSchema = z.object({
  upToGross: z.number().min(0),
  amount:    z.number().min(0),
});

const StatutoryBodySchema = z.object({
  enabled: z.boolean(),
  pf: z.object({
    enabled:      z.boolean(),
    employeeRate: z.number().min(0).max(100),
    employerRate: z.number().min(0).max(100),
    wagesCeiling: z.number().min(0),
  }),
  esic: z.object({
    enabled:      z.boolean(),
    employeeRate: z.number().min(0).max(100),
    employerRate: z.number().min(0).max(100),
    wagesCeiling: z.number().min(0),
  }),
  pt: z.object({
    enabled:      z.boolean(),
    state:        z.string().max(50),
    monthlySlabs: z.array(MonthlySlabSchema),
  }),
  tds: z.object({
    enabled:  z.boolean(),
    flatRate: z.number().min(0).max(100),
  }),
});

async function getAdmin(request: NextRequest) {
  const payload = await getAuthUser(request);
  assertAttendanceAdmin(payload);
  return payload;
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
    return success(s.statutoryConfig ?? {
      enabled: false,
      pf:   { enabled: false, employeeRate: 12,   employerRate: 12,   wagesCeiling: 15000 },
      esic: { enabled: false, employeeRate: 0.75, employerRate: 3.25, wagesCeiling: 21000 },
      pt:   { enabled: false, state: '', monthlySlabs: [] },
      tds:  { enabled: false, flatRate: 10 },
    }, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
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
  try { parsed = StatutoryBodySchema.parse(body); }
  catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }

  try {
    const updated = await SettingsService.updateStatutory(parsed);
    return success(updated, 200);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
