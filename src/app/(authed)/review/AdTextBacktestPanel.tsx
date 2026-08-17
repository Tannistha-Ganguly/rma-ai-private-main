'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  listNewspapersForCheck,
  runOnDemandCheckText,
  searchCategories,
  type CategorySearchHit,
  type NewspaperOptionForCheck,
  type OnDemandTextCheckResult,
  type OnDemandTextCheckError,
} from '../actions';

type Result = OnDemandTextCheckResult | OnDemandTextCheckError;

interface PickedCategory {
  id: number;
  name: string;
  parentName?: string | null;
  npTitle?: string | null;
  npId?: number | null;
}

export function AdTextBacktestPanel() {
  const [newspapers, setNewspapers] = useState<NewspaperOptionForCheck[] | null>(null);
  const [npSearch, setNpSearch] = useState('');
  const [npId, setNpId] = useState<number | null>(null);

  const [catQuery, setCatQuery] = useState('');
  const [catResults, setCatResults] = useState<CategorySearchHit[]>([]);
  const [catSearching, startCatSearch] = useTransition();
  const [picked, setPicked] = useState<PickedCategory | null>(null);
  const lastCatQuery = useRef('');

  const [adText, setAdText] = useState('');
  const [pending, startRun] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let cancelled = false;
    listNewspapersForCheck()
      .then((rows) => { if (!cancelled) setNewspapers(rows); })
      .catch(() => { if (!cancelled) setNewspapers([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const q = catQuery.trim();
    if (q.length < 2) {
      setCatResults([]);
      lastCatQuery.current = q;
      return;
    }
    const t = setTimeout(() => {
      lastCatQuery.current = q;
      startCatSearch(async () => {
        try {
          const hits = await searchCategories(q, 30);
          if (lastCatQuery.current === q) setCatResults(hits);
        } catch {
          setCatResults([]);
        }
      });
    }, 250);
    return () => clearTimeout(t);
  }, [catQuery]);

  const filteredNewspapers = npSearch.trim()
    ? (newspapers ?? []).filter((n) => n.title.toLowerCase().includes(npSearch.trim().toLowerCase()))
    : (newspapers ?? []);

  const selectedNewspaper = npId != null ? (newspapers ?? []).find((n) => n.np_id === npId) ?? null : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adText.trim()) {
      setResult({ ok: false, error: 'Paste some ad text first' });
      return;
    }
    setResult(null);
    startRun(async () => {
      const r = await runOnDemandCheckText(adText, npId, picked?.id ?? null);
      setResult(r);
    });
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Backtest on demand · ad text</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Paste an ad and (optionally) pick a newspaper and category to see which active
        rules would catch it. Useful for sanity-checking coverage without a real ad ID.
        Result is not saved.
      </p>

      <form onSubmit={submit}>
        <div className="field" style={{ marginBottom: 8 }}>
          <label>Newspaper (optional)</label>
          {selectedNewspaper ? (
            <div className="flex" style={{ gap: 6 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  background: 'var(--soft-bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 999,
                  fontSize: 12,
                }}
              >
                {selectedNewspaper.title} <span className="muted">#{selectedNewspaper.np_id}</span>
                <button
                  type="button"
                  onClick={() => setNpId(null)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 0,
                    marginLeft: 4,
                    fontSize: 14,
                    lineHeight: 1,
                    color: 'var(--muted)',
                  }}
                  aria-label="Clear newspaper"
                >
                  ×
                </button>
              </span>
            </div>
          ) : (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: 6,
                background: '#fafafa',
              }}
            >
              <input
                type="text"
                placeholder={newspapers ? 'Filter newspapers…' : 'Loading newspapers…'}
                value={npSearch}
                onChange={(e) => setNpSearch(e.target.value)}
                disabled={!newspapers}
                style={{ marginBottom: 6 }}
              />
              <div style={{ maxHeight: 160, overflow: 'auto' }}>
                {newspapers && filteredNewspapers.length === 0 && (
                  <div className="muted" style={{ padding: 4, fontSize: 12 }}>
                    No newspapers match.
                  </div>
                )}
                {filteredNewspapers.slice(0, 200).map((n) => (
                  <button
                    key={n.np_id}
                    type="button"
                    onClick={() => { setNpId(n.np_id); setNpSearch(''); }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '4px 6px',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      fontSize: 12,
                      color: 'var(--text)',
                    }}
                  >
                    {n.title} <span className="muted">#{n.np_id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="field" style={{ marginBottom: 8 }}>
          <label>Category (optional)</label>
          {picked ? (
            <div className="flex" style={{ gap: 6 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  background: 'var(--soft-bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 999,
                  fontSize: 12,
                }}
              >
                {picked.name} <span className="muted">#{picked.id}</span>
                {picked.parentName && <span className="muted"> · under {picked.parentName}</span>}
                {picked.npId != null && (
                  <span className="muted"> · in {picked.npTitle ?? `np#${picked.npId}`}</span>
                )}
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 0,
                    marginLeft: 4,
                    fontSize: 14,
                    lineHeight: 1,
                    color: 'var(--muted)',
                  }}
                  aria-label="Clear category"
                >
                  ×
                </button>
              </span>
            </div>
          ) : (
            <>
              <input
                type="text"
                placeholder="Search categories by name (type at least 2 characters)…"
                value={catQuery}
                onChange={(e) => setCatQuery(e.target.value)}
              />
              {catQuery.trim().length >= 2 && (
                <div
                  style={{
                    marginTop: 4,
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    maxHeight: 200,
                    overflow: 'auto',
                    background: '#fff',
                  }}
                >
                  {catSearching && (
                    <div className="muted" style={{ padding: 6, fontSize: 12 }}>
                      Searching…
                    </div>
                  )}
                  {!catSearching && catResults.length === 0 && (
                    <div className="muted" style={{ padding: 6, fontSize: 12 }}>
                      No categories match.
                    </div>
                  )}
                  {catResults.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setPicked({
                          id: r.id,
                          name: r.name,
                          parentName: r.parentName,
                          npId: r.npId,
                          npTitle: r.npTitle,
                        });
                        setCatQuery('');
                        setCatResults([]);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '4px 6px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 12,
                        color: 'var(--text)',
                      }}
                    >
                      {r.name} <span className="muted">#{r.id}</span>
                      {r.parentName && <span className="muted"> · under {r.parentName}</span>}
                      {r.npId != null && (
                        <span className="muted"> · <strong>{r.npTitle ?? `np#${r.npId}`}</strong></span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="field" style={{ marginBottom: 8 }}>
          <label>Ad text</label>
          <textarea
            value={adText}
            onChange={(e) => setAdText(e.target.value)}
            disabled={pending}
            rows={6}
            placeholder="Paste the ad copy here…"
            style={{ width: '100%', padding: 8, fontFamily: 'inherit', fontSize: 13 }}
          />
        </div>

        <button type="submit" className="btn" disabled={pending || !adText.trim()}>
          {pending ? 'Running…' : 'Run'}
        </button>
      </form>

      {result && !result.ok && (
        <div style={{ marginTop: 12, color: 'var(--danger)' }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}

      {result && result.ok && <TextBacktestResult r={result} />}
    </div>
  );
}

function TextBacktestResult({ r }: { r: OnDemandTextCheckResult }) {
  const catChain = [r.category.top, r.category.sub, r.category.sub_sub, r.category.sub_sub_sub]
    .filter((x): x is number => typeof x === 'number');
  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex" style={{ marginBottom: 8 }}>
        <strong>ad text · {r.ad_text.length} chars</strong>
        <span className={`badge badge-${r.verdict}`}>{r.verdict}</span>
        {r.findings && r.findings.length > 0 && (
          <span className="badge">Score: {r.findings.reduce((acc: number, f: any) => acc + (f.score || 0), 0).toFixed(2)}</span>
        )}
        <span className="muted">
          cat={r.category_name || (catChain.length ? catChain.join('/') : '—')} · np={r.np_name ?? r.np_id ?? '—'} · {r.latency_ms}ms
          {r.llm_used ? ` · LLM ₹${(r.llm_cost_paise / 100).toFixed(2)}` : ''}
        </span>
      </div>

      <div className="ad-text" style={{ marginBottom: 12 }}>
        {r.ad_text.slice(0, 800)}{r.ad_text.length > 800 ? '…' : ''}
      </div>

      <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>OUR FLAGS</div>
      {r.findings.length === 0 ? (
        <div className="muted">
          (none — no active rule caught this text under the chosen newspaper/category)
        </div>
      ) : (
        r.findings.map((f, i) => (
          <div key={i} style={{ marginBottom: 4 }}>
            <span className={`badge badge-${f.severity}`}>{f.severity}</span>{' '}
            <strong>{f.rule_name}</strong> <span className="muted">rule #{f.rule_id}</span>
            <span className="badge" style={{ marginLeft: 8 }}>Score: {f.score?.toFixed(2) ?? 'N/A'}</span>
            {f.confidence != null && <span className="badge" style={{ marginLeft: 4 }}>Conf: {(f.confidence * 100).toFixed(0)}%</span>}
            <div className="muted">{f.message}</div>
          </div>
        ))
      )}
    </div>
  );
}
