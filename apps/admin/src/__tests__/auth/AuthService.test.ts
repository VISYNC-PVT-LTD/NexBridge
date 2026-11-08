import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';

Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

import { AuthService, REFRESH_RETRY_GRACE_MS } from '@services/AuthService';
import { User } from '@models/User';
import { DeviceSession } from '@models/DeviceSession';
import { PasswordResetToken } from '@models/PasswordResetToken';
import { AuditLog } from '@models/AuditLog';
import { sendEmail } from '@lib/email/brevo';
import { sealToken } from '@lib/auth/token-seal';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const USER_OID = new mongoose.Types.ObjectId();
const SESSION_OID = new mongoose.Types.ObjectId();

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: USER_OID,
    employeeId: 'EMP001',
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    role: 'admin',
    isActive: true,
    requiresPasswordChange: false,
    passwordHash: 'stored-hash',
    registeredDevice: null,
    toObject() { return { ...this }; },
    ...overrides,
  };
}

function selectable<T>(value: T) {
  return { select: jest.fn().mockResolvedValue(value as never) } as never;
}

const txSession = {
  withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
  endSession: jest.fn(async () => undefined),
};

beforeEach(() => {
  jest.spyOn(AuditLog, 'create').mockResolvedValue({} as never);
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(txSession as unknown as mongoose.ClientSession);
  jest.spyOn(bcrypt, 'hash').mockImplementation((async () => 'new-hash') as never);
});

afterEach(() => {
  jest.restoreAllMocks();
  (sendEmail as unknown as jest.Mock).mockClear();
});

// ─── Login ────────────────────────────────────────────────────────────────────

