'use client';
import { useState, useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@components/ui/button';
import { Input } from '@components/ui/input';
import { apiFetch } from '@lib/utils/api-client';
import type { Settings } from '@/types/api';

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Mirrors SettingsService.updateShift (the server is authoritative).
export const shiftFormSchema = z.object({
  startTime:              z.string().min(1, 'Required'),
  endTime:                z.string().min(1, 'Required'),
  gracePeriodMinutes:     z.coerce.number().min(0).max(120),
  halfDayLateCheckInTime: z.string().min(1, 'Required'),
}).superRefine((v, ctx) => {
  if (v.startTime === v.endTime) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'End time cannot equal start time.' });
    return;
  }
  const start = toMin(v.startTime), end = toMin(v.endTime), cutoff = toMin(v.halfDayLateCheckInTime);
  if (end > start && !(cutoff > start && cutoff <= end)) {
    ctx.addIssue({ code: 'custom', path: ['halfDayLateCheckInTime'], message: 'Must be after the start time and no later than the end time.' });
  }
  if (end < start && !(cutoff > start)) {
    ctx.addIssue({ code: 'custom', path: ['halfDayLateCheckInTime'], message: 'For a shift ending after midnight, must be after the start time and before midnight.' });
  }
});
type Form = z.infer<typeof shiftFormSchema>;

interface Props { settings?: Settings; onSuccess?: () => void }

export default function SettingsShiftForm({ settings, onSuccess }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const toForm = (s?: Settings['shift']): Form => ({
    startTime: s?.startTime ?? '09:00',
    endTime: s?.endTime ?? '18:00',
    gracePeriodMinutes: s?.gracePeriodMinutes ?? 15,
    halfDayLateCheckInTime: s?.halfDayLateCheckInTime ?? '14:00',
  });
  const { register, handleSubmit, reset, control, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(shiftFormSchema),
    defaultValues: toForm(settings?.shift),
  });

  useEffect(() => { if (settings?.shift) reset(toForm(settings.shift)); }, [settings, reset]);

  const startTime = useWatch({ control, name: 'startTime' });
  const endTime = useWatch({ control, name: 'endTime' });
  const overnight = !!startTime && !!endTime && toMin(endTime) < toMin(startTime);

  const onSubmit = async (data: Form) => {
    setSubmitting(true);
    try {
      // apiFetch resolves with the error body on non-2xx, so check `success`.
      const res = await apiFetch<{ success: boolean; error?: { message?: string } }>('/api/v1/settings', { method: 'PATCH', body: JSON.stringify({ shift: data }) });
      if (!res?.success) { toast.error(res?.error?.message ?? 'Failed to update settings'); return; }
      toast.success('Shift settings updated');
      onSuccess?.();
    } catch { toast.error('Failed to update settings'); }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4 max-w-md">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="shift-start" className="block text-sm font-medium text-gray-700 mb-1">Start Time *</label>
          <Input id="shift-start" type="time" error={!!errors.startTime} {...register('startTime')} />
          {errors.startTime && <p className="mt-1 text-xs text-red-600">{errors.startTime.message}</p>}
        </div>
        <div>
          <label htmlFor="shift-end" className="block text-sm font-medium text-gray-700 mb-1">End Time *</label>
          <Input id="shift-end" type="time" error={!!errors.endTime} {...register('endTime')} />
          {errors.endTime && <p className="mt-1 text-xs text-red-600">{errors.endTime.message}</p>}
        </div>
      </div>
      {overnight && (
        <p className="text-xs text-amber-700">This shift ends after midnight. Check-ins after midnight are not evaluated for late arrival.</p>
      )}
      <div>
        <label htmlFor="shift-grace" className="block text-sm font-medium text-gray-700 mb-1">Grace Period (minutes)</label>
        <Input id="shift-grace" type="number" min={0} max={120} error={!!errors.gracePeriodMinutes} {...register('gracePeriodMinutes')} />
        {errors.gracePeriodMinutes && <p className="mt-1 text-xs text-red-600">{errors.gracePeriodMinutes.message}</p>}
      </div>
      <div>
        <label htmlFor="shift-halfday" className="block text-sm font-medium text-gray-700 mb-1">Half-day if checking in at or after *</label>
        <Input id="shift-halfday" type="time" error={!!errors.halfDayLateCheckInTime} {...register('halfDayLateCheckInTime')} />
        {errors.halfDayLateCheckInTime && <p className="mt-1 text-xs text-red-600">{errors.halfDayLateCheckInTime.message}</p>}
      </div>
      <Button type="submit" loading={submitting}>Save Changes</Button>
    </form>
  );
}
