import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Validates Vercel Cron / admin trigger authorization.
 * Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
 * Returns a 401 NextResponse if unauthorized; null if authorized.
 */
export function assertCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured on server.' },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // Constant-time comparison (hash both sides so lengths always match).
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(secret).digest();
  if (!token || !timingSafeEqual(a, b)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized.' },
      { status: 401 },
    );
  }

  return null;
}
