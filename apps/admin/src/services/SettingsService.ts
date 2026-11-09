import mongoose from 'mongoose';
import { connectDB } from '@lib/db/connect';
import { AppError } from '@services/AuthService';
import { CompanySettings } from '@models/CompanySettings';
import { Holiday } from '@models/Holiday';
import type { ICompanySettings } from '@models/CompanySettings';
import type { IHoliday } from '@models/Holiday';
import type {
  UpdateCompanyInput,
  UpdateShiftInput,
  UpdateWorkingDaysInput,
  UpdateGeofenceInput,
  CreateHolidayInput,
  UpdateLeaveTypeInput,
  LeaveTypeCode,
} from '@validators/settings';
import type { IStatutoryConfig } from '@models/CompanySettings';

async function requireSettings(): Promise<ICompanySettings & { _id: string }> {
  const s = await CompanySettings.findById('company-settings').lean() as (ICompanySettings & { _id: string }) | null;
  if (!s) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
  return s;
}

export class SettingsService {
  static async getSettings() {
    await connectDB();
    return requireSettings();
  }

  static async updateCompany(data: UpdateCompanyInput) {
    await connectDB();
    const $set: Record<string, unknown> = {};
    if (data.companyName                   !== undefined) $set.companyName                   = data.companyName;
    if (data.timezone                      !== undefined) $set.timezone                      = data.timezone;
    if (data.currency                      !== undefined) $set.currency                      = data.currency;
    if (data.lateArrivalGraceMinutes       !== undefined) $set.lateArrivalGraceMinutes       = data.lateArrivalGraceMinutes;
    if (data.leaveYearStartMonth           !== undefined) $set.leaveYearStartMonth           = data.leaveYearStartMonth;
    if (data.regularizationLookbackDays    !== undefined) $set.regularizationLookbackDays    = data.regularizationLookbackDays;
    if (data.payrollCutoffDay              !== undefined) $set.payrollCutoffDay              = data.payrollCutoffDay;
    if (data.attendanceReminderEnabled     !== undefined) $set.attendanceReminderEnabled     = data.attendanceReminderEnabled;
    if (data.attendanceReminderTime        !== undefined) $set.attendanceReminderTime        = data.attendanceReminderTime;
    if (data.gpsAccuracyThresholdMeters    !== undefined) $set.gpsAccuracyThresholdMeters    = data.gpsAccuracyThresholdMeters;
    if (data.checkinTimestampWindowMinutes !== undefined) $set.checkinTimestampWindowMinutes = data.checkinTimestampWindowMinutes;

    if (Object.keys($set).length === 0) throw new AppError('GEN_001', 400, 'No fields to update.');

    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return updated;
  }

  static async updateShift(data: UpdateShiftInput) {
    await connectDB();
    const $set: Record<string, unknown> = {};
    if (data.workStartTime                  !== undefined) $set.workStartTime                  = data.workStartTime;
    if (data.workEndTime                    !== undefined) $set.workEndTime                    = data.workEndTime;
    if (data.halfDayLateCheckInTime         !== undefined) $set.halfDayLateCheckInTime         = data.halfDayLateCheckInTime;
    if (data.requiredDailyMinutes           !== undefined) $set.requiredDailyMinutes           = data.requiredDailyMinutes;
    if (data.halfDayThresholdMinutes        !== undefined) $set.halfDayThresholdMinutes        = data.halfDayThresholdMinutes;
    if (data.sessionAutoClosePaddingMinutes !== undefined) $set.sessionAutoClosePaddingMinutes = data.sessionAutoClosePaddingMinutes;

    if (Object.keys($set).length === 0) throw new AppError('GEN_001', 400, 'No fields to update.');

    // Cross-field consistency against the values that will be in effect after
    // this (partial) update.
    const current = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const merged = { ...(current ?? {}), ...$set } as Partial<ICompanySettings>;
    if (merged.halfDayThresholdMinutes !== undefined && merged.requiredDailyMinutes !== undefined
        && merged.halfDayThresholdMinutes > merged.requiredDailyMinutes) {
      throw new AppError('GEN_001', 400, 'halfDayThresholdMinutes cannot exceed requiredDailyMinutes.');
    }
    if (merged.workStartTime && merged.workEndTime && merged.workStartTime === merged.workEndTime) {
      throw new AppError('GEN_001', 400, 'workStartTime and workEndTime cannot be equal.');
    }
    // Half-day late cut-off vs the shift window. DayStatusEngine compares clock
    // minutes of the same calendar day (no wrap past midnight), so:
    //  - same-day shift (end > start): start < cut-off <= end;
    //  - overnight shift (end < start — kept allowed; see docs/86 open rules):
    //    the cut-off must be after start and before midnight, otherwise EVERY
    //    check-in (e.g. 22:10 vs a 02:00 cut-off) would be capped to half-day.
    if (merged.workStartTime && merged.workEndTime && merged.halfDayLateCheckInTime) {
      const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const start = toMin(merged.workStartTime);
      const end = toMin(merged.workEndTime);
      const cutoff = toMin(merged.halfDayLateCheckInTime);
      if (end > start && !(cutoff > start && cutoff <= end)) {
        throw new AppError('GEN_001', 400, 'halfDayLateCheckInTime must be after workStartTime and no later than workEndTime.');
      }
      if (end < start && !(cutoff > start)) {
        throw new AppError('GEN_001', 400, 'For a shift that ends after midnight, halfDayLateCheckInTime must be after workStartTime and before midnight.');
      }
    }

    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return updated;
  }

