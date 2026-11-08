import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

/**
 * Seals a raw refresh token (AES-256-GCM) so the server can return the SAME
 * current token to a client that retries a refresh with the token that was
 * just rotated out (lost network response). Only hashes are used for lookup;
 * the sealed copy is never usable without the server key.
 *
 * Key: HKDF-SHA256 over JWT_REFRESH_SECRET (falls back to JWT_SECRET).
 * Rotating JWT_REFRESH_SECRET only invalidates in-flight retry copies — the
 * affected clients get a 401 on a lost-response retry and must sign in again.
 */

function key(): Buffer {
  const material = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  if (!material) throw new Error('No refresh sealing key configured');
  return Buffer.from(hkdfSync('sha256', material, 'genesis-refresh-seal', 'v1', 32));
}

export function sealToken(raw: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
}

export function unsealToken(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
