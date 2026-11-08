import { NextRequest } from 'next/server';
import type { JwtPayload } from '@app-types/jwt';
import { AppError } from '@lib/errors/app-error';
import { verifyAccessToken } from '@lib/auth/jwt';
import { cookieRequestOriginAllowed } from '@lib/auth/origin';

/**
 * Authentication / authorization failure. Extends AppError so every route's
 * `if (err instanceof AppError)` handler returns a proper 401/403 instead of
 * re-throwing it as a 500 (previously the case for role checks wrapped in an
 * AppError-only catch, e.g. GET /payroll and /reports/* for non-admins).
 */
export class AuthError extends AppError {
  constructor(code: string, httpStatus: number) {
    super(code, httpStatus, httpStatus === 403 ? 'Forbidden.' : 'Unauthorized.');
  }
}

/**
 * Authenticates a route-handler request.
 *
 * Token sources, in order:
 *  1. `Authorization: Bearer <access token>` (mobile app; web portal while the
 *     in-memory token is present).
 *  2. HttpOnly `__session` cookie (web portal after reload). For state-changing
 *     methods this path additionally requires a same-origin Origin/Referer
 *     (CSRF defence) — otherwise AUTH_012 / 403.
 */
export async function getAuthUser(request: NextRequest): Promise<JwtPayload> {
  const authHeader = request.headers.get('Authorization');
  let token: string | undefined;
  let fromCookie = false;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    token = request.cookies.get('__session')?.value;
    fromCookie = true;
  }

  if (!token) throw new AuthError('AUTH_003', 401);

  if (fromCookie && !cookieRequestOriginAllowed(request)) {
    throw new AuthError('AUTH_012', 403);
  }

  let payload: JwtPayload;
  try {
    payload = (await verifyAccessToken(token)) as unknown as JwtPayload;
  } catch {
    throw new AuthError('AUTH_003', 401);
  }
  if (typeof payload.userId !== 'string' || typeof payload.role !== 'string') {
    throw new AuthError('AUTH_003', 401);
  }
  return payload;
}
