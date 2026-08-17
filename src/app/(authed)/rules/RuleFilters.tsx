'use client';

import { useRouter, useSearchParams } from 'next/navigation';

export function RuleFilters({
  categories,
  newspapers,
  total,
  unfilteredTotal,
  status,
}: {
  categories: { id: number; name: string }[];
  newspapers: { id: number; title: string }[];
  total: number;
  unfilteredTotal: number;
  status: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function update(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
    router.push(`?${params.toString()}`, { scroll: false });
  }

  function clearAll() {
    router.push(`?status=${status}`, { scroll: false });
  }

  const sel = (k: string) => searchParams.get(k) ?? '';
  const activeCount = ['cat', 'np'].filter((k) => searchParams.get(k)).length;

  return (
    <div className="filter-bar">
      <div className="field">
        <label>Category</label>
        <select value={sel('cat')} onChange={(e) => update('cat', e.target.value || null)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Newspaper</label>
        <select value={sel('np')} onChange={(e) => update('np', e.target.value || null)}>
          <option value="">All newspapers</option>
          {newspapers.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-bar-actions">
        <span className="muted">
          Showing <strong>{total}</strong> of {unfilteredTotal} {status} rule(s)
          {activeCount > 0 && (
            <> · {activeCount} filter{activeCount === 1 ? '' : 's'} active</>
          )}
        </span>
        <div className="spacer" />
        {activeCount > 0 && (
          <button className="btn" onClick={clearAll}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
