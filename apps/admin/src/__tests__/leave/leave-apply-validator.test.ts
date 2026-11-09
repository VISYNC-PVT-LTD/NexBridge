import { describe, it, expect } from '@jest/globals';
import { ApplyLeaveSchema } from '@validators/leave';

// Regression (found on a real phone): the mobile app sent leaveType 'PL'/'SL'/
// 'CL'/'LWP' and no `duration`, so every leave application from the app was
// rejected with 400. Installed app builds keep sending that body, so the API
// accepts it (one-to-one aliases, full-day default) as well as the canonical form.
const base = { startDate: '2026-11-20', endDate: '2026-11-20', reason: 'Family function' };

describe('ApplyLeaveSchema — mobile compatibility', () => {
  it.each([
    ['PL', 'paidLeave'], ['SL', 'sickLeave'], ['CL', 'casualLeave'], ['LWP', 'lwp'],
  ])('accepts the legacy app code %s as %s', (legacy, canonical) => {
    const r = ApplyLeaveSchema.safeParse({ ...base, leaveType: legacy });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.leaveType).toBe(canonical);
  });

  it('a body without duration (the exact old app body) is a full-day leave', () => {
    const r = ApplyLeaveSchema.safeParse({ ...base, leaveType: 'PL' });
    expect(r.success && r.data.duration).toBe('full');
  });

  it('the canonical body (what the fixed app sends) is accepted unchanged', () => {
    const r = ApplyLeaveSchema.safeParse({ ...base, leaveType: 'casualLeave', duration: 'full' });
    expect(r.success).toBe(true);
  });

  it('unknown codes are still rejected', () => {
    expect(ApplyLeaveSchema.safeParse({ ...base, leaveType: 'XL' }).success).toBe(false);
    expect(ApplyLeaveSchema.safeParse({ ...base, leaveType: 'pl' }).success).toBe(false);
  });

  it('half-day still requires a period (unchanged rule)', () => {
    expect(ApplyLeaveSchema.safeParse({ ...base, leaveType: 'casualLeave', duration: 'half' }).success).toBe(false);
  });
});
