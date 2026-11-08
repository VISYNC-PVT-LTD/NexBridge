'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { format, parseISO } from 'date-fns';
import { Search } from 'lucide-react';
import AdminLayout from '@components/layout/AdminLayout';
import { Input } from '@components/ui/input';
import { Select } from '@components/ui/select';
import StatusBadge from '@components/shared/StatusBadge';
import Pagination from '@components/shared/Pagination';
import EmptyState from '@components/shared/EmptyState';
import { TableSkeleton } from '@components/ui/skeleton';
import Link from 'next/link';
import { useAttendance } from '@/hooks/useAttendance';
import { usePagination } from '@/hooks/usePagination';
import type { AttendanceRecord, Employee } from '@/types/api';

let _d: ReturnType<typeof setTimeout> | null = null;

function empName(r: AttendanceRecord) {
  if (typeof r.employeeId === 'object' && r.employeeId !== null) {
    const e = r.employeeId as Employee; return `${e.firstName} ${e.lastName}`;
  }
  return String(r.employeeId);
}

export default function AttendancePage() {
  const router = useRouter();
  const params = useSearchParams();
  const { page, limit, setPage, buildQuery } = usePagination(20);

  const date   = params.get('date') ?? '';
  const status = params.get('status') ?? '';
  const search = params.get('search') ?? '';

  const query = buildQuery({ date: date || undefined, status: status || undefined, search: search || undefined });
  const { records, pagination, isLoading } = useAttendance(query);

  const updateParam = (key: string, value: string) => {
    const sp = new URLSearchParams(params.toString());
    if (value) sp.set(key, value); else sp.delete(key);
    sp.set('page', '1');
    router.push(`/attendance?${sp.toString()}`);
  };

  return (
    <AdminLayout breadcrumb={[{ label: 'Attendance' }]}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Attendance</h1>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 text-sm">
            <span className="px-3 py-1.5 rounded-md bg-white text-gray-900 font-medium shadow-sm">Daily</span>
            <Link href="/attendance/weekly" className="px-3 py-1.5 rounded-md text-gray-600 hover:bg-white hover:text-gray-900 transition-colors">Weekly</Link>
            <Link href="/attendance/monthly" className="px-3 py-1.5 rounded-md text-gray-600 hover:bg-white hover:text-gray-900 transition-colors">Monthly</Link>
            <Link href="/attendance/remote-locations" className="px-3 py-1.5 rounded-md text-gray-600 hover:bg-white hover:text-gray-900 transition-colors">Remote</Link>
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input className="pl-8 w-56" placeholder="Search employee…" defaultValue={search}
              onChange={e => { if (_d) clearTimeout(_d); _d = setTimeout(() => updateParam('search', e.target.value), 400); }} />
          </div>
          <Input type="date" value={date} onChange={e => updateParam('date', e.target.value)} className="w-40" />
          <Select value={status} onChange={e => updateParam('status', e.target.value)} className="w-40">
            <option value="">All Status</option>
            <option value="present">Present</option>
            <option value="absent">Absent</option>
            <option value="half-day">Half Day</option>
            <option value="leave">Leave</option>
            <option value="holiday">Holiday</option>
            <option value="weekend">Weekend</option>
          </Select>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Employee', 'Date', 'Status', 'Check-in', 'Check-out', 'Hours'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            {isLoading ? <TableSkeleton rows={8} cols={6} /> : records.length === 0 ? (
              <tbody><tr><td colSpan={6}>
                <EmptyState title="No attendance records" filtered={!!(date || status || search)} onClearFilters={() => router.push('/attendance')} />
              </td></tr></tbody>
            ) : (
              <tbody>
                {records.map(r => (
                  <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{empName(r)}</td>
                    <td className="px-4 py-3 text-gray-600">{format(parseISO(r.date), 'dd MMM yy')}</td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{r.checkIn  ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">
                      {r.checkOut ?? (r.missedCheckout
                        ? <span className="font-sans text-red-600">Missed{r.hasUnresolvedMissedCheckout ? ' (unresolved)' : ''}</span>
                        : r.isCheckedIn ? <span className="font-sans text-green-700">Checked in</span> : '—')}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.workHours != null ? `${r.workHours}h` : '—'}</td>
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
    </AdminLayout>
  );
}