describe('AuthService.login — enumeration resistance', () => {
  it('unknown email: AUTH_001 and still performs a bcrypt comparison (timing)', async () => {
    jest.spyOn(User, 'findOne').mockReturnValue(selectable(null));
    const compare = jest.spyOn(bcrypt, 'compare').mockImplementation((async () => false) as never);
    await expect(AuthService.login('nobody@example.com', 'whatever1', undefined, '1.2.3.4', 'ua'))
      .rejects.toMatchObject({ code: 'AUTH_001', httpStatus: 401 });
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('deactivated account + WRONG password returns AUTH_001, not AUTH_007', async () => {
    jest.spyOn(User, 'findOne').mockReturnValue(selectable(makeUser({ isActive: false })));
    jest.spyOn(bcrypt, 'compare').mockImplementation((async () => false) as never);
    await expect(AuthService.login('jane@example.com', 'wrongpass', undefined, 'ip', 'ua'))
      .rejects.toMatchObject({ code: 'AUTH_001' });
  });

  it('deactivated account + correct password returns AUTH_007', async () => {
    jest.spyOn(User, 'findOne').mockReturnValue(selectable(makeUser({ isActive: false })));
    jest.spyOn(bcrypt, 'compare').mockImplementation((async () => true) as never);
    await expect(AuthService.login('jane@example.com', 'rightpass', undefined, 'ip', 'ua'))
      .rejects.toMatchObject({ code: 'AUTH_007' });
  });

  it('normalises email case before lookup', async () => {
    const findOne = jest.spyOn(User, 'findOne').mockReturnValue(selectable(null));
    jest.spyOn(bcrypt, 'compare').mockImplementation((async () => false) as never);
    await AuthService.login('  Jane@Example.COM ', 'x'.repeat(8), undefined, 'ip', 'ua').catch(() => undefined);
    expect(findOne).toHaveBeenCalledWith({ email: 'jane@example.com' });
  });
});

// ─── Refresh rotation & reuse detection ──────────────────────────────────────

describe('AuthService.refresh — rotation and reuse detection', () => {
  const CURRENT = 'a'.repeat(64);
  const PREVIOUS = 'b'.repeat(64);

  function makeSession(overrides: Record<string, unknown> = {}) {
    return {
      _id: SESSION_OID,
      employeeId: USER_OID,
      refreshTokenHash: sha(CURRENT),
      previousRefreshTokenHash: sha(PREVIOUS),
      rotatedAt: new Date(),
      pendingRefreshTokenEnc: sealToken(CURRENT),
      isRevoked: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      ...overrides,
    };
  }

  function mockSession(session: unknown) {
    jest.spyOn(DeviceSession, 'findById').mockReturnValue(selectable(session));
  }

  it('rejects a malformed session id without a DB CastError', async () => {
    await expect(AuthService.refresh(CURRENT, 'not-an-object-id')).rejects.toMatchObject({ code: 'AUTH_003' });
  });

  it('current token rotates: returns a NEW refresh token and stores only hashes', async () => {
    mockSession(makeSession());
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    const update = jest.spyOn(DeviceSession, 'findOneAndUpdate').mockResolvedValue({} as never);

    const result = await AuthService.refresh(CURRENT, SESSION_OID.toHexString());

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.refreshToken).not.toBe(CURRENT);
    const [filter, change] = update.mock.calls[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(filter).toMatchObject({ refreshTokenHash: sha(CURRENT), isRevoked: false });
    expect(change.$set.refreshTokenHash).toBe(sha(result.refreshToken));
    expect(change.$set.previousRefreshTokenHash).toBe(sha(CURRENT));
    expect(JSON.stringify(change)).not.toContain(result.refreshToken);
  });

  it('previous token within the grace window returns the SAME current token (lost-response retry)', async () => {
    mockSession(makeSession({ rotatedAt: new Date(Date.now() - 60_000) }));
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser() as never);
    const rotate = jest.spyOn(DeviceSession, 'findOneAndUpdate');

    const result = await AuthService.refresh(PREVIOUS, SESSION_OID.toHexString());
    expect(result.refreshToken).toBe(CURRENT);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('previous token AFTER the grace window revokes the session (reuse detected)', async () => {
    mockSession(makeSession({ rotatedAt: new Date(Date.now() - REFRESH_RETRY_GRACE_MS - 1000) }));
    const revoke = jest.spyOn(DeviceSession, 'updateOne').mockResolvedValue({} as never);

    await expect(AuthService.refresh(PREVIOUS, SESSION_OID.toHexString())).rejects.toMatchObject({ code: 'AUTH_003' });
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ _id: SESSION_OID }),
      { $set: expect.objectContaining({ isRevoked: true, revokedReason: 'refresh-reuse' }) },
    );
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTH_REFRESH_REUSE_DETECTED' }));
  });

  it('within grace but unreadable retry copy (key rotated) → 401 without revocation', async () => {
    mockSession(makeSession({ rotatedAt: new Date(), pendingRefreshTokenEnc: 'v1.garbage.x.y' }));
    const revoke = jest.spyOn(DeviceSession, 'updateOne');
    await expect(AuthService.refresh(PREVIOUS, SESSION_OID.toHexString())).rejects.toMatchObject({ code: 'AUTH_003' });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('an unknown token is a plain 401 and does not revoke anything', async () => {
    mockSession(makeSession());
    const revoke = jest.spyOn(DeviceSession, 'updateOne');
    await expect(AuthService.refresh('c'.repeat(64), SESSION_OID.toHexString())).rejects.toMatchObject({ code: 'AUTH_003' });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revoked session is rejected', async () => {
    mockSession(makeSession({ isRevoked: true }));
    await expect(AuthService.refresh(CURRENT, SESSION_OID.toHexString())).rejects.toMatchObject({ code: 'AUTH_003' });
  });

  it('deactivated user: session revoked and AUTH_007', async () => {
    mockSession(makeSession());
    jest.spyOn(User, 'findById').mockResolvedValue(makeUser({ isActive: false }) as never);
    const revoke = jest.spyOn(DeviceSession, 'updateOne').mockResolvedValue({} as never);
    await expect(AuthService.refresh(CURRENT, SESSION_OID.toHexString())).rejects.toMatchObject({ code: 'AUTH_007' });
    expect(revoke).toHaveBeenCalledWith(expect.anything(), { $set: expect.objectContaining({ revokedReason: 'deactivated' }) });
  });
});

// ─── Password reset ──────────────────────────────────────────────────────────

describe('AuthService.requestPasswordReset', () => {
  it('invalidates older unused tokens, stores a hashed IP, and never the raw token', async () => {
    jest.spyOn(User, 'findOne').mockResolvedValue(makeUser() as never);
    const invalidate = jest.spyOn(PasswordResetToken, 'updateMany').mockResolvedValue({} as never);
    const create = jest.spyOn(PasswordResetToken, 'create').mockResolvedValue({} as never);

    await AuthService.requestPasswordReset('jane@example.com', '203.0.113.9');

    expect(invalidate).toHaveBeenCalledWith({ userId: USER_OID, isUsed: false }, expect.anything());
    const doc = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(doc.ipAddress).not.toBe('203.0.113.9');
    expect(String(doc.tokenHash)).toMatch(/^[0-9a-f]{64}$/);
    // The emailed link contains the raw token; the DB has only its hash.
    const html = ((sendEmail as unknown as jest.Mock).mock.calls[0][0] as { htmlContent: string }).htmlContent;
    const raw = /token=([0-9a-f]{64})/.exec(html)![1];
    expect(sha(raw)).toBe(doc.tokenHash);
    expect(html).toContain('15 minutes');
  });

  it('deactivated account: no token, no email', async () => {
    jest.spyOn(User, 'findOne').mockResolvedValue(makeUser({ isActive: false }) as never);
    const create = jest.spyOn(PasswordResetToken, 'create');
    await AuthService.requestPasswordReset('jane@example.com', 'ip');
    expect(create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('email provider failure is swallowed (generic response preserved)', async () => {
    jest.spyOn(User, 'findOne').mockResolvedValue(makeUser() as never);
    jest.spyOn(PasswordResetToken, 'updateMany').mockResolvedValue({} as never);
    jest.spyOn(PasswordResetToken, 'create').mockResolvedValue({} as never);
    (sendEmail as unknown as jest.Mock).mockImplementationOnce(async () => { throw new Error('provider down'); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(AuthService.requestPasswordReset('jane@example.com', 'ip')).resolves.toBeUndefined();
    expect(JSON.stringify(errSpy.mock.calls)).not.toMatch(/token=|jane@example\.com/);
  });
});

describe('AuthService.confirmPasswordReset — single use', () => {
  const RAW = 'd'.repeat(64);
  const TOKEN_OID = new mongoose.Types.ObjectId();
  function tokenDoc(overrides: Record<string, unknown> = {}) {
    return {
      _id: TOKEN_OID, userId: USER_OID, email: 'jane@example.com', tokenHash: sha(RAW),
      isUsed: false, expiresAt: new Date(Date.now() + 600_000), ...overrides,
    };
  }

  beforeEach(() => {
    jest.spyOn(User, 'findById').mockReturnValue(selectable(makeUser()));
    jest.spyOn(bcrypt, 'compare').mockImplementation((async () => false) as never);
  });

  it('looks the token up by its hash (an older link cannot resurface)', async () => {
    const findOne = jest.spyOn(PasswordResetToken, 'findOne').mockResolvedValue(null as never);
    await expect(AuthService.confirmPasswordReset('jane@example.com', RAW, 'NewPass123'))
      .rejects.toMatchObject({ code: 'AUTH_008' });
    expect(findOne).toHaveBeenCalledWith({ tokenHash: sha(RAW), isUsed: false });
  });

  it('token for a different email is rejected', async () => {
    jest.spyOn(PasswordResetToken, 'findOne').mockResolvedValue(tokenDoc() as never);
    await expect(AuthService.confirmPasswordReset('other@example.com', RAW, 'NewPass123'))
      .rejects.toMatchObject({ code: 'AUTH_008' });
  });

  it('expired token → AUTH_009', async () => {
    jest.spyOn(PasswordResetToken, 'findOne').mockResolvedValue(tokenDoc({ expiresAt: new Date(Date.now() - 1) }) as never);
    await expect(AuthService.confirmPasswordReset('jane@example.com', RAW, 'NewPass123'))
      .rejects.toMatchObject({ code: 'AUTH_009' });
  });

  it('deactivated user cannot use an outstanding link', async () => {
    jest.spyOn(PasswordResetToken, 'findOne').mockResolvedValue(tokenDoc() as never);
    jest.spyOn(User, 'findById').mockReturnValue(selectable(makeUser({ isActive: false })));
    await expect(AuthService.confirmPasswordReset('jane@example.com', RAW, 'NewPass123'))
      .rejects.toMatchObject({ code: 'AUTH_008' });
  });

  it('concurrent use: losing claim aborts before the password is changed', async () => {
    jest.spyOn(PasswordResetToken, 'findOne').mockResolvedValue(tokenDoc() as never);
    jest.spyOn(PasswordResetToken, 'findOneAndUpdate').mockResolvedValue(null as never);
    const userUpdate = jest.spyOn(User, 'updateOne');
    await expect(AuthService.confirmPasswordReset('jane@example.com', RAW, 'NewPass123'))
      .rejects.toMatchObject({ code: 'AUTH_008' });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('success: atomic claim, all other links invalidated, every session revoked', async () => {
    jest.spyOn(PasswordResetToken, 'findOne').mockResolvedValue(tokenDoc() as never);
    const claim = jest.spyOn(PasswordResetToken, 'findOneAndUpdate').mockResolvedValue(tokenDoc({ isUsed: true }) as never);
    jest.spyOn(User, 'updateOne').mockResolvedValue({} as never);
    const others = jest.spyOn(PasswordResetToken, 'updateMany').mockResolvedValue({} as never);
    const sessions = jest.spyOn(DeviceSession, 'updateMany').mockResolvedValue({} as never);

    await AuthService.confirmPasswordReset('jane@example.com', RAW, 'NewPass123');

    expect(claim.mock.calls[0][0]).toMatchObject({ _id: TOKEN_OID, isUsed: false });
    expect(others).toHaveBeenCalledWith({ userId: USER_OID, isUsed: false }, expect.anything(), expect.anything());
    expect(sessions).toHaveBeenCalledWith(
      { employeeId: USER_OID, isRevoked: false },
      { $set: expect.objectContaining({ revokedReason: 'password-reset' }) },
      expect.anything(),
    );
  });
});

// ─── Change password ─────────────────────────────────────────────────────────

describe('AuthService.changePassword', () => {
  beforeEach(() => {
    jest.spyOn(User, 'findById').mockReturnValue(selectable(makeUser()));
    jest.spyOn(User, 'updateOne').mockResolvedValue({} as never);
    jest.spyOn(PasswordResetToken, 'updateMany').mockResolvedValue({} as never);
  });

  it('wrong current password → AUTH_001, nothing revoked', async () => {
    jest.spyOn(bcrypt, 'compare').mockImplementation((async () => false) as never);
    const sessions = jest.spyOn(DeviceSession, 'updateMany');
    await expect(AuthService.changePassword(USER_OID.toHexString(), 'bad', 'NewPass123', 'ip', 'ua'))
      .rejects.toMatchObject({ code: 'AUTH_001' });
    expect(sessions).not.toHaveBeenCalled();
  });

  it('keeps the caller session and revokes all others', async () => {
    jest.spyOn(bcrypt, 'compare')
      .mockImplementationOnce((async () => true) as never)   // current password ok
      .mockImplementationOnce((async () => false) as never); // new != old
    jest.spyOn(DeviceSession, 'findOne').mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: SESSION_OID } as never) } as never);
    const sessions = jest.spyOn(DeviceSession, 'updateMany').mockResolvedValue({} as never);

    const result = await AuthService.changePassword(USER_OID.toHexString(), 'OldPass123', 'NewPass123', 'ip', 'ua', SESSION_OID.toHexString());

    expect(result.currentSessionKept).toBe(true);
    expect(sessions.mock.calls[0][0]).toEqual({ employeeId: USER_OID, isRevoked: false, _id: { $ne: SESSION_OID } });
  });

  it('without a session id every session is revoked and the result says so', async () => {
    jest.spyOn(bcrypt, 'compare')
      .mockImplementationOnce((async () => true) as never)
      .mockImplementationOnce((async () => false) as never);
    const sessions = jest.spyOn(DeviceSession, 'updateMany').mockResolvedValue({} as never);
    const result = await AuthService.changePassword(USER_OID.toHexString(), 'OldPass123', 'NewPass123', 'ip', 'ua');
    expect(result.currentSessionKept).toBe(false);
    expect(sessions.mock.calls[0][0]).toEqual({ employeeId: USER_OID, isRevoked: false });
  });
});
