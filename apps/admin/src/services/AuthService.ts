import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
import { SignJWT } from 'jose';
import mongoose from 'mongoose';
import { connectDB } from '@lib/db/connect';
import { sendEmail } from '@lib/email/brevo';
import { sha256, hashIpAddress, timingSafeEqualHex } from '@lib/utils/hash';
import { getAppUrl } from '@lib/utils/app-url';
import { sealToken, unsealToken } from '@lib/auth/token-seal';
import { AppError } from '@lib/errors/app-error';
import { User } from '@models/User';
import { DeviceSession } from '@models/DeviceSession';
import { PasswordResetToken } from '@models/PasswordResetToken';
import { FcmToken } from '@models/FcmToken';
import { AuditLog } from '@models/AuditLog';
import type { IUser } from '@models/User';

// bcrypt hash of a random value nobody knows — used only to spend the same
// CPU time on unknown-email logins as on wrong-password logins. Computed once
// per instance (same cost factor as real password hashes).
let dummyHashPromise: Promise<string> | null = null;
function dummyBcryptHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash(randomBytes(16).toString('hex'), 12);
  return dummyHashPromise;
}

/** Grace window in which a just-rotated refresh token may be replayed (lost response). */
export const REFRESH_RETRY_GRACE_MS = 60 * 60 * 1000; // 1 h — see docs/84
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

// Re-exported for the many existing `import { AppError } from '@services/AuthService'`.
export { AppError };

