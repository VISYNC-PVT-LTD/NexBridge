// CSRF protection — IMPLEMENTED in getAuthUser() (see docs/84 §2.6).
//
// The previous note here claimed there was "no cookie-only auth path". That was
// incorrect: getAuthUser() falls back to the HttpOnly `__session` cookie when no
// Authorization header is sent (the web portal relies on this after a reload).
//
// Cookie-authenticated state-changing requests (POST/PUT/PATCH/DELETE) must now
// carry an Origin (or Referer) matching the app origin, NEXT_PUBLIC_APP_URL or
// ALLOWED_ORIGINS, and must not be `Sec-Fetch-Site: cross-site`; otherwise
// 403 AUTH_012. Implementation: src/lib/auth/origin.ts. Bearer-token requests
// (mobile app) are unaffected.
export {};
