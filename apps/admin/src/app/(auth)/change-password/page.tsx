'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Hexagon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@components/ui/button';
import { Input } from '@components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { apiFetch, getSessionId, setAccessToken } from '@lib/utils/api-client';

const schema = z.object({
  currentPassword: z.string().min(1, 'Current password required'),
  newPassword: z.string().min(8, 'Minimum 8 characters')
    .regex(/[A-Z]/, 'Must contain uppercase')
    .regex(/[0-9]/, 'Must contain a number'),
  confirm: z.string(),
}).refine(d => d.newPassword === d.confirm, { message: 'Passwords do not match', path: ['confirm'] });
type Form = z.infer<typeof schema>;

export default function ChangePasswordPage() {
  const { user, refreshUser, loading } = useAuth();
  const router = useRouter();
  const [show, setShow] = useState({ current: false, new: false, confirm: false });
  const [submitting, setSubmitting] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  const onSubmit = async (data: Form) => {
    setSubmitting(true);
    try {
      const sessionId = getSessionId();
      // apiFetch resolves with the error body on 4xx — it does not throw.
      const res = await apiFetch<{
        success: boolean;
        data?: { accessToken?: string };
        error?: { code?: string };
      }>('/api/v1/auth/me/change-password', {
        method: 'PATCH',
        body: JSON.stringify({
          currentPassword: data.currentPassword,
          newPassword: data.newPassword,
          ...(sessionId ? { sessionId } : {}),
        }),
      });
      if (!res?.success) {
        const code = res?.error?.code ?? '';
        toast.error(
          code === 'AUTH_001' ? 'Current password is incorrect.'
            : code === 'GEN_003' ? 'Too many attempts. Please wait and try again.'
            : 'Failed to update password.',
        );
        return;
      }
      if (res.data?.accessToken) setAccessToken(res.data.accessToken);
      await refreshUser();
      toast.success('Password updated successfully');
      router.replace('/dashboard');
    } catch {
      toast.error('Failed to update password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="text-center mb-8">
        <div className="flex justify-center mb-3"><Hexagon className="h-10 w-10 text-blue-600" /></div>
        <h1 className="text-xl font-semibold text-gray-900">Genesis</h1>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Change Password</h2>
        {user?.requiresPasswordChange && (
          <p className="text-sm text-amber-600 mb-4">You must change your password before continuing.</p>
        )}
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4 mt-5">
          {(
            [
              { field: 'current' as const, label: 'Current Password', key: 'currentPassword' as const },
              { field: 'new' as const, label: 'New Password', key: 'newPassword' as const },
              { field: 'confirm' as const, label: 'Confirm New Password', key: 'confirm' as const },
            ]
          ).map(({ field, label, key }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
              <div className="relative">
                <Input type={show[field] ? 'text' : 'password'} error={!!errors[key]} className="pr-10" {...register(key)} />
                <button type="button" onClick={() => setShow(s => ({ ...s, [field]: !s[field] }))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  aria-label={show[field] ? 'Hide' : 'Show'}>
                  {show[field] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors[key] && <p className="mt-1 text-xs text-red-600">{errors[key]?.message}</p>}
            </div>
          ))}
          <Button type="submit" className="w-full" loading={submitting}>Update Password</Button>
        </form>
      </div>
    </div>
  );
}
