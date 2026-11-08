'use client';
import { useParams } from 'next/navigation';
import { format, parseISO } from 'date-fns';
import AdminLayout from '@components/layout/AdminLayout';
import StatusBadge from '@components/shared/StatusBadge';
import { Skeleton } from '@components/ui/skeleton';
import { useAttendanceRecord } from '@/hooks/useAttendance';

type HistoryDay = {
  dateString: string;
  status: string;
  totalMinutes: number;
  hasUnresolvedMissedCheckout?: boolean;
  sessions?: Array<{ checkInTimestamp: string; checkOutTimestamp: string | null; missedCheckout?: boolean }>;
};

export default function AttendanceEmployeePage() {
  const { id } = useParams<{ id: string }>();
  const { record, isLoading, error } = useAttendanceRecord(id);

  if (isLoading) {
    return (
      <AdminLayout breadcrumb={[{ label: 'Attendance', href: '/attendance' }, { label: '…' }]}>
        <Skeleton className="h-64 w-full max-w-2xl" />
      </AdminLayout>
    );
  }
  if (error || !record) {
    return (
      <AdminLayout breadcrumb={[{ label: 'Attendance', href: '/attendance' }, { label: 'Not Found' }]}>
        <p className="text-sm text-gray-500">No attendance record found.</p>
      </AdminLayout>
    );
  }

  const records = (Array.isArray(record) ? record : [record]) as unknown as HistoryDay[];

  return (
    <AdminLayout breadcrumb={[{ label: 'Attendance', href: '/attendance' }, { label: 'Employee Attendance' }]}>
      <div className="max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold text-gray-900">Employee Attendance</h1>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Date', 'Status', 'Check-in', 'Check-out', 'Hours'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r: HistoryDay) => {
                // Contract: GET /api/v1/attendance/:employeeId returns history day
                // records (dateString + sessions), not admin-list rows.
                const sessions = r.sessions ?? [];
                const first = sessions[0];
                const last = sessions[sessions.length - 1];
                const fmt = (iso?: string | null) => (iso ? format(parseISO(iso), 'HH:mm') : null);
                const missed = sessions.some((x) => x.missedCheckout);
                return (
                  <tr key={r.dateString} className="border-b border-gray-100">
                    <td className="px-4 py-3">{format(parseISO(r.dateString), 'dd MMM yyyy')}</td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 font-mono text-xs">{fmt(first?.checkInTimestamp) ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {fmt(last?.checkOutTimestamp) ?? (missed
                        ? <span className="font-sans text-red-600">Missed{r.hasUnresolvedMissedCheckout ? ' (unresolved)' : ''}</span>
                        : '—')}
                    </td>
                    <td className="px-4 py-3">{r.totalMinutes > 0 ? `${Math.round((r.totalMinutes / 60) * 10) / 10}h` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
