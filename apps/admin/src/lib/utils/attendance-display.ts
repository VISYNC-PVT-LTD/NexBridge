/**
 * DISPLAY-ONLY status for an attendance day.
 *
 * A day's stored `status` is recomputed from completed session minutes, so
 * while an employee is still checked in it is provisionally 'absent' (or
 * 'half-day') — the admin portal used to show "Absent" for someone who was at
 * work right now. The stored status is what payroll and reports use and is NOT
 * changed here; this only decides which badge to render.
 */
const PROVISIONAL_WHILE_WORKING = new Set(['absent', 'half-day']);

export function displayDayStatus(status: string, isCheckedIn: boolean | undefined): string {
  if (isCheckedIn && PROVISIONAL_WHILE_WORKING.has(status)) return 'checked-in';
  return status;
}