async function signAccessToken(user: IUser): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  return new SignJWT({
    userId: (user._id as mongoose.Types.ObjectId).toHexString(),
    role: user.role,
    requiresPasswordChange: user.requiresPasswordChange,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

function detectPlatform(userAgent: string): 'android' | 'ios' | 'web' {
  const ua = userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'ios';
  return 'web';
}

async function writeAuditLog(
  performedBy: mongoose.Types.ObjectId,
  action: string,
  targetId: string,
  ip: string,
  userAgent: string,
): Promise<void> {
  await AuditLog.create({ performedBy, action, targetType: 'User', targetId, ipAddress: ip, userAgent });
}

function passwordResetEmailHtml(firstName: string, resetUrl: string): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
    <tr>
      <td style="background:#1d4ed8;padding:32px 40px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Genesis Workforce</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:40px;">
        <p style="margin:0 0 16px;color:#111827;font-size:16px;font-weight:600;">Hello ${firstName},</p>
        <p style="margin:0 0 16px;color:#6b7280;font-size:15px;line-height:1.7;">
          We received a request to reset your password. Click the button below to create a new password.
          This link expires in <strong style="color:#374151;">15 minutes</strong>.
        </p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${resetUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 36px;border-radius:6px;">
            Reset Password
          </a>
        </div>
        <div style="background:#f9fafb;border-radius:6px;padding:16px;margin-top:8px;">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${resetUrl}" style="color:#1d4ed8;word-break:break-all;font-size:12px;">${resetUrl}</a>
          </p>
        </div>
        <hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
          If you did not request a password reset, ignore this email — your password will not change.<br>
          Never share this link with anyone.
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#f9fafb;padding:16px 40px;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">© ${year} Genesis Workforce. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export class AuthService {
  static async login(
    email: string,
    password: string,
    deviceFingerprint: string | undefined,
    ip: string,
    userAgent: string,
  ) {
    await connectDB();

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash');
    if (!user) {
      // Equalise timing with the wrong-password path so response time does not
      // reveal whether the account exists.
      await bcrypt.compare(password, await dummyBcryptHash());
      throw new AppError('AUTH_001', 401);
    }

    // Password is verified BEFORE account status, so the "deactivated" answer
    // (AUTH_007) is only ever revealed to someone who already knows the password.
    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) throw new AppError('AUTH_001', 401);

    if (!user.isActive) throw new AppError('AUTH_007', 401);

    // Work Desk / HR web-portal roles (admin, super_admin, manager, executive) bypass
    // device fingerprint checks — the web login form never collects one.
    // Mobile employee logins always require a registered device + matching fingerprint.
    if (user.role === 'employee') {
      // NOTE: AUTH_004 is overloaded — here it means "employee has no registeredDevice
      // on file"; in AttendanceService.checkIn it means "malformed fingerprint header
      // on the request". Same code, different meaning depending on call site. Not
      // split this phase (attendance scope) — noted for 30.10.
      if (!user.registeredDevice) throw new AppError('AUTH_004', 401);
      if (!deviceFingerprint) throw new AppError('AUTH_005', 401);
      const fingerprintHash = sha256(deviceFingerprint);
      if (fingerprintHash !== user.registeredDevice.fingerprintHash) {
        throw new AppError('AUTH_005', 401);
      }
    }

    const rawRefreshToken = generateRefreshToken();
    const refreshTokenHash = sha256(rawRefreshToken);
    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const session = await DeviceSession.create({
      employeeId: user._id,
      refreshTokenHash,
      deviceFingerprint: deviceFingerprint ?? null,
      deviceInfo: (userAgent || 'unknown').slice(0, 500),
      platform: detectPlatform(userAgent),
      expiresAt,
      absoluteExpiresAt,
      lastUsedAt: now,
      ipAddressHash: hashIpAddress(ip),
    });

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });

    const accessToken = await signAccessToken(user);

    await writeAuditLog(
      user._id as mongoose.Types.ObjectId,
      'AUTH_LOGIN',
      (user._id as mongoose.Types.ObjectId).toHexString(),
      ip,
      userAgent,
    );

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      sessionId: (session._id as mongoose.Types.ObjectId).toHexString(),
      employee: {
        id: (user._id as mongoose.Types.ObjectId).toHexString(),
        employeeId: user.employeeId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        requiresPasswordChange: user.requiresPasswordChange,
      },
    };
  }

  /**
   * Refresh-token rotation with reuse detection.
   *
   *  - Presenting the CURRENT token rotates it: a new random refresh token is
   *    issued and returned (`refreshToken` in the response). The mobile client
   *    and web client store it; old clients that ignore it keep working until
   *    the grace window ends (they will then be asked to sign in again).
   *  - Presenting the token that was JUST rotated out, within
   *    REFRESH_RETRY_GRACE_MS, is treated as a lost-response retry or a
   *    concurrent refresh: the same current token is returned (idempotent),
   *    nothing rotates.
   *  - Presenting the rotated-out token AFTER the grace window is treated as
   *    token theft/replay: the whole session is revoked and audited.
   *  - Anything else is a plain 401.
   *  - Deactivated users: session revoked, AUTH_007.
   */
  static async refresh(
    refreshToken: string,
    sessionId: string,
    ip = 'unknown',
    userAgent = '',
  ): Promise<{ accessToken: string; refreshToken: string }> {
    await connectDB();

    if (!mongoose.isValidObjectId(sessionId)) throw new AppError('AUTH_003', 401);
    const session = await DeviceSession.findById(sessionId).select('+pendingRefreshTokenEnc');
    if (!session) throw new AppError('AUTH_003', 401);

    if (session.isRevoked) throw new AppError('AUTH_003', 401);

    const now = new Date();
    if (session.expiresAt < now) throw new AppError('AUTH_002', 401);
    if (session.absoluteExpiresAt < now) throw new AppError('AUTH_002', 401);

    const providedHash = sha256(refreshToken);
    const isCurrent = timingSafeEqualHex(providedHash, session.refreshTokenHash);
    const isPrevious =
      !isCurrent &&
      !!session.previousRefreshTokenHash &&
      timingSafeEqualHex(providedHash, session.previousRefreshTokenHash);

    if (!isCurrent && !isPrevious) throw new AppError('AUTH_003', 401);

    if (isPrevious) {
      const rotatedAt = session.rotatedAt?.getTime() ?? 0;
      const withinGrace = now.getTime() - rotatedAt <= REFRESH_RETRY_GRACE_MS;
      const current = withinGrace ? unsealToken(session.pendingRefreshTokenEnc) : null;
      if (withinGrace && !current) {
        // Retry copy unreadable (e.g. JWT_REFRESH_SECRET was rotated): not
        // evidence of theft — plain 401, the client signs in again.
        throw new AppError('AUTH_003', 401);
      }
      if (!current) {
        // Replay of a rotated-out token outside the grace window → assume theft.
        await DeviceSession.updateOne(
          { _id: session._id, isRevoked: false },
          { $set: { isRevoked: true, revokedAt: now, revokedReason: 'refresh-reuse' } },
        );
        await writeAuditLog(session.employeeId, 'AUTH_REFRESH_REUSE_DETECTED', session.employeeId.toHexString(), ip, userAgent);
        throw new AppError('AUTH_003', 401);
      }
      const user = await User.findById(session.employeeId);
      if (!user) throw new AppError('AUTH_003', 401);
      if (!user.isActive) {
        await DeviceSession.updateOne({ _id: session._id }, { $set: { isRevoked: true, revokedAt: now, revokedReason: 'deactivated' } });
        throw new AppError('AUTH_007', 401);
      }
      const accessToken = await signAccessToken(user);
      return { accessToken, refreshToken: current };
    }

    const user = await User.findById(session.employeeId);
    if (!user) throw new AppError('AUTH_003', 401);
    if (!user.isActive) {
      await DeviceSession.updateOne({ _id: session._id }, { $set: { isRevoked: true, revokedAt: now, revokedReason: 'deactivated' } });
      throw new AppError('AUTH_007', 401);
    }

    const newRefreshToken = generateRefreshToken();
    const newExpiry = new Date(
      Math.min(now.getTime() + 30 * 24 * 60 * 60 * 1000, session.absoluteExpiresAt.getTime()),
    );
    // Conditional on the hash we validated: of two concurrent rotations of the
    // same current token, only one wins; the loser falls back to the grace path.
    const rotated = await DeviceSession.findOneAndUpdate(
      { _id: session._id, isRevoked: false, refreshTokenHash: session.refreshTokenHash },
      {
        $set: {
          refreshTokenHash: sha256(newRefreshToken),
          previousRefreshTokenHash: session.refreshTokenHash,
          rotatedAt: now,
          pendingRefreshTokenEnc: sealToken(newRefreshToken),
          expiresAt: newExpiry,
          lastUsedAt: now,
        },
      },
      { new: true },
    );
    if (!rotated) {
      // Lost the race to a concurrent refresh of the same token — retry once;
      // the token is now "previous" and resolves through the grace path.
      return AuthService.refresh(refreshToken, sessionId, ip, userAgent);
    }

    const accessToken = await signAccessToken(user);
    return { accessToken, refreshToken: newRefreshToken };
  }

  static async logout(sessionId: string, userId: string, ip: string, userAgent: string) {
    await connectDB();

    if (!mongoose.isValidObjectId(sessionId)) return;
    const session = await DeviceSession.findById(sessionId);
    if (!session) return;

    if (session.employeeId.toHexString() !== userId) {
      throw new AppError('AUTH_006', 403);
    }

    await DeviceSession.updateOne(
      { _id: session._id },
      { $set: { isRevoked: true, revokedAt: new Date(), revokedReason: 'logout' } },
    );

    await writeAuditLog(
      session.employeeId,
      'AUTH_LOGOUT',
      userId,
      ip,
      userAgent,
    );
  }

  static async requestPasswordReset(email: string, ip: string): Promise<void> {
    await connectDB();

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // Unknown and deactivated accounts get no email; the caller always returns
    // the same generic response, so account existence is not revealed.
    if (!user || !user.isActive) return;

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    // Only the newest link works: invalidate every earlier unused reset/invite
    // token for this user before issuing a new one.
    await PasswordResetToken.updateMany(
      { userId: user._id, isUsed: false },
      { $set: { isUsed: true, usedAt: new Date() } },
    );

    await PasswordResetToken.create({
      userId: user._id,
      email: user.email,
      tokenHash,
      expiresAt,
      ipAddress: hashIpAddress(ip), // never store the raw IP
    });

    const appUrl = getAppUrl();
    const resetUrl = `${appUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

    try {
      await sendEmail({
        to: { email: user.email, name: `${user.firstName} ${user.lastName}` },
        subject: 'Reset your Genesis Workforce password',
        htmlContent: passwordResetEmailHtml(user.firstName, resetUrl),
      });
    } catch {
      // Non-fatal — enumeration prevention requires always returning OK.
      // The token stays valid for its 15-minute life; the user can request a
      // new link. Nothing about the failure (or the link) is logged.
      console.error('[auth] password reset email delivery failed');
    }
  }

  static async confirmPasswordReset(email: string, rawToken: string, newPassword: string, ip = 'unknown', userAgent = '') {
    await connectDB();

    // AUTH_008 = token invalid / already used / wrong email; AUTH_009 = expired.
    // Lookup is by token HASH (never "latest token for this email"), so an older
    // link can never become valid again after a newer one is used.
    const providedHash = createHash('sha256').update(rawToken).digest('hex');
    const tokenRecord = await PasswordResetToken.findOne({ tokenHash: providedHash, isUsed: false });

    if (!tokenRecord || !timingSafeEqualHex(providedHash, tokenRecord.tokenHash)) {
      throw new AppError('AUTH_008', 400);
    }
    if (tokenRecord.email !== email.toLowerCase().trim()) throw new AppError('AUTH_008', 400);
    if (tokenRecord.expiresAt < new Date()) throw new AppError('AUTH_009', 400);

    const user = await User.findById(tokenRecord.userId).select('+passwordHash');
    if (!user || !user.isActive) throw new AppError('AUTH_008', 400);

    const same = await bcrypt.compare(newPassword, user.passwordHash);
    if (same) throw new AppError('GEN_001', 400);

    const newHash = await bcrypt.hash(newPassword, 12);

    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        // Atomic single use: the conditional claim matches for exactly one of
        // any number of concurrent confirmations; the others abort.
        const claimed = await PasswordResetToken.findOneAndUpdate(
          { _id: tokenRecord._id, isUsed: false, expiresAt: { $gt: new Date() } },
          { $set: { isUsed: true, usedAt: new Date() } },
          { session: mongoSession, new: true },
        );
        if (!claimed) throw new AppError('AUTH_008', 400);

        await User.updateOne(
          { _id: user._id },
          { $set: { passwordHash: newHash, requiresPasswordChange: false } },
          { session: mongoSession },
        );
        // Any other outstanding reset/invite links for this user die too.
        await PasswordResetToken.updateMany(
          { userId: user._id, isUsed: false },
          { $set: { isUsed: true, usedAt: new Date() } },
          { session: mongoSession },
        );
        await DeviceSession.updateMany(
          { employeeId: user._id, isRevoked: false },
          { $set: { isRevoked: true, revokedAt: new Date(), revokedReason: 'password-reset' } },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }

    await writeAuditLog(
      user!._id as mongoose.Types.ObjectId,
      'AUTH_PASSWORD_SETUP',
      (user!._id as mongoose.Types.ObjectId).toHexString(),
      ip,
      userAgent,
    );
  }

  static async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ip: string,
    userAgent: string,
    currentSessionId?: string,
  ) {
    await connectDB();

    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw new AppError('AUTH_001', 401);
    if (!user.isActive) throw new AppError('AUTH_007', 401);

    const currentOk = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentOk) throw new AppError('AUTH_001', 401);

    // The caller's own session survives (if it supplied a session id that
    // really belongs to this user and is live); every other session is revoked.
    let keepSessionOid: mongoose.Types.ObjectId | null = null;
    if (currentSessionId && mongoose.isValidObjectId(currentSessionId)) {
      const own = await DeviceSession.findOne({
        _id: currentSessionId,
        employeeId: user._id,
        isRevoked: false,
      }).lean();
      if (own) keepSessionOid = own._id as mongoose.Types.ObjectId;
    }

    const same = await bcrypt.compare(newPassword, user.passwordHash);
    if (same) throw new AppError('GEN_001', 400);

    const newHash = await bcrypt.hash(newPassword, 12);

    const mongoSession = await mongoose.startSession();
    try {
      await mongoSession.withTransaction(async () => {
        await User.updateOne(
          { _id: user._id },
          { $set: { passwordHash: newHash, requiresPasswordChange: false } },
          { session: mongoSession },
        );
        await DeviceSession.updateMany(
          {
            employeeId: user._id,
            isRevoked: false,
            ...(keepSessionOid ? { _id: { $ne: keepSessionOid } } : {}),
          },
          { $set: { isRevoked: true, revokedAt: new Date(), revokedReason: 'password-change' } },
          { session: mongoSession },
        );
        // Outstanding reset/invite links must not be able to undo the change.
        await PasswordResetToken.updateMany(
          { userId: user._id, isUsed: false },
          { $set: { isUsed: true, usedAt: new Date() } },
          { session: mongoSession },
        );
      });
    } finally {
      await mongoSession.endSession();
    }

    const updatedUser = user.toObject() as IUser;
    updatedUser.requiresPasswordChange = false;
    const accessToken = await signAccessToken(updatedUser);
    const currentSessionKept = keepSessionOid !== null;

    await writeAuditLog(
      user._id as mongoose.Types.ObjectId,
      'AUTH_PASSWORD_CHANGED',
      userId,
      ip,
      userAgent,
    );

    return { accessToken, currentSessionKept };
  }

  static async getMe(userId: string) {
    await connectDB();

    const user = await User.findById(userId);
    if (!user) throw new AppError('AUTH_003', 401);

    return {
      id: (user._id as mongoose.Types.ObjectId).toHexString(),
      employeeId: user.employeeId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      phone: user.phone ?? null,
      department: user.department ?? null,
      designation: user.designation ?? null,
      monthlySalary: user.monthlySalary,
      dateOfJoining: user.dateOfJoining.toISOString().split('T')[0],
      dateOfLeaving: user.dateOfLeaving?.toISOString().split('T')[0] ?? null,
      isActive: user.isActive,
      hasRegisteredDevice: user.registeredDevice !== null,
      requiresPasswordChange: user.requiresPasswordChange,
      leaveBalances: user.leaveBalances,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  static async updateFcmToken(
    userId: string,
    token: string,
    deviceId: string,
    platform: 'android' | 'ios',
  ) {
    await connectDB();

    await FcmToken.findOneAndUpdate(
      { employeeId: new mongoose.Types.ObjectId(userId), deviceId },
      {
        $set: {
          token,
          platform,
          isActive: true,
          lastRefreshedAt: new Date(),
        },
        $setOnInsert: {
          employeeId: new mongoose.Types.ObjectId(userId),
          deviceId,
        },
      },
      { upsert: true, new: true },
    );
  }
}
