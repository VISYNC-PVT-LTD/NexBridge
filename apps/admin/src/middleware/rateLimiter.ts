import { Ratelimit } from '@upstash/ratelimit';
import { isIP } from 'net';
import { redis } from '@lib/redis/client';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Rate limiting.
 *
 * Primary store: Upstash Redis (shared across serverless instances).
 * Fallback: if Redis errors or is unreachable, a per-instance in-memory sliding
 * window with the SAME limits is applied instead of failing open. This keeps
 * brute-force protection on login / reset / refresh during a Redis outage
 * while never blocking legitimate traffic harder than the configured limits.
 * (Per-instance means the effective limit during an outage is
 * limit × number of warm instances — weaker, but not disabled.)
 */

export interface LimiterDef {
  name: string;
  max: number;
  windowMs: number;
  ratelimit: Ratelimit;
}

type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];

function makeLimiter(name: string, max: number, window: Duration, windowMs: number): LimiterDef {
  return {
    name,
    max,
    windowMs,
    ratelimit: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(max, window), prefix: `rl:${name}` }),
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

// Login: keyed by `ip|email`. Users sharing an office NAT IP do not consume
// each other's budget; a single account is protected by loginAccountLimiter.
export const authLimiter = makeLimiter('auth', 10, '1 m', MIN);
// Per-account ceiling across all IPs (distributed guessing).
export const loginAccountLimiter = makeLimiter('auth-acct', 20, '15 m', 15 * MIN);
// Per-IP ceiling across all accounts (password spraying). Generous for offices.
export const loginIpLimiter = makeLimiter('auth-ip', 100, '1 m', MIN);

export const passwordResetLimiter = makeLimiter('pwd-reset', 3, '1 h', HOUR);
// Reset confirmation (token guessing): per IP.
export const passwordResetConfirmLimiter = makeLimiter('pwd-reset-confirm', 10, '15 m', 15 * MIN);
// Change password: per authenticated user (not IP — offices share IPs).
export const changePasswordLimiter = makeLimiter('chg-pwd', 5, '15 m', 15 * MIN);

export const attendanceLimiter = makeLimiter('attendance', 60, '1 m', MIN);
export const deviceRequestLimiter = makeLimiter('device-req', 3, '24 h', 24 * HOUR);

// Refresh: per IP (generous for a shared office IP: ~100 phones refreshing every
// 15 minutes is ~7/min) plus per session to stop a single token being hammered.
export const refreshLimiter = makeLimiter('refresh', 120, '1 m', MIN);
export const refreshSessionLimiter = makeLimiter('refresh-sess', 10, '1 m', MIN);

// 20/hr per userId — prevents regularization submission spam
export const regularizationLimiter = makeLimiter('reg', 20, '1 h', HOUR);

// ── Client IP ────────────────────────────────────────────────────────────────

function firstValidIp(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim() ?? '';
  return isIP(first) ? first : null;
}

/**
 * Client IP used for rate limiting, audit hashing and office-IP attendance.
 *
 * Forwarding headers are client-controllable unless a trusted proxy rewrites
 * them, so they are trusted only when the deployment says so:
 *  - On Vercel (VERCEL=1): Vercel overwrites X-Forwarded-For / X-Real-IP and
 *    does not forward external values (docs: "Request headers"). We prefer
 *    x-vercel-forwarded-for, which a proxy placed IN FRONT of Vercel cannot
 *    overwrite. DEPLOYMENT CHECK: if a CDN/proxy is ever placed in front of
 *    Vercel, re-verify this assumption.
 *  - Elsewhere: only when TRUST_PROXY_HEADERS=true (set this ONLY behind a
 *    reverse proxy that overwrites X-Forwarded-For).
 *  - Otherwise 'unknown' — rate limits then share one bucket and office-IP
 *    attendance validation denies (fail-closed).
 */
export function getClientIp(request: NextRequest): string {
  const h = request.headers;
  if (process.env.VERCEL === '1') {
    return (
      firstValidIp(h.get('x-vercel-forwarded-for')) ??
      firstValidIp(h.get('x-real-ip')) ??
      firstValidIp(h.get('x-forwarded-for')) ??
      'unknown'
    );
  }
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    return firstValidIp(h.get('x-forwarded-for')) ?? firstValidIp(h.get('x-real-ip')) ?? 'unknown';
  }
  return 'unknown';
}

// ── In-memory fallback ───────────────────────────────────────────────────────

const memoryBuckets = new Map<string, number[]>();
const MAX_MEMORY_KEYS = 10_000;

function memoryLimit(def: LimiterDef, key: string, now = Date.now()): { success: boolean; reset: number } {
  const k = `${def.name}:${key}`;
  const windowStart = now - def.windowMs;
  const hits = (memoryBuckets.get(k) ?? []).filter((t) => t > windowStart);
  if (hits.length >= def.max) {
    memoryBuckets.set(k, hits);
    return { success: false, reset: hits[0] + def.windowMs };
  }
  hits.push(now);
  if (!memoryBuckets.has(k) && memoryBuckets.size >= MAX_MEMORY_KEYS) {
    const oldest = memoryBuckets.keys().next().value;
    if (oldest !== undefined) memoryBuckets.delete(oldest);
  }
  memoryBuckets.set(k, hits);
  return { success: true, reset: now + def.windowMs };
}

/** Test helper — clears the in-memory fallback buckets. */
export function __resetMemoryRateLimits(): void {
  memoryBuckets.clear();
}

/** Returns true when the request is within limits. Never throws. */
export async function isWithinRateLimit(def: LimiterDef, key: string): Promise<{ ok: boolean; reset: number }> {
  try {
    const r = await def.ratelimit.limit(key);
    return { ok: r.success, reset: r.reset };
  } catch {
    const r = memoryLimit(def, key);
    return { ok: r.success, reset: r.reset };
  }
}

export function rateLimitedResponse(reset: number): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return NextResponse.json(
    { success: false, error: { code: 'GEN_003', message: 'Too many requests. Please try again later.' } },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}

export async function checkRateLimit(def: LimiterDef, key: string): Promise<NextResponse | null> {
  const { ok, reset } = await isWithinRateLimit(def, key);
  return ok ? null : rateLimitedResponse(reset);
}

/** Checks several limiters; returns the first 429 response, or null. */
export async function checkRateLimits(checks: Array<[LimiterDef, string]>): Promise<NextResponse | null> {
  for (const [def, key] of checks) {
    const limited = await checkRateLimit(def, key);
    if (limited) return limited;
  }
  return null;
}
