import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import mongoose from 'mongoose';
import { NextRequest } from 'next/server';

Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

import * as autoClose from '@/app/admin/cron/session-auto-close/route';
import * as yearAlloc from '@/app/admin/cron/leave-year-allocation/route';
import * as carryForward from '@/app/admin/cron/leave-carryforward-expiry/route';
import { AttendanceService } from '@services/AttendanceService';
import { CompanySettings } from '@models/CompanySettings';
import { SystemEvent } from '@models/SystemEvent';

const URL_BASE = 'http://localhost:3000/admin/cron/session-auto-close';
const auth = { authorization: `Bearer ${process.env.CRON_SECRET}` };

function req(method: 'GET' | 'POST', headers: Record<string, string> = {}) {
  return new NextRequest(URL_BASE, { method, headers });
}

beforeEach(() => {
  jest.spyOn(CompanySettings, 'findById').mockReturnValue({
    lean: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata', leaveYearStartMonth: 1 }),
  } as never);
  jest.spyOn(SystemEvent, 'create').mockResolvedValue({} as never);
  jest.spyOn(SystemEvent, 'updateOne').mockResolvedValue({} as never);
});
afterEach(() => jest.restoreAllMocks());

describe('cron routes — HTTP method contract', () => {
  it.each([
    ['session-auto-close', autoClose],
    ['leave-year-allocation', yearAlloc],
    ['leave-carryforward-expiry', carryForward],
  ])('%s exports GET (Vercel Cron) and POST (manual trigger)', (_name, mod) => {
    expect(typeof (mod as { GET?: unknown }).GET).toBe('function');
    expect(typeof (mod as { POST?: unknown }).POST).toBe('function');
  });
});

describe('cron routes — authentication', () => {
  it.each(['GET', 'POST'] as const)('%s without Authorization → 401, job not run', async (method) => {
    const spy = jest.spyOn(AttendanceService, 'reconcileMissedCheckouts');
    const res = await autoClose[method](req(method));
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('wrong secret → 401', async () => {
    const res = await autoClose.GET(req('GET', { authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
  });

  it('CRON_SECRET not configured → 500 (fail closed), job not run', async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const spy = jest.spyOn(AttendanceService, 'reconcileMissedCheckouts');
      const res = await autoClose.GET(req('GET', { authorization: 'Bearer ' }));
      expect(res.status).toBe(500);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });
});

describe('cron routes — missed-check-out sweep is idempotent and never skipped', () => {
  it('authorized GET runs the 24-hour sweep and records the run (upsert)', async () => {
    const run = jest.spyOn(AttendanceService, 'reconcileMissedCheckouts').mockResolvedValue({ expired: 2 });
    const res = await autoClose.GET(req('GET', auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, sessionsExpired: 2 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(SystemEvent.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ date: expect.any(String) }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'completed' }) }),
      { upsert: true },
    );
  });

  it('a repeated run on the same day still sweeps (safe: the sweep is idempotent)', async () => {
    const run = jest.spyOn(AttendanceService, 'reconcileMissedCheckouts')
      .mockResolvedValueOnce({ expired: 1 })
      .mockResolvedValueOnce({ expired: 0 });
    await autoClose.GET(req('GET', auth));
    const second = await autoClose.GET(req('GET', auth));
    expect(run).toHaveBeenCalledTimes(2);
    expect(await second.json()).toMatchObject({ sessionsExpired: 0 });
  });
});
