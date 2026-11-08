import { jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';

/**
 * Access-token verification shared by route handlers (requireAuth) and the
 * page proxy (proxy.ts).
 *
 * Key-rotation policy for JWT_SECRET_PREVIOUS (security fix):
 *  - The previous key is accepted ONLY when JWT_SECRET_PREVIOUS_EXPIRES_AT is
 *    set to a valid timestamp that is in the future and no more than
 *    MAX_PREVIOUS_KEY_WINDOW_MS ahead. Without an explicit, short expiry the
 *    previous key is ignored, so a compromised old key can never remain trusted
 *    indefinitely because someone forgot to delete the variable.
 *  - The previous key is tried only when the current key's SIGNATURE fails. An
 *    expired token is never "rescued" by the previous key.
 *  - A previous key equal to the current key is ignored.
 *  - If the previous key is known or suspected to be compromised, do NOT set
 *    JWT_SECRET_PREVIOUS at all; accept that all users re-authenticate.
 */

export const MAX_PREVIOUS_KEY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h

function encode(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function previousKeyIfAllowed(now: number = Date.now()): string | null {
  const prev = process.env.JWT_SECRET_PREVIOUS;
  const until = process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT;
  if (!prev || !until) return null;
  if (prev === process.env.JWT_SECRET) return null;
  const untilMs = Date.parse(until);
  if (Number.isNaN(untilMs)) return null;
  if (untilMs <= now) return null;
  if (untilMs - now > MAX_PREVIOUS_KEY_WINDOW_MS) return null;
  return prev;
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const current = process.env.JWT_SECRET;
  if (!current) throw new Error('JWT_SECRET is not configured');
  try {
    const { payload } = await jwtVerify(token, encode(current), { algorithms: ['HS256'] });
    return payload;
  } catch (err) {
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      const prev = previousKeyIfAllowed();
      if (prev) {
        const { payload } = await jwtVerify(token, encode(prev), { algorithms: ['HS256'] });
        return payload;
      }
    }
    throw err;
  }
}
