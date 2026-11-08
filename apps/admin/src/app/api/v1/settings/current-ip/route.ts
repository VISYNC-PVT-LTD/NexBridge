import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { AppError } from '@services/AuthService';
import { apiError, success } from '@lib/utils/api-response';
import { getClientIp } from '@mw/rateLimiter';

export const dynamic = 'force-dynamic';

function classifyIp(ip: string): {
  ipVersion: 'ipv4' | 'ipv6' | 'local' | 'private';
  isUsableForOfficeIp: boolean;
  message: string | null;
} {
  // IPv6 (includes loopback ::1)
  if (ip.includes(':')) {
    return {
      ipVersion: 'ipv6',
      isUsableForOfficeIp: false,
      message: ip === '::1'
        ? 'Localhost detected (::1). This address cannot be used for attendance check-in validation. Open the deployed admin site from office WiFi to detect the office public IP, or enter it manually.'
        : 'IPv6 address detected. Office IP validation requires IPv4. Open the deployed admin site from office WiFi, or enter your office public IPv4 manually.',
    };
  }
  // IPv4 loopback
  if (ip === '127.0.0.1') {
    return {
      ipVersion: 'local',
      isUsableForOfficeIp: false,
      message: 'Localhost (127.0.0.1) detected. Open the deployed admin site from office WiFi to detect the office public IPv4, or enter it manually.',
    };
  }
  // Private IPv4 ranges (RFC 1918)
  if (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  ) {
    return {
      ipVersion: 'private',
      isUsableForOfficeIp: false,
      message: 'Private network IP detected. This is an internal address and will not work for attendance check-in validation. Use your office public IPv4 (check whatismyip.com from office WiFi).',
    };
  }
  // Public IPv4
  return { ipVersion: 'ipv4', isUsableForOfficeIp: true, message: null };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await getAuthUser(request);
    assertAttendanceAdmin(payload);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  const ip = getClientIp(request);
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp    = request.headers.get('x-real-ip');
  const source    = forwarded ? 'x-forwarded-for' : realIp ? 'x-real-ip' : 'fallback';
  const { ipVersion, isUsableForOfficeIp, message } = classifyIp(ip);

  return success({ currentIp: ip, ipVersion, isUsableForOfficeIp, source, message }, 200);
}
