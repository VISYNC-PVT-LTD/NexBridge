/**
 * DEV / MANUAL-TEST ONLY — moves ONE test account's OPEN attendance session
 * back in time so the 24-hour missed-check-out rule (docs/85) can be tested
 * manually without waiting a day. This is a local CLI script, never an HTTP
 * endpoint, and it refuses to run unless every safety condition holds.
 *
 * Usage (against a NON-production test database only):
 *   ALLOW_TEST_CLOCK_SHIFT=yes \
 *   TEST_ACCOUNT_EMAIL_DOMAIN=test.example.com \
 *   MONGODB_URI=<test database URI> \
 *   npx tsx scripts/dev/shift-open-session.ts --email emp1@test.example.com --hours 23.98
 *
 *   --hours  how far to move the check-in back (0 < hours <= 72). Examples:
 *              23.98  → ~1 minute before the 24-hour deadline
 *              24.02  → ~1 minute after the deadline
 *
 * Safety:
 *  * requires ALLOW_TEST_CLOCK_SHIFT=yes
 *  * refuses NODE_ENV=production, VERCEL deployments and any database / host
 *    name containing "prod"
 *  * only accounts whose e-mail ends with @TEST_ACCOUNT_EMAIL_DOMAIN
 *  * only an ACTIVE session; only check-in time + its calendar day are moved
 *  * writes an AuditLog entry ("TEST_CLOCK_SHIFT") so the change is traceable
 */
import './../bootstrap-env';
import mongoose from 'mongoose';
import { formatInTimeZone } from 'date-fns-tz';
import { User } from '../../src/models/User';
import { AttendanceSession } from '../../src/models/AttendanceSession';
import { AttendanceDay } from '../../src/models/AttendanceDay';
import { CompanySettings } from '../../src/models/CompanySettings';
import { AuditLog } from '../../src/models/AuditLog';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function refuse(msg: string): never {
  console.error(`[shift-open-session] REFUSED: ${msg}`);
  process.exit(2);
}

export async function main() {
  if (process.env.ALLOW_TEST_CLOCK_SHIFT !== 'yes') refuse('set ALLOW_TEST_CLOCK_SHIFT=yes (test databases only).');
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) refuse('production / Vercel environment.');
  const uri = process.env.MONGODB_URI;
  if (!uri) refuse('MONGODB_URI is not set.');
  let host = '';
  let dbPath = '';
  try { const u = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')); host = u.hostname; dbPath = u.pathname; } catch { refuse('unparseable MONGODB_URI.'); }
  if (/prod/i.test(host) || /prod/i.test(dbPath)) refuse('database host/name looks like production.');

  const domain = process.env.TEST_ACCOUNT_EMAIL_DOMAIN;
  if (!domain) refuse('set TEST_ACCOUNT_EMAIL_DOMAIN to the domain used by test accounts.');
  const email = (arg('email') ?? '').toLowerCase();
  if (!email.endsWith(`@${domain.toLowerCase()}`)) refuse(`--email must be a test account @${domain}.`);
  const hours = Number(arg('hours'));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) refuse('--hours must be > 0 and <= 72.');

  await mongoose.connect(uri);
  try {
    const user = await User.findOne({ email }).select('_id email').lean();
    if (!user) refuse('test account not found.');
    const session = await AttendanceSession.findOne({ employeeId: user._id, isActive: true });
    if (!session) refuse('the account has no OPEN session — check in on the phone first.');
    const settings = await (CompanySettings as unknown as mongoose.Model<{ timezone?: string }>)
      .findById('company-settings').lean();
    const tz = settings?.timezone || 'Asia/Kolkata';

    const oldCheckIn = session.checkIn.timestamp;
    const newCheckIn = new Date(oldCheckIn.getTime() - hours * 3_600_000);
    const newDateString = formatInTimeZone(newCheckIn, tz, 'yyyy-MM-dd');
    const [y, m] = newDateString.split('-').map(Number);

    // Move the session to the AttendanceDay of its new calendar date.
    const oldDayId = session.attendanceDayId;
    const day = await AttendanceDay.findOneAndUpdate(
      { employeeId: user._id, dateString: newDateString },
      {
        $setOnInsert: {
          employeeId: user._id, dateString: newDateString, date: new Date(`${newDateString}T00:00:00.000Z`),
          year: y, month: m, status: 'absent', totalMinutes: 0, requiredMinutes: 540, overtimeMinutes: 0,
          isLateArrival: false, lateByMinutes: 0, isHalfDayCapped: false, isRegularized: false,
        },
      },
      { upsert: true, new: true },
    );
    session.checkIn.timestamp = newCheckIn;
    session.dateString = newDateString;
    session.attendanceDayId = day!._id as mongoose.Types.ObjectId;
    await session.save();

    // Remove the original day if it no longer has any session or minutes.
    if (String(oldDayId) !== String(day!._id)) {
      const remaining = await AttendanceSession.countDocuments({ attendanceDayId: oldDayId });
      if (remaining === 0) await AttendanceDay.deleteOne({ _id: oldDayId, totalMinutes: 0 });
    }

    await (AuditLog as unknown as mongoose.Model<Record<string, unknown>>).create({
      performedBy: user._id,
      action: 'TEST_CLOCK_SHIFT',
      targetType: 'AttendanceSession',
      targetId: String(session._id),
      changes: { hours, from: oldCheckIn.toISOString(), to: newCheckIn.toISOString(), by: 'scripts/dev/shift-open-session.ts' },
    });

    const deadline = new Date(newCheckIn.getTime() + 24 * 3_600_000);
    console.log(`[shift-open-session] ${email}: check-in moved ${hours} h back to ${newCheckIn.toISOString()} (${newDateString}).`);
    console.log(`[shift-open-session] 24-hour deadline is now ${deadline.toISOString()} (${deadline > new Date() ? 'in the future' : 'PASSED'}).`);
    console.log('[shift-open-session] Pull-to-refresh / reopen the app to see the effect.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('[shift-open-session] failed:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
