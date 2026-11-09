import { describe, it, expect } from '@jest/globals';
import { displayDayStatus } from '@lib/utils/attendance-display';

// Regression (found in local web testing): the admin attendance list showed
// "Absent" for an employee who was checked in right now, because the stored
// day status is provisional until sessions complete. Display only — the stored
// status (used by payroll/reports) must stay as-is.
describe('displayDayStatus (display only)', () => {
  it('a provisional absent day of a checked-in employee shows as checked-in', () => {
    expect(displayDayStatus('absent', true)).toBe('checked-in');
    expect(displayDayStatus('half-day', true)).toBe('checked-in');
  });

  it('a day already present stays present while still checked in', () => {
    expect(displayDayStatus('present', true)).toBe('present');
  });

  it('not checked in: the real status is shown unchanged', () => {
    expect(displayDayStatus('absent', false)).toBe('absent');
    expect(displayDayStatus('absent', undefined)).toBe('absent');
    expect(displayDayStatus('half-day', false)).toBe('half-day');
  });

  it('leave / holiday / weekend are never overridden', () => {
    for (const s of ['leave', 'holiday', 'weekend', 'lwp']) expect(displayDayStatus(s, true)).toBe(s);
  });

  it('does not mutate anything (stored status is the caller\'s value)', () => {
    const record = { status: 'absent', isCheckedIn: true };
    displayDayStatus(record.status, record.isCheckedIn);
    expect(record.status).toBe('absent');
  });
});
