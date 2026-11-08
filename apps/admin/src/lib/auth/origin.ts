import type { NextRequest } from 'next/server';

/**
 * CSRF defence for COOKIE-authenticated, state-changing requests.
 *
 * getAuthUser() accepts the HttpOnly `__session` cookie when no Authorization
 * header is present (the web portal relies on this after a page reload, when
 * the in-memory access token is gone). SameSite=Strict already blocks most
 * cross-site cookie sends; this check is defence in depth for older browsers,
 * same-site-but-cross-origin subdomains and misconfigured cookies.
 *
 * Bearer-token requests (mobile app, web portal with in-memory token) are not
 * affected: a cross-site attacker cannot set an Authorization header without a
 * CORS preflight, and this server sends no CORS allow headers.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function allowedOrigins(request: NextRequest): Set<string> {
  const set = new Set<string>();
  const self = originOf(request.nextUrl?.origin ?? request.url);
  if (self) set.add(self);
  const app = originOf(process.env.NEXT_PUBLIC_APP_URL);
  if (app) set.add(app);
  for (const o of (process.env.ALLOWED_ORIGINS ?? '').split(',')) {
    const parsed = originOf(o.trim());
    if (parsed) set.add(parsed);
  }
  return set;
}

export function isStateChangingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * True when a cookie-authenticated request may proceed.
 * Safe methods always pass. Unsafe methods need an Origin (or, failing that,
 * Referer) header naming an allowed origin, and must not be marked cross-site.
 */
export function cookieRequestOriginAllowed(request: NextRequest): boolean {
  if (!isStateChangingMethod(request.method)) return true;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = originOf(request.headers.get('origin')) ?? originOf(request.headers.get('referer'));
  if (!origin) return false;
  return allowedOrigins(request).has(origin);
}
