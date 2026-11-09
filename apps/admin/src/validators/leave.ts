import { z } from 'zod';

const LEAVE_TYPES = ['paidLeave', 'sickLeave', 'casualLeave', 'lwp'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Backward compatibility: mobile builds up to 1.0.0 send these short codes
// (and no `duration`), so every leave application from the app was rejected.
// The mapping is one-to-one with the app's own labels (Paid/Sick/Casual/LWP).
const LEGACY_LEAVE_TYPE_CODES: Record<string, (typeof LEAVE_TYPES)[number]> = {
  PL: 'paidLeave', SL: 'sickLeave', CL: 'casualLeave', LWP: 'lwp',
};

export const ApplyLeaveSchema = z.object({
  leaveType:     z.preprocess((v) => (typeof v === 'string' && LEGACY_LEAVE_TYPE_CODES[v]) || v, z.enum(LEAVE_TYPES)),
  startDate:     z.string().regex(DATE_RE, 'startDate must be YYYY-MM-DD'),
  endDate:       z.string().regex(DATE_RE, 'endDate must be YYYY-MM-DD'),
  // Clients without a half-day option (the mobile app) omit it: a full day.
  duration:      z.enum(['full', 'half']).default('full'),
  halfDayPeriod: z.enum(['morning', 'afternoon']).optional(),
  reason:        z.string().max(500).optional(),
}).superRefine((v, ctx) => {
  if (v.endDate < v.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endDate must be >= startDate', path: ['endDate'] });
  }
  if (v.duration === 'half') {
    if (!v.halfDayPeriod) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'halfDayPeriod required for half-day leaves', path: ['halfDayPeriod'] });
    }
    if (v.startDate !== v.endDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Half-day leave must be a single day', path: ['endDate'] });
    }
  }
});

export const RejectLeaveSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const RevokeLeaveSchema = z.object({
  reason: z.string().min(10, 'Revocation reason must be at least 10 chars').max(500),
});

export const LeaveListQuerySchema = z.object({
  employeeId: z.string().optional(),
  status:     z.enum(['pending','approved','rejected','cancelled','revoked','withdrawn']).optional(),
  leaveType:  z.enum(LEAVE_TYPES).optional(),
  leaveYear:  z.coerce.number().int().min(2000).optional(),
  startDate:  z.string().regex(DATE_RE).optional(),
  endDate:    z.string().regex(DATE_RE).optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(100).default(20),
  sortBy:     z.enum(['createdAt','startDate','status']).default('createdAt'),
});

export const LeaveBalanceQuerySchema = z.object({
  employeeId: z.string().optional(),
});

export const WithdrawLeaveSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const LeavePendingQuerySchema = z.object({
  employeeId: z.string().optional(),
  leaveType:  z.enum(LEAVE_TYPES).optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(100).default(20),
});

export type ApplyLeaveInput = z.infer<typeof ApplyLeaveSchema>;
export type RejectLeaveInput = z.infer<typeof RejectLeaveSchema>;
export type RevokeLeaveInput = z.infer<typeof RevokeLeaveSchema>;
export type LeaveListQuery = z.infer<typeof LeaveListQuerySchema>;
