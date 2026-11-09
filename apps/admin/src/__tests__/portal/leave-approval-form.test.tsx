/**
 * @jest-environment jsdom
 *
 * Regression: the admin portal could not approve/reject leave.
 *  - it used `leave._id` (undefined — the API returns `id`) → /api/v1/leaves/undefined/approve
 *  - it sent POST, but the routes only export PATCH → 405
 *  - it sent `{ remark }`, but reject expects `{ reason }`
 *  - apiFetch resolves (does not throw) with the error body on non-2xx, so a
 *    failed action was still reported as "Leave approved".
 * Contract: app/api/v1/leaves/[id]/{approve,reject}/route.ts
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@lib/utils/api-client', () => ({ apiFetch: jest.fn() }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

import { apiFetch } from '@lib/utils/api-client';
import { toast } from 'sonner';
import LeaveApprovalForm from '@components/forms/LeaveApprovalForm';

const mockFetch = apiFetch as jest.Mock;
const LEAVE_ID = '6af17fcda39d1e20d877bf3c';

beforeEach(() => {
  mockFetch.mockReset();
  (toast.success as jest.Mock).mockReset();
  (toast.error as jest.Mock).mockReset();
});

describe('LeaveApprovalForm — API contract', () => {
  it('approve: PATCH /api/v1/leaves/:id/approve using the API `id`, no body', async () => {
    mockFetch.mockResolvedValue({ success: true, data: {} });
    const onSuccess = jest.fn();
    render(<LeaveApprovalForm leave={{ id: LEAVE_ID }} action="approve" onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve Leave' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/leaves/${LEAVE_ID}/approve`);
    expect(url).not.toContain('undefined');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith('Leave approved');
  });

  it('reject: PATCH /api/v1/leaves/:id/reject with { reason }', async () => {
    mockFetch.mockResolvedValue({ success: true, data: {} });
    const onSuccess = jest.fn();
    render(<LeaveApprovalForm leave={{ id: LEAVE_ID }} action="reject" onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText(/Rejection Reason/), { target: { value: 'Team already short that day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject Leave' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/leaves/${LEAVE_ID}/reject`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Team already short that day' });
  });

  it('reject: a reason shorter than 10 characters is not submitted', async () => {
    render(<LeaveApprovalForm leave={{ id: LEAVE_ID }} action="reject" onSuccess={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/Rejection Reason/), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject Leave' }));
    expect(await screen.findByText('Remark required (min 10 chars)')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an error body ({ success: false }) is shown as an error, never as success', async () => {
    mockFetch.mockResolvedValue({ success: false, error: { code: 'LVE_005', message: 'Leave request is not pending.' } });
    const onSuccess = jest.fn();
    render(<LeaveApprovalForm leave={{ id: LEAVE_ID }} action="approve" onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve Leave' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Leave request is not pending.'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
