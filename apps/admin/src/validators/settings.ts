import { z } from 'zod';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
// 24-hour HH:MM, 00:00–23:59 (previously /^\d{2}:\d{2}$/ accepted e.g. 99:99).
export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** IANA timezone that this runtime can actually format (an invalid zone would
 *  make every attendance date computation throw). */
export const timezoneSchema = z.string().min(1).max(50).refine((tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}, 'Must be a valid IANA timezone, e.g. Asia/Kolkata');

export const UpdateCompanySchema = z.object({
  companyName:                   z.string().min(1).max(100).optional(),
  timezone:                      timezoneSchema.optional(),
  currency:                      z.string().length(3).optional(),
  lateArrivalGraceMinutes:       z.number().int().min(0).max(120).optional(),
  leaveYearStartMonth:           z.number().int().min(1).max(12).optional(),
  regularizationLookbackDays:    z.number().int().min(1).max(90).optional(),
  payrollCutoffDay:              z.number().int().min(1).max(28).optional(),
  attendanceReminderEnabled:     z.boolean().optional(),
  attendanceReminderTime:        z.string().regex(TIME_REGEX, 'Must be HH:MM').optional(),
  gpsAccuracyThresholdMeters:   z.number().min(10).max(5000).optional(),
  checkinTimestampWindowMinutes: z.number().int().min(1).max(60).optional(),
}).strict();

export const UpdateShiftSchema = z.object({
  workStartTime:                 z.string().regex(TIME_REGEX, 'Must be HH:MM').optional(),
  workEndTime:                   z.string().regex(TIME_REGEX, 'Must be HH:MM').optional(),
  halfDayLateCheckInTime:        z.string().regex(TIME_REGEX, 'Must be HH:MM').optional(),
  requiredDailyMinutes:          z.number().int().min(60).max(720).optional(),
  halfDayThresholdMinutes:       z.number().int().min(60).max(480).optional(),
  sessionAutoClosePaddingMinutes: z.number().int().min(0).max(120).optional(),
}).strict();

export const UpdateWorkingDaysSchema = z.object({
  workingDays: z.array(z.enum(WEEKDAYS)).min(1).max(7),
}).strict();

export const UpdateGeofenceSchema = z.object({
  latitude:     z.number().min(-90).max(90).optional(),
  longitude:    z.number().min(-180).max(180).optional(),
  radiusMeters: z.number().min(50).max(50000).optional(),
  isEnabled:    z.boolean().optional(),
}).strict();

export const CreateHolidaySchema = z.object({
  dateString:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  name:        z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  type:        z.enum(['national', 'regional', 'company']),
}).strict();

export const UpdateLeaveTypeSchema = z.object({
  annualAllocation: z.number().int().min(0).max(365).optional(),
  encashable:       z.boolean().optional(),
  carryForward: z.object({
    enabled:      z.boolean().optional(),
    maxDays:      z.number().int().min(0).max(365).optional(),
    expiryMonths: z.number().int().min(0).max(24).optional(),
  }).strict().optional(),
}).strict();

export const LEAVE_TYPE_CODES = ['paidLeave', 'sickLeave', 'casualLeave'] as const;
export type LeaveTypeCode = typeof LEAVE_TYPE_CODES[number];

export type UpdateCompanyInput    = z.infer<typeof UpdateCompanySchema>;
export type UpdateShiftInput      = z.infer<typeof UpdateShiftSchema>;
export type UpdateWorkingDaysInput = z.infer<typeof UpdateWorkingDaysSchema>;
export type UpdateGeofenceInput   = z.infer<typeof UpdateGeofenceSchema>;
export type CreateHolidayInput    = z.infer<typeof CreateHolidaySchema>;
export type UpdateLeaveTypeInput  = z.infer<typeof UpdateLeaveTypeSchema>;
