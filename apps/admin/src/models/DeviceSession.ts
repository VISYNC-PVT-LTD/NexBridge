import mongoose, { Document, Model, Schema } from 'mongoose';

export type RevokedReason =
  | 'logout' | 'admin-reset' | 'device-change' | 'expired'
  | 'password-change' | 'password-reset' | 'refresh-reuse' | 'deactivated';

export interface IDeviceSession extends Document {
  employeeId: mongoose.Types.ObjectId;
  refreshTokenHash: string;
  /** Hash of the refresh token that was rotated out by the last refresh. */
  previousRefreshTokenHash?: string | null;
  /** When the last rotation happened (start of the retry-grace window). */
  rotatedAt?: Date | null;
  /** AES-GCM encrypted copy of the CURRENT raw refresh token, kept only so a
   *  client that lost the rotation response can retry idempotently within the
   *  grace window. Never the plaintext. select:false. */
  pendingRefreshTokenEnc?: string | null;
  deviceFingerprint: string | null;
  deviceInfo: string;
  platform: 'android' | 'ios' | 'web';
  isRevoked: boolean;
  revokedAt?: Date;
  revokedReason?: RevokedReason;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  lastUsedAt: Date;
  ipAddressHash: string;
  createdAt: Date;
}

const DeviceSessionSchema = new Schema<IDeviceSession>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    refreshTokenHash: { type: String, required: true },
    previousRefreshTokenHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    pendingRefreshTokenEnc: { type: String, default: null, select: false },
    deviceFingerprint: { type: String, required: false, default: null },
    deviceInfo: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], required: true },
    isRevoked: { type: Boolean, required: true, default: false },
    revokedAt: { type: Date },
    revokedReason: {
      type: String,
      enum: ['logout', 'admin-reset', 'device-change', 'expired', 'password-change', 'password-reset', 'refresh-reuse', 'deactivated'],
    },
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true, default: Date.now },
    ipAddressHash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

DeviceSessionSchema.index({ employeeId: 1, isRevoked: 1 });
DeviceSessionSchema.index({ refreshTokenHash: 1 });
DeviceSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DeviceSession: Model<IDeviceSession> =
  (mongoose.models['DeviceSession'] as Model<IDeviceSession>) ??
  mongoose.model<IDeviceSession>('DeviceSession', DeviceSessionSchema);
