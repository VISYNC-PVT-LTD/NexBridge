'use client';
import { useEffect, useState } from 'react';
import AdminLayout from '@components/layout/AdminLayout';
import { Skeleton } from '@components/ui/skeleton';
import { apiFetch } from '@lib/utils/api-client';
import { toast } from 'sonner';

interface MonthSlab { upToGross: number; amount: number }
interface StatutoryConfig {
  enabled: boolean;
  pf:   { enabled: boolean; employeeRate: number; employerRate: number; wagesCeiling: number };
  esic: { enabled: boolean; employeeRate: number; employerRate: number; wagesCeiling: number };
  pt:   { enabled: boolean; state: string; monthlySlabs: MonthSlab[] };
  tds:  { enabled: boolean; flatRate: number };
}

const DEFAULTS: StatutoryConfig = {
  enabled: false,
  pf:   { enabled: false, employeeRate: 12,   employerRate: 12,   wagesCeiling: 15000 },
  esic: { enabled: false, employeeRate: 0.75, employerRate: 3.25, wagesCeiling: 21000 },
  pt:   { enabled: false, state: '', monthlySlabs: [] },
  tds:  { enabled: false, flatRate: 10 },
};

function NumInput({ label, value, onChange, step = 1, min = 0 }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="w-44 text-sm text-gray-700 shrink-0">{label}</label>
      <input
        type="number" step={step} min={min}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-32 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <div
        role="checkbox" aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </div>
      <span className="text-sm font-medium text-gray-800">{label}</span>
    </label>
  );
}

