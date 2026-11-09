'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@components/ui/button';
import { apiFetch } from '@lib/utils/api-client';
import type { LeaveRequest } from '@/types/api';

const approveSchema = z.object({ remark: z.string().optional() });
const rejectSchema  = z.object({ remark: z.string().min(10, 'Remark required (min 10 chars)').max(500) });

interface Props { leave: Pick<LeaveRequest, 'id'>; onSuccess: () => void; action: 'approve' | 'reject' }

interface ActionResponse { success: boolean; error?: { code?: string; message?: string } }

/**
 * Server contract (app/api/v1/leaves/[id]/{approve,reject}/route.ts):
 *   PATCH /api/v1/leaves/:id/approve   — no body
 *   PATCH /api/v1/leaves/:id/reject    — { reason?: string }
 * apiFetch() resolves with the error body on non-2xx, so `success` must be checked.
 */
export default function LeaveApprovalForm({ leave, onSuccess, action }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const schema = action === 'reject' ? rejectSchema : approveSchema;
  const { register, handleSubmit, formState: { errors } } = useForm<{ remark?: string }>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: { remark?: string }) => {
    setSubmitting(true);
    try {
      const res = await apiFetch<ActionResponse>(`/api/v1/leaves/${encodeURIComponent(leave.id)}/${action}`, {
        method: 'PATCH',
        ...(action === 'reject' ? { body: JSON.stringify({ reason: data.remark }) } : {}),
      });
      if (!res?.success) {
        toast.error(res?.error?.message ?? `Failed to ${action} leave`);
        return;
      }
      toast.success(`Leave ${action === 'approve' ? 'approved' : 'rejected'}`);
      onSuccess();
    } catch (err: unknown) {
      toast.error((err as { message?: string }).message ?? `Failed to ${action} leave`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {action === 'reject' ? (
        <div>
          <label htmlFor="leave-reject-reason" className="block text-sm font-medium text-gray-700 mb-1">
            Rejection Reason *
          </label>
          <textarea
            id="leave-reject-reason"
            rows={3}
            placeholder="State reason for rejection (min 10 chars)"
            className="flex w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-600 focus:border-blue-600 resize-y"
            {...register('remark')}
          />
          {errors.remark && <p className="mt-1 text-xs text-red-600">{errors.remark.message}</p>}
        </div>
      ) : (
        <p className="text-sm text-gray-600">Approve this leave request? The employee will be notified.</p>
      )}
      <div className="flex justify-end gap-3">
        <Button
          type="submit"
          variant={action === 'reject' ? 'destructive' : 'default'}
          loading={submitting}
        >
          {action === 'approve' ? 'Approve Leave' : 'Reject Leave'}
        </Button>
      </div>
    </form>
  );
}
