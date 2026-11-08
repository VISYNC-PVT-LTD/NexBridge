import { NextRequest, NextResponse } from 'next/server';
import { formatInTimeZone } from 'date-fns-tz';
import { AttendanceService } from '@services/AttendanceService';
import { CompanySettings } from '@models/CompanySettings';
import type { ICompanySettings } from '@models/CompanySettings';
import { SystemEvent } from '@models/SystemEvent';
import { connectDB } from '@lib/db/connect';
import { CRON_NAMES } from '@constants/cron-names';
import { assertCronAuth } from '@mw/cronGuard';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = assertCronAuth(request);
  if (authError) return authError;

  await connectDB();

  const settings = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
  const timezone = settings?.timezone ?? 'Asia/Kolkata';
  const now = new Date();
  const dateString = formatInTimeZone(now, timezone, 'yyyy-MM-dd');

  // 24-hour missed-check-out sweep (docs/85). Unlike the previous per-date job
  // this is NOT skipped when it already ran today: it is idempotent, so a late,
  // repeated or concurrent run is harmless and catches anything that became
  // overdue since the last run. Request paths also reconcile, so a delayed
  // cron never delays what users see.
  const { expired } = await AttendanceService.reconcileMissedCheckouts(now);

  // Record the run (upsert — the eventType+date index is unique).
  await SystemEvent.updateOne(
    { eventType: CRON_NAMES.SESSION_AUTO_CLOSE, date: dateString },
    {
      $set: { status: 'completed', completedAt: now },
      $inc: { 'meta.runs': 1, 'meta.sessionsExpired': expired },
    },
    { upsert: true },
  );

  return NextResponse.json({
    success: true,
    jobName: CRON_NAMES.SESSION_AUTO_CLOSE,
    triggeredAt: now.toISOString(),
    dateString,
    sessionsExpired: expired,
  });
}

// Vercel Cron invokes the configured path with an HTTP GET carrying
// `Authorization: Bearer <CRON_SECRET>` (Vercel docs: Managing Cron Jobs).
// POST is kept for manual/admin triggering. Both run the same authenticated,
// idempotent handler.
export const GET = POST;
