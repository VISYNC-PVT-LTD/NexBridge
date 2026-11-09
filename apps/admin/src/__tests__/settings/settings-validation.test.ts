/**
 * Settings cross-field validation (found in local admin testing).
 *  - Office-network mode could be saved with NO allowed IP → every check-in refused.
 *  - A half-day late cut-off before the shift start (or, for a shift ending
 *    after midnight, after midnight) made DayStatusEngine cap EVERY check-in to
 *    half-day. Overnight shifts themselves remain allowed (see docs/86).
 *  - PATCH /api/v1/settings reported a generic "Validation failed." and could
 *    half-apply a request (grace period saved while the shift was refused).
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import mongoose from 'mongoose';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

import { SettingsService } from '@services/SettingsService';
import { CompanySettings } from '@models/CompanySettings';
import * as settingsRoute from '@/app/api/v1/settings/route';

const stored = (over: Record<string, unknown> = {}) => ({
  _id: 'company-settings', workStartTime: '09:00', workEndTime: '18:00', halfDayLateCheckInTime: '14:00',
  requiredDailyMinutes: 480, halfDayThresholdMinutes: 240, attendanceValidationMode: 'geofence', allowedOfficeIps: [],
  companyName: 'Test Co', timezone: 'Asia/Kolkata', currency: 'INR', lateArrivalGraceMinutes: 15,
  workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  geoFence: { latitude: 12.9, longitude: 77.6, radiusMeters: 200, isEnabled: true },
  halfDayAggregationCount: 0,
  ...over,
});

let findById: jest.SpiedFunction<typeof CompanySettings.findById>;
let update: jest.SpiedFunction<typeof CompanySettings.findByIdAndUpdate>;
function mockStored(doc: Record<string, unknown>) {
  findById = jest.spyOn(CompanySettings, 'findById').mockReturnValue({ lean: jest.fn(async () => doc) } as never);
  update = jest.spyOn(CompanySettings, 'findByIdAndUpdate').mockReturnValue({ lean: jest.fn(async () => doc) } as never);
}

beforeEach(() => { jest.restoreAllMocks(); mockStored(stored()); });

describe('SettingsService.updateShift — half-day cut-off vs shift window', () => {
  it('accepts a normal same-day shift', async () => {
    await expect(SettingsService.updateShift({ workStartTime: '09:00', workEndTime: '18:00', halfDayLateCheckInTime: '14:00' })).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });

  it.each([
    ['before the start', '08:00'],
    ['equal to the start', '09:00'],
    ['after the end', '19:00'],
  ])('refuses a same-day cut-off %s', async (_label, cutoff) => {
    await expect(SettingsService.updateShift({ workStartTime: '09:00', workEndTime: '18:00', halfDayLateCheckInTime: cutoff }))
      .rejects.toMatchObject({ code: 'GEN_001', httpStatus: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it('a partial update is checked against the stored cut-off (start moved past it)', async () => {
    await expect(SettingsService.updateShift({ workStartTime: '15:00' })).rejects.toMatchObject({ code: 'GEN_001' });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps overnight shifts allowed when the cut-off is before midnight', async () => {
    await expect(SettingsService.updateShift({ workStartTime: '22:00', workEndTime: '06:00', halfDayLateCheckInTime: '23:30' })).resolves.toBeDefined();
  });

  it('refuses an overnight cut-off after midnight (would cap every check-in)', async () => {
    await expect(SettingsService.updateShift({ workStartTime: '22:00', workEndTime: '06:00', halfDayLateCheckInTime: '02:00' }))
      .rejects.toMatchObject({ code: 'GEN_001', message: expect.stringContaining('after midnight') });
  });

  it('still refuses start == end (existing rule)', async () => {
    await expect(SettingsService.updateShift({ workStartTime: '09:00', workEndTime: '09:00' })).rejects.toMatchObject({ code: 'GEN_001' });
  });
});

describe('SettingsService.updateAttendanceValidation — office IP mode', () => {
  it('refuses office-network mode with no allowed IP', async () => {
    await expect(SettingsService.updateAttendanceValidation({ attendanceValidationMode: 'officeIp', allowedOfficeIps: [] }))
      .rejects.toMatchObject({ code: 'GEN_001', message: expect.stringContaining('at least one allowed office IP') });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses switching mode only, when no IP is stored', async () => {
    await expect(SettingsService.updateAttendanceValidation({ attendanceValidationMode: 'officeIp' })).rejects.toMatchObject({ code: 'GEN_001' });
  });

  it('refuses removing the last IP while in office-network mode', async () => {
    mockStored(stored({ attendanceValidationMode: 'officeIp', allowedOfficeIps: ['198.51.100.20'] }));
    await expect(SettingsService.updateAttendanceValidation({ allowedOfficeIps: [] })).rejects.toMatchObject({ code: 'GEN_001' });
  });

  it('accepts office-network mode with an IP, and geofence mode with none', async () => {
    await expect(SettingsService.updateAttendanceValidation({ attendanceValidationMode: 'officeIp', allowedOfficeIps: ['198.51.100.20'] })).resolves.toBeDefined();
    await expect(SettingsService.updateAttendanceValidation({ attendanceValidationMode: 'geofence', allowedOfficeIps: [] })).resolves.toBeDefined();
  });
});

describe('PATCH /api/v1/settings — clear errors, no half-applied updates', () => {
  async function adminReq(body: unknown) {
    const t = await new SignJWT({ userId: '507f1f77bcf86cd799439011', role: 'admin', requiresPasswordChange: false })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    return new NextRequest('http://localhost:3000/api/v1/settings', {
      method: 'PATCH', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}`, origin: 'http://localhost:3000' },
    });
  }

  it('office-network mode without an IP: 400 with the specific reason, nothing written', async () => {
    const spy = jest.spyOn(SettingsService, 'updateAttendanceValidation');
    const res = await settingsRoute.PATCH(await adminReq({ attendanceValidation: { mode: 'officeIp', allowedOfficeIps: [] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Office network mode needs at least one allowed office IP.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a refused shift does not half-apply the grace period', async () => {
    const company = jest.spyOn(SettingsService, 'updateCompany');
    const res = await settingsRoute.PATCH(await adminReq({ shift: { startTime: '09:00', endTime: '18:00', gracePeriodMinutes: 30, halfDayLateCheckInTime: '08:00' } }));
    expect(res.status).toBe(400);
    expect(company).not.toHaveBeenCalled();
  });

  it('a shift-only update is applied and not reported as "No updates provided"', async () => {
    jest.spyOn(SettingsService, 'getSettings').mockResolvedValue(stored() as never);
    const res = await settingsRoute.PATCH(await adminReq({ shift: { startTime: '09:30', endTime: '18:30' } }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
