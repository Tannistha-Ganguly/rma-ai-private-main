'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { searchCategories, type CategorySearchHit } from '../actions';
import type { ResolvedCategory } from './data';

interface Selected {
  id: number;
  name: string;
  parentName?: string | null;
  npId?: number | null;
  npTitle?: string | null;
}

export function CategoryPicker({
  initialSelected,
  onChange,
}: {
  initialSelected: ResolvedCategory[];
  onChange: (ids: number[]) => void;
}) {
  const [selected, setSelected] = useState<Selected[]>(() =>
    initialSelected.map((c) => ({ id: c.id, name: c.name, npId: c.npId, npTitle: c.npTitle })),
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CategorySearchHit[]>([]);
  const [pending, startTransition] = useTransition();
  const lastQueryRef = useRef('');

  // Debounced server search. Triggers at 2+ chars; clears below.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      lastQueryRef.current = q;
      return;
    }
    const timer = setTimeout(() => {
      lastQueryRef.current = q;
      startTransition(async () => {
        try {
          const hits = await searchCategories(q, 30);
          // Guard against stale responses out-running newer queries.
          if (lastQueryRef.current === q) setResults(hits);
        } catch {
          setResults([]);
        }
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  function notify(next: Selected[]) {
    onChange(next.map((s) => s.id));
  }

  function add(hit: CategorySearchHit) {
    if (selected.some((s) => s.id === hit.id)) return;
    const next = [
      ...selected,
      { id: hit.id, name: hit.name, parentName: hit.parentName, npId: hit.npId, npTitle: hit.npTitle },
    ];
    setSelected(next);
    notify(next);
  }

  function remove(id: number) {
    const next = selected.filter((s) => s.id !== id);
    setSelected(next);
    notify(next);
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          padding: 6,
          border: '1px solid var(--border)',
          borderRadius: 4,
          background: '#fafafa',
          minHeight: 36,
        }}
      >
        {selected.length === 0 && (
          <span className="muted" style={{ fontSize: 12, padding: '4px 6px' }}>
            No categories selected — rule will apply to <strong>all categories</strong>.
          </span>
        )}
        {selected.map((s) => (
          <span
            key={s.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px',
              background: 'var(--soft-bg)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              fontSize: 12,
            }}
          >
            {s.name} <span className="muted">#{s.id}</span>
            {s.npId != null && (
              <span className="muted">
                · in {s.npTitle ?? `np#${s.npId}`} <span style={{ opacity: 0.6 }}>(#{s.npId})</span>
              </span>
            )}
            <button
              type="button"
              onClick={() => remove(s.id)}
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                padding: 0,
                marginLeft: 2,
                fontSize: 14,
                lineHeight: 1,
                color: 'var(--muted)',
              }}
              aria-label={`Remove ${s.name}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <input
        type="text"
        placeholder="Search categories by name (type at least 2 characters)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginTop: 6 }}
      />

      {query.trim().length >= 2 && (
        <div
          style={{
            marginTop: 4,
            border: '1px solid var(--border)',
            borderRadius: 4,
            maxHeight: 240,
            overflow: 'auto',
            background: '#fff',
          }}
        >
          {pending && (
            <div className="muted" style={{ padding: 6, fontSize: 12 }}>
              Searching…
            </div>
          )}
          {!pending && results.length === 0 && (
            <div className="muted" style={{ padding: 6, fontSize: 12 }}>
              No categories match &ldquo;{query.trim()}&rdquo;.
            </div>
          )}
          {results.map((r) => {
            const already = selected.some((s) => s.id === r.id);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => add(r)}
                disabled={already}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 6px',
                  border: 'none',
                  background: already ? '#f3f4f6' : 'transparent',
                  cursor: already ? 'default' : 'pointer',
                  fontSize: 12,
                  color: 'var(--text)',
                }}
              >
                {r.name} <span className="muted">#{r.id}</span>
                {r.parentName && <span className="muted"> · under {r.parentName}</span>}
                {r.npId != null && (
                  <span className="muted">
                    {' · '}
                    <strong>{r.npTitle ?? `np#${r.npId}`}</strong> (#{r.npId})
                  </span>
                )}
                {already && <span className="muted"> · already selected</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
