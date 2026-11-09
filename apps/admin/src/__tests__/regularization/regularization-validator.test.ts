import { describe, it, expect } from '@jest/globals';
import { CreateRegularizationSchema } from '@validators/regularization';

// Regression (found in local phone/web testing): a request whose check-out was
// BEFORE its check-in (or >24 h after it) was accepted and shown to admins.
const base = { date: '2026-11-05', type: 'forgotCheckIn' as const, reason: 'Forgot to check in - test' };

function issues(input: unknown): string[] {
  const r = CreateRegularizationSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe('CreateRegularizationSchema — requested time order', () => {
  it('accepts check-in followed by a later check-out the same day', () => {
    expect(issues({ ...base, requestedCheckIn: '2026-11-05T09:10:00+05:30', requestedCheckOut: '2026-11-05T18:05:00+05:30' })).toEqual([]);
  });

  it('rejects a check-out before the check-in', () => {
    expect(issues({ ...base, requestedCheckIn: '2026-11-05T18:00:00+05:30', requestedCheckOut: '2026-11-05T09:00:00+05:30' }))
      .toContain('requestedCheckOut must be after requestedCheckIn');
  });

  it('rejects a check-out equal to the check-in', () => {
    expect(issues({ ...base, requestedCheckIn: '2026-11-05T09:00:00+05:30', requestedCheckOut: '2026-11-05T03:30:00Z' }))
      .toContain('requestedCheckOut must be after requestedCheckIn');
  });

  it('rejects a check-out more than 24 h after the check-in', () => {
    expect(issues({ ...base, requestedCheckIn: '2026-11-05T09:00:00+05:30', requestedCheckOut: '2026-11-06T09:00:01+05:30' }))
      .toContain('requestedCheckOut must be within 24 hours of requestedCheckIn');
  });

  it('accepts an overnight session that ends within 24 h', () => {
    expect(issues({ ...base, requestedCheckIn: '2026-11-05T22:00:00+05:30', requestedCheckOut: '2026-11-06T06:00:00+05:30' })).toEqual([]);
  });

  it('still allows a single requested time (forgotCheckOut with only a check-out)', () => {
    expect(issues({ ...base, type: 'forgotCheckOut', requestedCheckOut: '2026-11-05T18:05:00+05:30' })).toEqual([]);
  });
});
