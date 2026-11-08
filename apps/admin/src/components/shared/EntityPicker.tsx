'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, X, Loader2 } from 'lucide-react';
import { cn } from '@lib/utils/cn';
import { apiFetch } from '@lib/utils/api-client';

interface EntityPickerProps {
  endpoint: string;
  value: string;
  onChange: (id: string, label?: string) => void;
  placeholder?: string;
  labelKey?: string;
  subLabelKey?: string;
  disabled?: boolean;
  allowClear?: boolean;
  extraQuery?: Record<string, string>;
}

interface EntityOption {
  _id: string;
  [key: string]: unknown;
}

interface ApiListResp {
  success: boolean;
  data: EntityOption[];
}

export default function EntityPicker({
  endpoint,
  value,
  onChange,
  placeholder = 'Search…',
  labelKey = 'name',
  subLabelKey = 'code',
  disabled = false,
  allowClear = true,
  extraQuery = {},
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [displayLabel, setDisplayLabel] = useState('');
  const shownLabel = value ? displayLabel : '';
  // Stable dependency key for the (often inline) extraQuery object.
  const extraQueryKey = JSON.stringify(extraQuery ?? {});
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const buildLabel = (item: EntityOption) => {
    const sub = item[subLabelKey];
    const main = item[labelKey];
    return sub ? `${sub} — ${main}` : String(main ?? '');
  };

  // Resolve label when value is preset (edit mode)
  useEffect(() => {
    // No value → label is derived as '' at render time (see shownLabel), so no
    // synchronous setState is needed inside the effect.
    if (!value) return;
    let cancelled = false;
    apiFetch<{ success: boolean; data: EntityOption }>(`${endpoint}/${value}`)
      .then((res) => {
        if (!cancelled && res.success) setDisplayLabel(buildLabel(res.data));
      })
      .catch(() => { /* if not found, show empty */ });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, endpoint]);

  const fetchOptions = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const extra = JSON.parse(extraQueryKey) as Record<string, string>;
      const qp = new URLSearchParams({ search: term, limit: '10', isActive: 'true', ...extra });
      const res = await apiFetch<ApiListResp>(`${endpoint}?${qp.toString()}`);
      setOptions(res.data ?? []);
    } catch {
      setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint, extraQueryKey]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setOpen(true);
    setHighlighted(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchOptions(e.target.value), 350);
  };

  const handleOpen = () => {
    if (disabled) return;
    setOpen(true);
    setSearch('');
    fetchOptions('');
    setHighlighted(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSelect = (item: EntityOption) => {
    const label = buildLabel(item);
    setDisplayLabel(label);
    onChange(String(item._id), label);
    setOpen(false);
    setSearch('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('', '');
    setDisplayLabel('');
    setSearch('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, options.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); if (options[highlighted]) handleSelect(options[highlighted]); }
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[highlighted] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  return (
    <div ref={containerRef} className="relative">
      <div
        className={cn(
          'flex items-center border rounded-lg px-3 h-9 gap-2 bg-white cursor-pointer',
          disabled ? 'opacity-50 cursor-not-allowed bg-gray-50' : 'border-gray-300 hover:border-gray-400',
          open ? 'border-blue-500 ring-2 ring-blue-100' : '',
        )}
        onClick={handleOpen}
      >
        {open ? (
          <input
            ref={inputRef}
            className="flex-1 text-sm outline-none bg-transparent placeholder:text-gray-400"
            value={search}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className={cn('flex-1 text-sm truncate', !shownLabel && 'text-gray-400')}>
            {shownLabel || placeholder}
          </span>
        )}
        {allowClear && value && !open ? (
          <button type="button" onClick={handleClear} className="text-gray-400 hover:text-gray-600">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <ChevronDown className={cn('h-4 w-4 text-gray-400 shrink-0 transition-transform', open && 'rotate-180')} />
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-6 text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : options.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No results</p>
          ) : (
            <ul ref={listRef} className="max-h-52 overflow-y-auto py-1">
              {options.map((item, i) => (
                <li
                  key={String(item._id)}
                  className={cn(
                    'px-3 py-2 text-sm cursor-pointer',
                    i === highlighted ? 'bg-blue-50 text-blue-900' : 'hover:bg-gray-50 text-gray-900',
                  )}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(item); }}
                >
                  {buildLabel(item)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
