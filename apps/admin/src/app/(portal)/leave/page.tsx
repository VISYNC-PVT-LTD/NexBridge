'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';
import AdminLayout from '@components/layout/AdminLayout';
import { Button } from '@components/ui/button';
import { Input } from '@components/ui/input';
import { Select } from '@components/ui/select';
import { Dialog } from '@components/ui/dialog';
import StatusBadge from '@components/shared/StatusBadge';
import Pagination from '@components/shared/Pagination';
import EmptyState from '@components/shared/EmptyState';
import { TableSkeleton } from '@components/ui/skeleton';
import LeaveApprovalForm from '@components/forms/LeaveApprovalForm';
import Link from 'next/link';
import { useLeaves } from '@/hooks/useLeaves';
import { usePagination } from '@/hooks/usePagination';
import type { LeaveRequest } from '@/types/api';
import { leaveTypeLabel } from '@/types/enums';

function empName(leave: LeaveRequest) {
  return leave.employeeName ?? leave.employeeId;
}

export default function LeavesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { page, limit, setPage, buildQuery } = usePagination(20);
  const [modal, setModal] = useState<{ leave: LeaveRequest; action: 'approve' | 'reject' } | null>(null);

  const status    = params.get('status') ?? '';
  const startDate = params.get('startDate') ?? '';
  const endDate   = params.get('endDate') ?? '';

  const query = buildQuery({ status: status || undefined, startDate: startDate || undefined, endDate: endDate || undefined });
  const { leaves, pagination, isLoading, refresh } = useLeaves(query);

  const updateParam = (key: string, value: string) => {
    const sp = new URLSearchParams(params.toString());
    if (value) sp.set(key, value); else sp.delete(key);
    sp.set('page', '1');
    router.push(`/leave?${sp.toString()}`);
  };

  return (
    <AdminLayout breadcrumb={[{ label: 'Leave' }]}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Leave Requests</h1>
        </div>

        {/* Tab strip */}
        <div className="flex gap-1 border-b border-gray-200">
          <span className="px-4 py-2 text-sm font-medium text-blue-600 border-b-2 border-blue-600">Requests</span>
          <Link href="/leave/balances" className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors">Balances</Link>
        </div>

        <div className="flex gap-3 flex-wrap">
          <Select value={status} onChange={e => updateParam('status', e.target.value)} className="w-40">
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
            <option value="revoked">Revoked</option>
            <option value="withdrawn">Withdrawn</option>
          </Select>
          <Input type="date" value={startDate} onChange={e => updateParam('startDate', e.target.value)} className="w-40" placeholder="From" />
          <Input type="date" value={endDate}   onChange={e => updateParam('endDate',   e.target.value)} className="w-40" placeholder="To" />
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Employee', 'Type', 'Start', 'End', 'Days', 'Status', 'Applied On', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            {isLoading ? <TableSkeleton rows={8} cols={8} /> : leaves.length === 0 ? (
              <tbody><tr><td colSpan={8}>
                <EmptyState title="No leave requests found" filtered={!!(status || startDate || endDate)} onClearFilters={() => router.push('/leave')} />
              </td></tr></tbody>
            ) : (
              <tbody>
                {leaves.map(leave => (
                  <tr key={leave.id} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/leave/${leave.id}`)}>
                    <td className="px-4 py-3 font-medium text-gray-900">{empName(leave)}</td>
                    <td className="px-4 py-3 text-gray-600">{leaveTypeLabel(leave.leaveType)}{leave.duration === 'half' && leave.halfDayPeriod ? ` (½ ${leave.halfDayPeriod})` : ''}</td>
                    <td className="px-4 py-3 text-gray-600">{format(parseISO(leave.startDate), 'dd MMM yy')}</td>
                    <td className="px-4 py-3 text-gray-600">{format(parseISO(leave.endDate),   'dd MMM yy')}</td>
                    <td className="px-4 py-3 text-gray-600">{leave.totalDays}</td>
                    <td className="px-4 py-3"><StatusBadge status={leave.status} /></td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{format(parseISO(leave.createdAt), 'dd MMM yy')}</td>
                    <td className="px-4 py-3 text-right">
                      {leave.status === 'pending' && (
                        <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                          <Button size="sm" onClick={() => setModal({ leave, action: 'approve' })}>Approve</Button>
                          <Button size="sm" variant="destructive" onClick={() => setModal({ leave, action: 'reject' })}>Reject</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} total={pagination.total} limit={limit} onPageChange={setPage} />
          )}
        </div>
      </div>

      {modal && (
        <Dialog open title={modal.action === 'approve' ? 'Approve Leave' : 'Reject Leave'} onClose={() => setModal(null)}>
          <LeaveApprovalForm leave={modal.leave} action={modal.action} onSuccess={() => { setModal(null); refresh(); }} />
        </Dialog>
      )}
    </AdminLayout>
  );
}