  static async updateWorkingDays(data: UpdateWorkingDaysInput) {
    await connectDB();
    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set: { workingDays: data.workingDays } },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return updated;
  }

  static async updateGeofence(data: UpdateGeofenceInput) {
    await connectDB();
    const $set: Record<string, unknown> = {};
    if (data.latitude     !== undefined) $set['geoFence.latitude']     = data.latitude;
    if (data.longitude    !== undefined) $set['geoFence.longitude']    = data.longitude;
    if (data.radiusMeters !== undefined) $set['geoFence.radiusMeters'] = data.radiusMeters;
    if (data.isEnabled    !== undefined) $set['geoFence.isEnabled']    = data.isEnabled;

    if (Object.keys($set).length === 0) throw new AppError('GEN_001', 400, 'No fields to update.');

    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return updated;
  }

  static async updateStatutory(config: IStatutoryConfig) {
    await connectDB();
    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set: { statutoryConfig: config } },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return updated.statutoryConfig;
  }

  static async updateAttendanceValidation(data: {
    attendanceValidationMode?: 'geofence' | 'officeIp';
    allowedOfficeIps?: string[];
  }) {
    await connectDB();
    const $set: Record<string, unknown> = {};
    if (data.attendanceValidationMode !== undefined)
      $set.attendanceValidationMode = data.attendanceValidationMode;
    if (data.allowedOfficeIps !== undefined)
      $set.allowedOfficeIps = data.allowedOfficeIps;
    if (Object.keys($set).length === 0) throw new AppError('GEN_001', 400, 'No fields to update.');

    // Office-network mode with no allowed IP would refuse every check-in.
    // Checked against the values in effect AFTER this (possibly partial) update.
    const current = await CompanySettings.findById('company-settings').lean() as ICompanySettings | null;
    const nextMode = data.attendanceValidationMode ?? current?.attendanceValidationMode ?? 'geofence';
    const nextIps  = data.allowedOfficeIps ?? current?.allowedOfficeIps ?? [];
    if (nextMode === 'officeIp' && nextIps.length === 0) {
      throw new AppError('GEN_001', 400, 'Office network mode needs at least one allowed office IP.');
    }

    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return updated;
  }

  static async updatePayrollRules(data: { halfDayAggregationCount?: number }) {
    await connectDB();
    const $set: Record<string, unknown> = {};
    if (data.halfDayAggregationCount !== undefined)
      $set['payrollRules.halfDayAggregationCount'] = data.halfDayAggregationCount;
    if (Object.keys($set).length === 0) throw new AppError('GEN_001', 400, 'No fields to update.');
    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return updated;
  }

  static async listHolidays(year?: number) {
    await connectDB();
    const filter: Record<string, unknown> = year ? { year } : {};
    const holidays = await Holiday.find(filter)
      .sort({ dateString: 1 })
      .lean() as unknown as Array<IHoliday & { _id: mongoose.Types.ObjectId }>;
    return holidays.map((h) => ({
      id:          h._id.toHexString(),
      dateString:  h.dateString,
      name:        h.name,
      description: h.description ?? null,
      type:        h.type,
      year:        h.year,
      createdAt:   h.createdAt.toISOString(),
    }));
  }

  static async createHoliday(data: CreateHolidayInput, createdBy: string) {
    await connectDB();
    const date = new Date(data.dateString);
    const year = date.getUTCFullYear();
    try {
      const holiday = await Holiday.create({
        date,
        dateString: data.dateString,
        name:       data.name,
        description: data.description,
        type:       data.type,
        year,
        createdBy:  new mongoose.Types.ObjectId(createdBy),
      }) as IHoliday & { _id: mongoose.Types.ObjectId };
      return {
        id:          holiday._id.toHexString(),
        dateString:  holiday.dateString,
        name:        holiday.name,
        description: holiday.description ?? null,
        type:        holiday.type,
        year:        holiday.year,
        createdAt:   holiday.createdAt.toISOString(),
      };
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000) {
        throw new AppError('GEN_006', 409, 'A holiday already exists for this date.');
      }
      throw err;
    }
  }

  static async deleteHoliday(id: string) {
    await connectDB();
    if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError('GEN_002', 404, 'Holiday not found.');
    const result = await Holiday.deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    if (result.deletedCount === 0) throw new AppError('GEN_002', 404, 'Holiday not found.');
  }

  static async getLeaveTypes() {
    await connectDB();
    const s = await requireSettings();
    return s.leaveTypes;
  }

  static async updateLeaveType(code: LeaveTypeCode, data: UpdateLeaveTypeInput) {
    await connectDB();
    const $set: Record<string, unknown> = {};
    if (data.annualAllocation !== undefined) $set[`leaveTypes.${code}.annualAllocation`] = data.annualAllocation;
    if (data.encashable       !== undefined) $set[`leaveTypes.${code}.encashable`]       = data.encashable;
    if (data.carryForward?.enabled      !== undefined) $set[`leaveTypes.${code}.carryForward.enabled`]      = data.carryForward.enabled;
    if (data.carryForward?.maxDays      !== undefined) $set[`leaveTypes.${code}.carryForward.maxDays`]      = data.carryForward.maxDays;
    if (data.carryForward?.expiryMonths !== undefined) $set[`leaveTypes.${code}.carryForward.expiryMonths`] = data.carryForward.expiryMonths;

    if (Object.keys($set).length === 0) throw new AppError('GEN_001', 400, 'No fields to update.');

    const updated = await CompanySettings.findByIdAndUpdate(
      'company-settings',
      { $set },
      { new: true, runValidators: true },
    ).lean() as (ICompanySettings & { _id: string }) | null;
    if (!updated) throw new AppError('GEN_004', 404, 'Company settings not yet configured.');
    return (updated.leaveTypes as unknown as Record<string, unknown>)[code];
  }
}
