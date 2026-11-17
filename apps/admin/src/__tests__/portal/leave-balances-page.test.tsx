/**
 * @jest-environment jsdom
 */
// Regression: the admin "Leave Balances" page fetched GET /leaves/balance (one
// employee's object) and crashed with "balances.map is not a function". It now
// reads GET /leaves/balances (admin list) and shows fractional days as-is.
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { formatLeaveDays, leaveTypeLabel } from '@lib/utils/leave-days';

const swr = jest.fn();
jest.mock('swr', () => ({ __esModule: true, default: (...a: unknown[]) => swr(...a) }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/leave/balances',
}));
jest.mock('@components/layout/AdminLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('@lib/utils/api-client', () => ({ apiFetch: jest.fn() }));

import LeaveBalancesPage from '@/app/(portal)/leave/balances/page';

const emp = { _id: 'u1', firstName: 'Test', lastName: 'Employee A', employeeId: 'TST-EA' };

describe('formatLeaveDays', () => {
  it.each([
    [2, '2'], [1.5, '1.5'], [0.5, '0.5'], [0, '0'], [0.1 + 0.2, '0.3'], [null, '—'], [undefined, '—'], [NaN, '—'],
  ])('%p → %p', (v, out) => expect(formatLeaveDays(v as number)).toBe(out));

  it('labels leave types and passes unknown ones through', () => {
    expect(leaveTypeLabel('sickLeave')).toBe('Sick Leave');
    expect(leaveTypeLabel('lwp')).toBe('lwp');
  });
});

describe('Leave Balances page', () => {
  beforeEach(() => swr.mockReset());

  it('requests the admin list endpoint and renders fractional balances', () => {
    swr.mockReturnValue({
      isLoading: false,
      data: {
        success: true,
        data: [
          { employee: emp, leaveType: 'paidLeave', currentYear: 1.5, carriedForward: 0.5, carryForwardExpiry: '2027-03-31', available: 2 },
          { employee: emp, leaveType: 'sickLeave', currentYear: 0.5, carriedForward: 0, carryForwardExpiry: null, available: 0.5 },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    });

    render(<LeaveBalancesPage />);

    expect(swr.mock.calls[0][0]).toMatch(/^\/api\/v1\/leaves\/balances\?/);
    expect(screen.getByText('Paid Leave')).toBeInTheDocument();
    expect(screen.getByText('1.5')).toBeInTheDocument();
    expect(screen.getAllByText('0.5')).toHaveLength(3); // carry fwd, sick this year, sick available
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText(/Entitled|Used/)).not.toBeInTheDocument(); // never provided by the API
  });

  it('does not crash on an unexpected (non-array) payload', () => {
    swr.mockReturnValue({ isLoading: false, data: { success: true, data: { paidLeave: {} } } });
    render(<LeaveBalancesPage />);
    expect(screen.getByText('No leave balance data found')).toBeInTheDocument();
  });
});
