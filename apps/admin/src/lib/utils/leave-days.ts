/**
 * Leave day counts can be fractional (a half day is 0.5, pro-rated balances
 * such as 1.5). Show whole numbers without decimals and fractions as they are,
 * rounded to 2 places to hide floating-point noise: 2 → "2", 1.5 → "1.5".
 */
export function formatLeaveDays(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const r = Math.round(value * 100) / 100;
  return String(r);
}

const LEAVE_TYPE_LABELS: Record<string, string> = {
  paidLeave: 'Paid Leave',
  sickLeave: 'Sick Leave',
  casualLeave: 'Casual Leave',
};

export function leaveTypeLabel(type: string): string {
  return LEAVE_TYPE_LABELS[type] ?? type;
}
