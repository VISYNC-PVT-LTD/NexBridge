import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@lib/auth/jwt';
import { WORK_DESK_ROLES, ATTENDANCE_ADMIN_ROLES } from '@constants/roles';
import type { UserRole } from '@app-types/enums';

// Any authenticated role may reach these — no per-role restriction.
const ANY_AUTHENTICATED_PATHS = ['/', '/dashboard', '/profile', '/notifications', '/change-password'];

// Ordered most-specific-first; first matching prefix wins. Anything that
// matches no prefix here is default-denied (see proxy() below) — a new page
// must be added here explicitly, it is never silently public.
const PAGE_ROLE_MAP: { prefix: string; roles: UserRole[] }[] = [
  { prefix: '/desk', roles: WORK_DESK_ROLES },
  { prefix: '/settings', roles: ATTENDANCE_ADMIN_ROLES },
  { prefix: '/attendance', roles: ATTENDANCE_ADMIN_ROLES },
  { prefix: '/payroll', roles: ATTENDANCE_ADMIN_ROLES },
  // Remaining HR/admin pages — same admin-only posture as settings/attendance/
  // payroll above (this is what the pre-regression blanket admin-only gate
  // already enforced for these; kept as-is, not part of the Work Desk fix).
  { prefix: '/employees', roles: ATTENDANCE_ADMIN_ROLES },
  { prefix: '/leave', roles: ATTENDANCE_ADMIN_ROLES },
  { prefix: '/regularization', roles: ATTENDANCE_ADMIN_ROLES },
  { prefix: '/reports', roles: ATTENDANCE_ADMIN_ROLES },
  { prefix: '/devices', roles: ATTENDANCE_ADMIN_ROLES },
  { prefix: '/audit-logs', roles: ATTENDANCE_ADMIN_ROLES },
];

const PUBLIC_PATHS = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/unauthorized',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/password-reset/request',
  '/api/v1/auth/password-reset/confirm',
  '/api/v1/auth/device-request',
];

const PASSWORD_CHANGE_ALLOWED = [
  '/change-password',
  '/api/v1/auth/me/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
];

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // matches login/refresh route cookie TTL

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|cron|admin\\/cron|health).*)'],
};

// Shared with route handlers: previous key only with an explicit, short expiry
// and never for expired tokens (see lib/auth/jwt.ts).
const verifyJwt = verifyAccessToken;

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// __rt cookie value is `${sessionId}:${refreshToken}` — both hex strings, ':' is a safe separator.
async function attemptInlineRefresh(
  request: NextRequest,
): Promise<{ accessToken: string; rtCookie: string | null } | null> {
  const rt = request.cookies.get('__rt')?.value;
  if (!rt) return null;
  const sep = rt.indexOf(':');
  if (sep === -1) return null;
  const sessionId = rt.slice(0, sep);
  const refreshToken = rt.slice(sep + 1);
  if (!sessionId || !refreshToken) return null;

  try {
    const res = await fetch(new URL('/api/v1/auth/refresh', request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, sessionId }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { accessToken?: string; refreshToken?: string } };
    if (!json.data?.accessToken) return null;
    // Refresh tokens rotate: the server-side fetch's Set-Cookie never reaches
    // the browser, so forward the new token into the __rt cookie ourselves.
    return {
      accessToken: json.data.accessToken,
      rtCookie: json.data.refreshToken ? `${sessionId}:${json.data.refreshToken}` : null,
    };
  } catch {
    return null;
  }
}

function evaluateAuthorized(
  payload: Record<string, unknown>,
  pathname: string,
  isApi: boolean,
  requestUrl: string,
): NextResponse | null {
  if (
    payload.requiresPasswordChange &&
    !PASSWORD_CHANGE_ALLOWED.some((p) => pathname.startsWith(p))
  ) {
    if (isApi) {
      return NextResponse.json(
        { success: false, error: { code: 'AUTH_010', message: 'Password change required.' } },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL('/change-password', requestUrl));
  }

  // Page-level role authorization. API routes are gated separately by each
  // route's own assertRole check (data-level); this gates which PAGES a role
  // may load at all, independent of whether the data calls on that page 403.
  if (!isApi && !ANY_AUTHENTICATED_PATHS.some((p) => (p === '/' ? pathname === '/' : pathname.startsWith(p)))) {
    const rule = PAGE_ROLE_MAP.find((r) => pathname.startsWith(r.prefix));
    const role = payload.role as UserRole;
    if (!rule || !rule.roles.includes(role)) {
      return NextResponse.redirect(new URL('/unauthorized', requestUrl));
    }
  }

  if (process.env.MAINTENANCE_MODE === 'true' && !isApi) {
    return NextResponse.rewrite(new URL('/maintenance.html', requestUrl));
  }

  return null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check __session cookie (set on login/refresh) for page routes;
  // fall back to Authorization header for API routes.
  const token =
    request.cookies.get('__session')?.value ??
    request.headers.get('Authorization')?.replace('Bearer ', '');

  if (token) {
    try {
      const payload = await verifyJwt(token);
      const denied = evaluateAuthorized(payload, pathname, isApi, request.url);
      return denied ?? NextResponse.next();
    } catch {
      // Access token invalid/expired — fall through to the inline refresh.
    }
  }

  // No usable access token. The __session cookie's maxAge equals the access
  // token TTL, so once it expires the browser DROPS the cookie and `token` is
  // undefined — the refresh must be attempted in that case too, otherwise every
  // page load after 15 idle minutes bounces a still-valid session to /login.
  const refreshed = await attemptInlineRefresh(request);
  if (refreshed) {
    const newAccessToken = refreshed.accessToken;
    try {
      const payload = await verifyJwt(newAccessToken);
      const denied = evaluateAuthorized(payload, pathname, isApi, request.url);
      const response = denied ?? NextResponse.next();
      response.cookies.set('__session', newAccessToken, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: ACCESS_TOKEN_TTL_SECONDS,
      });
      if (refreshed.rtCookie) {
        response.cookies.set('__rt', refreshed.rtCookie, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          secure: process.env.NODE_ENV === 'production',
          maxAge: REFRESH_TOKEN_TTL_SECONDS,
        });
      }
      return response;
    } catch {
      // fall through to the redirect/401 below
    }
  }

  if (isApi) {
    return NextResponse.json(
      { success: false, error: { code: 'AUTH_003', message: 'Unauthorized.' } },
      { status: 401 },
    );
  }
  return NextResponse.redirect(new URL('/login', request.url));
}
