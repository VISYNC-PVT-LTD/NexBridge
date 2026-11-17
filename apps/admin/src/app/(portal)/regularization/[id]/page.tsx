'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { format, parseISO } from 'date-fns';
import AdminLayout from '@components/layout/AdminLayout';
import { Button } from '@components/ui/button';
import { Dialog } from '@components/ui/dialog';
import StatusBadge from '@components/shared/StatusBadge';
import { Skeleton } from '@components/ui/skeleton';
import RegularizationApprovalForm from '@components/forms/RegularizationApprovalForm';
import { useRegularization } from '@/hooks/useRegularizations';
import type { Employee } from '@/types/api';

const TYPE_LABELS: Record<string, string> = {
  forgotCheckIn: 'Forgot Check-in', forgotCheckOut: 'Forgot Check-out',
  workAwayFromOffice: 'Work Away From Office', officialTravel: 'Official Travel', clientVisit: 'Client Visit',
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start py-3 border-b border-gray-100 last:border-0">
      <dt className="w-44 shrink-0 text-sm text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900">{value ?? '—'}</dd>
    </div>
  );
}

export default function RegularizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { regularization: reg, isLoading, error } = useRegularization(id);
  const [modal, setModal] = useState<'approve' | 'reject' | null>(null);

  if (isLoading) {
    return (
      <AdminLayout breadcrumb={[{ label: 'Regularization', href: '/regularization' }, { label: '…' }]}>
        <Skeleton className="h-64 w-full max-w-xl" />
      </AdminLayout>
    );
  }
  if (error || !reg) {
    return (
      <AdminLayout breadcrumb={[{ label: 'Regularization', href: '/regularization' }, { label: 'Not Found' }]}>
        <p className="text-sm text-gray-500">Request not found.</p>
      </AdminLayout>
    );
  }

  const emp = typeof reg.employeeId === 'object' ? reg.employeeId as Employee : null;

  return (
    <AdminLayout breadcrumb={[{ label: 'Regularization', href: '/regularization' }, { label: 'Request' }]}>
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Regularization Request</h1>
          {reg.status === 'pending' && (
            <div className="flex gap-2">
              <Button onClick={() => setModal('approve')}>Approve</Button>
              <Button variant="destructive" onClick={() => setModal('reject')}>Reject</Button>
            </div>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <dl>
            <Row label="Employee"   value={emp ? `${emp.firstName} ${emp.lastName}` : String(reg.employeeId)} />
            <Row label="Date"       value={format(parseISO(reg.date), 'dd MMM yyyy')} />
            <Row label="Type"       value={TYPE_LABELS[reg.type] ?? reg.type} />
            <Row label="Reason"     value={reg.reason} />
            <Row label="Status"     value={<StatusBadge status={reg.status} />} />
            {reg.requestedCheckIn  && <Row label="Requested Check-in"  value={reg.requestedCheckInLocal  ?? reg.requestedCheckIn} />}
            {reg.requestedCheckOut && <Row label="Requested Check-out" value={reg.requestedCheckOutLocal ?? reg.requestedCheckOut} />}
            {reg.reviewedAt        && <Row label="Reviewed At"         value={format(parseISO(reg.reviewedAt), 'dd MMM yyyy HH:mm')} />}
            {reg.reviewRemark      && <Row label="Remark"              value={reg.reviewRemark} />}
            <Row label="Submitted" value={format(parseISO(reg.createdAt), 'dd MMM yyyy')} />
          </dl>
        </div>
      </div>

      {modal && (
        <Dialog open title={modal === 'approve' ? 'Approve Regularization' : 'Reject Regularization'} onClose={() => setModal(null)}>
          <RegularizationApprovalForm reg={reg} action={modal} onSuccess={() => { setModal(null); window.location.reload(); }} />
        </Dialog>
      )}
    </AdminLayout>
  );
}
