import { NextRequest, NextResponse } from 'next/server';
import { formatInTimeZone } from 'date-fns-tz';
import { LeaveBalanceService } from '@services/LeaveBalanceService';
import { CompanySettings } from '@models/CompanySettings';
import { SystemEvent } from '@models/SystemEvent';
import { connectDB } from '@lib/db/connect';
import { CRON_NAMES } from '@constants/cron-names';
import type { ICompanySettings } from '@models/CompanySettings';
import { assertCronAuth } from '@mw/cronGuard';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = assertCronAuth(request);
  if (authError) return authError;

  await connectDB();

  const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
  const timezone            = settings?.timezone ?? 'Asia/Kolkata';
  const leaveYearStartMonth = settings?.leaveYearStartMonth ?? 1;

  const now      = new Date();
  const nowLocal = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
  const year     = Number(nowLocal.slice(0, 4));
  const month    = Number(nowLocal.slice(5, 7));

  const leaveYear = month >= leaveYearStartMonth ? year : year - 1;

  const existing = await SystemEvent.findOne({
    eventType: CRON_NAMES.LEAVE_YEAR_ALLOCATION,
    date:      String(leaveYear),
    status:    'completed',
  }).lean();

  if (existing) {
    return NextResponse.json({
      success:  true,
      jobName:  CRON_NAMES.LEAVE_YEAR_ALLOCATION,
      skipped:  true,
      reason:   'already-completed',
      leaveYear,
    });
  }

  const { allocated, skipped } = await LeaveBalanceService.allocateLeaveYear(leaveYear);

  await SystemEvent.create({
    eventType:   CRON_NAMES.LEAVE_YEAR_ALLOCATION,
    date:        String(leaveYear),
    status:      'completed',
    completedAt: now,
    meta:        { allocated, skipped },
  });

  return NextResponse.json({
    success:     true,
    jobName:     CRON_NAMES.LEAVE_YEAR_ALLOCATION,
    triggeredAt: now.toISOString(),
    leaveYear,
    allocated,
    skipped,
  });
}

// Vercel Cron invokes the configured path with an HTTP GET carrying
// `Authorization: Bearer <CRON_SECRET>` (Vercel docs: Managing Cron Jobs).
// POST is kept for manual/admin triggering. Both run the same authenticated,
// idempotent handler.
export const GET = POST;
