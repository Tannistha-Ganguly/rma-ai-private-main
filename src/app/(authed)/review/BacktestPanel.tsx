'use client';

import { useState, useTransition } from 'react';
import { runOnDemandCheck, type OnDemandCheckResult, type OnDemandCheckError } from '../actions';

type Result = OnDemandCheckResult | OnDemandCheckError;

export function BacktestPanel() {
  const [adId, setAdId] = useState('');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(adId.trim());
    if (!Number.isFinite(n) || n <= 0) {
      setResult({ ok: false, error: 'Enter a positive ad ID' });
      return;
    }
    setResult(null);
    startTransition(async () => {
      const r = await runOnDemandCheck(n);
      setResult(r);
    });
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Backtest on demand</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Enter an ad ID to run all active rules against it and see what we flag vs. what RO flagged.
        Uses pre-edit text from <code>ad_master_update</code> if available, else current <code>ad_master.ad_text</code>.
        Result is not saved.
      </p>
      <form onSubmit={submit} className="flex" style={{ gap: 8 }}>
        <input
          type="text"
          inputMode="numeric"
          placeholder="ad_id"
          value={adId}
          onChange={(e) => setAdId(e.target.value)}
          disabled={pending}
          style={{ padding: '6px 10px', minWidth: 160 }}
        />
        <button type="submit" className="btn" disabled={pending || !adId.trim()}>
          {pending ? 'Running…' : 'Run'}
        </button>
      </form>

      {result && !result.ok && (
        <div style={{ marginTop: 12, color: 'var(--danger)' }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}

      {result && result.ok && <BacktestResult r={result} />}
    </div>
  );
}

export function BacktestResult({ r }: { r: OnDemandCheckResult }) {
  const { alignment } = r;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex" style={{ marginBottom: 8 }}>
        <strong>ad #{r.ad_id}</strong>
        <span className={`badge badge-${r.verdict}`}>{r.verdict}</span>
        <span className="badge">{alignment.outcome}</span>
        <span className="muted">
          source={r.source} · cat={r.category_name || r.category_csv || '—'} · np={r.np_name ?? r.np_id ?? '—'} · {r.latency_ms}ms
          {r.llm_used ? ` · LLM ₹${(r.llm_cost_paise / 100).toFixed(2)}` : ''}
        </span>
      </div>

      <div className="ad-text" style={{ marginBottom: 12 }}>
        {r.ad_text.slice(0, 800)}{r.ad_text.length > 800 ? '…' : ''}
      </div>

      <div className="row">
        <div className="col">
          <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>OUR FLAGS</div>
          {r.findings.length === 0 ? (
            <div className="muted">(none — we passed this ad)</div>
          ) : (
            r.findings.map((f, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <span className={`badge badge-${f.severity}`}>{f.severity}</span>{' '}
                <strong>{f.rule_name}</strong> <span className="muted">rule #{f.rule_id}</span>
                <div className="muted">{f.message}</div>
              </div>
            ))
          )}
        </div>

        <div className="col">
          <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>RO FLAGGED</div>
          {r.ro_reasons.length === 0 ? (
            <div className="muted">(no editorial ticket on this ad)</div>
          ) : (
            r.ro_reasons.map((rr) => (
              <div key={rr.id} style={{ marginBottom: 4 }}>
                <span className="badge">#{rr.id}</span> {rr.name}
              </div>
            ))
          )}
        </div>
      </div>

      {(alignment.flag_overlap.length > 0 || alignment.we_extra.length > 0 || alignment.ro_extra.length > 0) && (
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          overlap=[{alignment.flag_overlap.join(',')}] · we_extra=[{alignment.we_extra.join(',')}] · ro_extra=[{alignment.ro_extra.join(',')}]
        </div>
      )}
    </div>
  );
}