export default function StatutorySettingsPage() {
  const [cfg, setCfg] = useState<StatutoryConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Initial load. `loading` starts true; state is only set from the async
  // callbacks (never synchronously inside the effect), and not after unmount.
  useEffect(() => {
    let active = true;
    apiFetch<{ data: StatutoryConfig }>('/api/v1/settings/statutory')
      .then((data) => { if (active) setCfg({ ...DEFAULTS, ...data.data }); })
      .catch(() => { if (active) toast.error('Failed to load statutory settings'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save() {
    setSaving(true);
    try {
      await apiFetch('/api/v1/settings/statutory', {
        method: 'PUT',
        body: JSON.stringify(cfg),
      });
      toast.success('Statutory settings saved');
    } catch {
      toast.error('Failed to save statutory settings');
    } finally {
      setSaving(false);
    }
  }

  function setPF<K extends keyof StatutoryConfig['pf']>(k: K, v: StatutoryConfig['pf'][K]) {
    setCfg((c) => ({ ...c, pf: { ...c.pf, [k]: v } }));
  }
  function setESIC<K extends keyof StatutoryConfig['esic']>(k: K, v: StatutoryConfig['esic'][K]) {
    setCfg((c) => ({ ...c, esic: { ...c.esic, [k]: v } }));
  }
  function setPT<K extends keyof StatutoryConfig['pt']>(k: K, v: StatutoryConfig['pt'][K]) {
    setCfg((c) => ({ ...c, pt: { ...c.pt, [k]: v } }));
  }
  function setTDS<K extends keyof StatutoryConfig['tds']>(k: K, v: StatutoryConfig['tds'][K]) {
    setCfg((c) => ({ ...c, tds: { ...c.tds, [k]: v } }));
  }

  function addSlab() {
    setCfg((c) => ({ ...c, pt: { ...c.pt, monthlySlabs: [...c.pt.monthlySlabs, { upToGross: 0, amount: 0 }] } }));
  }
  function removeSlab(i: number) {
    setCfg((c) => ({ ...c, pt: { ...c.pt, monthlySlabs: c.pt.monthlySlabs.filter((_, idx) => idx !== i) } }));
  }
  function updateSlab(i: number, k: keyof MonthSlab, v: number) {
    setCfg((c) => {
      const slabs = [...c.pt.monthlySlabs];
      slabs[i] = { ...slabs[i], [k]: v };
      return { ...c, pt: { ...c.pt, monthlySlabs: slabs } };
    });
  }

  if (loading) {
    return (
      <AdminLayout breadcrumb={[{ label: 'Settings', href: '/settings' }, { label: 'Statutory Deductions' }]}>
        <Skeleton className="h-64 w-full max-w-2xl" />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout breadcrumb={[{ label: 'Settings', href: '/settings' }, { label: 'Statutory Deductions' }]}>
      <div className="max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Statutory Deductions</h1>
          <button
            onClick={save} disabled={saving}
            className="px-4 py-2 rounded-md bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        <p className="text-sm text-gray-500">
          Statutory deductions are <strong>disabled by default</strong>. When enabled, deductions are
          computed during payroll and subtracted from net salary. Verify rates with your CA before enabling.
        </p>

        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <Toggle label="Enable statutory deductions" checked={cfg.enabled} onChange={(v) => setCfg((c) => ({ ...c, enabled: v }))} />
        </div>

        {/* PF */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <Toggle label="Provident Fund (PF)" checked={cfg.pf.enabled} onChange={(v) => setPF('enabled', v)} />
          {cfg.pf.enabled && (
            <div className="pl-2 space-y-3">
              <NumInput label="Employee rate (%)" value={cfg.pf.employeeRate} onChange={(v) => setPF('employeeRate', v)} step={0.01} />
              <NumInput label="Employer rate (%)" value={cfg.pf.employerRate} onChange={(v) => setPF('employerRate', v)} step={0.01} />
              <NumInput label="Wages ceiling (₹)" value={cfg.pf.wagesCeiling} onChange={(v) => setPF('wagesCeiling', v)} step={500} />
            </div>
          )}
        </div>

        {/* ESIC */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <Toggle label="ESIC" checked={cfg.esic.enabled} onChange={(v) => setESIC('enabled', v)} />
          {cfg.esic.enabled && (
            <div className="pl-2 space-y-3">
              <NumInput label="Employee rate (%)" value={cfg.esic.employeeRate} onChange={(v) => setESIC('employeeRate', v)} step={0.01} />
              <NumInput label="Employer rate (%)" value={cfg.esic.employerRate} onChange={(v) => setESIC('employerRate', v)} step={0.01} />
              <NumInput label="Wages ceiling (₹)" value={cfg.esic.wagesCeiling} onChange={(v) => setESIC('wagesCeiling', v)} step={500} />
            </div>
          )}
        </div>

        {/* Professional Tax */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <Toggle label="Professional Tax (PT)" checked={cfg.pt.enabled} onChange={(v) => setPT('enabled', v)} />
          {cfg.pt.enabled && (
            <div className="pl-2 space-y-4">
              <div className="flex items-center gap-3">
                <label className="w-44 text-sm text-gray-700 shrink-0">State</label>
                <input
                  type="text" value={cfg.pt.state} maxLength={50}
                  onChange={(e) => setPT('state', e.target.value)}
                  placeholder="e.g. Maharashtra"
                  className="w-48 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-600">Monthly slabs</p>
                {cfg.pt.monthlySlabs.map((slab, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-20">Up to gross</span>
                    <input
                      type="number" min={0} value={slab.upToGross}
                      onChange={(e) => updateSlab(i, 'upToGross', parseFloat(e.target.value) || 0)}
                      className="w-28 rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="text-xs text-gray-500">PT amount</span>
                    <input
                      type="number" min={0} value={slab.amount}
                      onChange={(e) => updateSlab(i, 'amount', parseFloat(e.target.value) || 0)}
                      className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button onClick={() => removeSlab(i)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                  </div>
                ))}
                <button onClick={addSlab} className="text-xs text-blue-600 hover:underline">+ Add slab</button>
              </div>
            </div>
          )}
        </div>

        {/* TDS */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <Toggle label="TDS (flat rate)" checked={cfg.tds.enabled} onChange={(v) => setTDS('enabled', v)} />
          {cfg.tds.enabled && (
            <div className="pl-2">
              <NumInput label="Flat rate (%)" value={cfg.tds.flatRate} onChange={(v) => setTDS('flatRate', v)} step={0.1} />
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
