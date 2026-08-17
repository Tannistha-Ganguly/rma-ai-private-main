'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { FilterOptions } from './data';

const RO_REASON_LABELS: Record<number, string> = {
  1: 'Missing Contact',
  2: 'Wrong Abbreviations',
  4: 'Incorrect Categorization',
  10: 'Edit Ad Matter',
  11: 'Newspaper Does Not Accept',
  12: 'Exceeds Word Limit',
  13: 'Improper Spacing',
  18: 'Unidentified Characters',
  109: 'Spam',
  137: 'Editorially Disapproved',
  150: 'Category Missing',
  207: 'Verify Content',
};

const FILTER_KEYS = [
  'severity',
  'rule_type',
  'target_reason',
  'source',
  'cat',
  'np',
  'q',
] as const;

export function ProposalFilters({
  options,
  total,
  unfilteredTotal,
  status,
}: {
  options: FilterOptions;
  total: number;
  unfilteredTotal: number;
  status: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function buildHref(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([k, v]) => {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    });
    return `?${params.toString()}`;
  }

  function update(key: string, value: string | null) {
    router.push(buildHref({ [key]: value }), { scroll: false });
  }

  // Debounced free-text input
  const [q, setQ] = useState(searchParams.get('q') ?? '');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      const current = searchParams.get('q') ?? '';
      if (q !== current) update('q', q || null);
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function clearAll() {
    const params = new URLSearchParams();
    params.set('status', status);
    setQ('');
    router.push(`?${params.toString()}`, { scroll: false });
  }

  const activeFilterCount = FILTER_KEYS.filter((k) => searchParams.get(k)).length;

  const sel = (k: string) => searchParams.get(k) ?? '';

  return (
    <div className="filter-bar">
      <div className="field">
        <label>Search</label>
        <input
          type="text"
          placeholder="name, message, description…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Category</label>
        <select value={sel('cat')} onChange={(e) => update('cat', e.target.value || null)}>
          <option value="">All</option>
          {options.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.count})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Newspaper</label>
        <select value={sel('np')} onChange={(e) => update('np', e.target.value || null)}>
          <option value="">All</option>
          {options.newspapers.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title} ({n.count})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Target RO reason</label>
        <select value={sel('target_reason')} onChange={(e) => update('target_reason', e.target.value || null)}>
          <option value="">All</option>
          {options.targetReasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} · {RO_REASON_LABELS[r.id] ?? '?'} ({r.count})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Severity</label>
        <select value={sel('severity')} onChange={(e) => update('severity', e.target.value || null)}>
          <option value="">All</option>
          {options.severities.map((s) => (
            <option key={s.value} value={s.value}>
              {s.value} ({s.count})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Rule type</label>
        <select value={sel('rule_type')} onChange={(e) => update('rule_type', e.target.value || null)}>
          <option value="">All</option>
          {options.ruleTypes.map((r) => (
            <option key={r.value} value={r.value}>
              {r.value} ({r.count})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Source</label>
        <select value={sel('source')} onChange={(e) => update('source', e.target.value || null)}>
          <option value="">All</option>
          {options.sources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.value} ({s.count})
            </option>
          ))}
        </select>
      </div>

      <div className="filter-bar-actions">
        <span className="muted">
          Showing <strong>{total}</strong> of {unfilteredTotal} {status}
          {activeFilterCount > 0 && <> · {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active</>}
        </span>
        <div className="spacer" />
        {activeFilterCount > 0 && (
          <button className="btn" onClick={clearAll}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
