import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  // Optional for admin-role web logins; required for mobile employee logins
  deviceFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hex string')
    .optional(),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(64),
});

export const LogoutSchema = z.object({
  sessionId: z.string().min(1),
});

export const ForgotPasswordSchema = z.object({
  email: z.string().email().max(255),
});

export const ResetPasswordSchema = z.object({
  token: z.string().min(1).max(256),
  email: z.string().email().max(255),
  newPassword: z.string().min(8).max(128),
});

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(128),
    // Optional: the caller's own session id. When supplied (and owned by the
    // caller) that session stays signed in; all other sessions are revoked.
    sessionId: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'New password must differ from current password',
    path: ['newPassword'],
  });

export const RegisterFcmTokenSchema = z.object({
  token: z.string().min(1),
  deviceId: z.string().min(1),
  platform: z.enum(['android', 'ios']),
});
