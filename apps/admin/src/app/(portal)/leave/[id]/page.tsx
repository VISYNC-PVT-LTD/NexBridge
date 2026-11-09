'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { format, parseISO } from 'date-fns';
import AdminLayout from '@components/layout/AdminLayout';
import { Button } from '@components/ui/button';
import { Dialog } from '@components/ui/dialog';
import StatusBadge from '@components/shared/StatusBadge';
import { Skeleton } from '@components/ui/skeleton';
import LeaveApprovalForm from '@components/forms/LeaveApprovalForm';
import { useLeave } from '@/hooks/useLeaves';
import { leaveTypeLabel } from '@/types/enums';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start py-3 border-b border-gray-100 last:border-0">
      <dt className="w-44 shrink-0 text-sm text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900">{value ?? '—'}</dd>
    </div>
  );
}

export default function LeaveDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { leave, isLoading, error } = useLeave(id);
  const [modal, setModal] = useState<'approve' | 'reject' | null>(null);

  if (isLoading) {
    return (
      <AdminLayout breadcrumb={[{ label: 'Leave', href: '/leave' }, { label: '…' }]}>
        <Skeleton className="h-64 w-full max-w-xl" />
      </AdminLayout>
    );
  }
  if (error || !leave) {
    return (
      <AdminLayout breadcrumb={[{ label: 'Leave', href: '/leave' }, { label: 'Not Found' }]}>
        <p className="text-sm text-gray-500">Leave request not found.</p>
      </AdminLayout>
    );
  }

  const empLabel = leave.employeeName ?? leave.employeeId;

  return (
    <AdminLayout breadcrumb={[{ label: 'Leave', href: '/leave' }, { label: 'Leave Request' }]}>
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Leave Request</h1>
          {leave.status === 'pending' && (
            <div className="flex gap-2">
              <Button onClick={() => setModal('approve')}>Approve</Button>
              <Button variant="destructive" onClick={() => setModal('reject')}>Reject</Button>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <dl>
            <Row label="Employee"     value={empLabel} />
            <Row label="Leave Type"   value={leaveTypeLabel(leave.leaveType)} />
            <Row label="Start Date"   value={format(parseISO(leave.startDate), 'dd MMM yyyy')} />
            <Row label="End Date"     value={format(parseISO(leave.endDate),   'dd MMM yyyy')} />
            <Row label="Days"         value={leave.totalDays} />
            {leave.duration === 'half' && <Row label="Half Day" value={leave.halfDayPeriod ?? '—'} />}
            <Row label="Reason"       value={leave.reason} />
            <Row label="Status"       value={<StatusBadge status={leave.status} />} />
            {leave.reviewedAt  && <Row label="Reviewed At"  value={format(parseISO(leave.reviewedAt), 'dd MMM yyyy HH:mm')} />}
            {leave.reviewRemarks && <Row label="Remark"      value={leave.reviewRemarks} />}
            <Row label="Applied On"   value={format(parseISO(leave.createdAt), 'dd MMM yyyy')} />
          </dl>
        </div>
      </div>

      {modal && (
        <Dialog open title={modal === 'approve' ? 'Approve Leave' : 'Reject Leave'} onClose={() => setModal(null)}>
          <LeaveApprovalForm leave={leave} action={modal} onSuccess={() => { setModal(null); window.location.reload(); }} />
        </Dialog>
      )}
    </AdminLayout>
  );
}
