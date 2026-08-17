'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { runBatchBacktest, type ProcessedAdSummary } from '../actions';

export function BatchBacktestPanel() {
  const router = useRouter();
  const [limitStr, setLimitStr] = useState('50');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; processed: number; processedAds?: ProcessedAdSummary[]; error?: string } | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const limit = Number(limitStr.trim());
    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      setResult({ ok: false, processed: 0, error: 'Enter a valid batch size between 1 and 500' });
      return;
    }
    setResult(null);
    startTransition(async () => {
      try {
        let totalProcessed = 0;
        let allAds: ProcessedAdSummary[] = [];
        let done = false;

        while (totalProcessed < limit && !done) {
          const chunk = Math.min(5, limit - totalProcessed);
          const r = await runBatchBacktest(chunk, true);
          if (!r.ok) {
            setResult({ ok: false, processed: totalProcessed, error: r.error });
            return;
          }
          if (r.processed === 0) {
            done = true;
          } else {
            totalProcessed += r.processed;
            if (r.processedAds) {
              allAds = [...allAds, ...r.processedAds];
            }
          }
        }

        setResult({ ok: true, processed: totalProcessed, processedAds: allAds });
        if (totalProcessed > 0) {
          router.push('/review?mode=backtest');
          router.refresh();
        }
      } catch (err: any) {
        setResult({ ok: false, processed: 0, error: err.message || 'Network error or timeout' });
      }
    });
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Batch Backtest</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Run the AI against a fresh batch of ads reported by the RO team.
        It strictly excludes ads that have already been evaluated in backtest mode.
      </p>
      <form onSubmit={submit} className="flex" style={{ gap: 8 }}>
        <input
          type="number"
          min="10"
          max="500"
          placeholder="Batch size (e.g., 50)"
          value={limitStr}
          onChange={(e) => setLimitStr(e.target.value)}
          disabled={pending}
          style={{ padding: '6px 10px', minWidth: 160 }}
        />
        <button type="submit" className="btn" disabled={pending || !limitStr.trim()}>
          {pending ? 'Processing…' : 'Run Batch'}
        </button>
      </form>

      {result && !result.ok && (
        <div style={{ marginTop: 12, color: 'var(--danger)' }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}

      {result && result.ok && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: 'var(--primary)', marginBottom: 8 }}>
            <strong>Success:</strong> Processed {result.processed} new ads.
            {result.processed === 0 && ' (No new ads available)'}
          </div>

          {result.processedAds && result.processedAds.length > 0 && (
            <div style={{ fontSize: 13 }}>
              <strong className="muted">RECENTLY PROCESSED:</strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: 8 }}>
                {result.processedAds.map((ad, i) => (
                  <details key={i} style={{ padding: '8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--hard-bg)' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>#{ad.adId}</span>
                      <span className={`badge badge-${ad.verdict}`}>{ad.verdict}</span>
                      {ad.findings && ad.findings.length > 0 && (
                        <span className="badge">Score: {ad.findings.reduce((acc: number, f: any) => acc + (f.score || 0), 0).toFixed(2)}</span>
                      )}
                      <span className="badge">{ad.outcome}</span>
                    </summary>
                    <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                      <div className="ad-text" style={{ padding: '8px 12px', background: 'var(--bg)', borderRadius: 4, marginBottom: 12, fontSize: 13, lineHeight: 1.5, maxHeight: 150, overflowY: 'auto' }}>
                        {ad.adText}
                      </div>

                      <div className="row" style={{ display: 'flex', gap: 16 }}>
                        <div className="col" style={{ flex: 1 }}>
                          <div className="muted" style={{ fontWeight: 600, marginBottom: 8, fontSize: 11, letterSpacing: '0.05em' }}>OUR FLAGS</div>
                          {ad.findings && ad.findings.length > 0 ? (
                            <div>
                              {ad.findings.map((f: any, idx: number) => (
                                <div key={idx} style={{ marginBottom: 12 }}>
                                  <div style={{ marginBottom: 4 }}>
                                    <span className={`badge badge-${f.severity}`}>{f.severity}</span>{' '}
                                    <strong>{f.rule_name}</strong>
                                    <span className="badge" style={{ marginLeft: 8 }}>Score: {f.score?.toFixed(2) ?? 'N/A'}</span>
                                    {f.confidence != null && <span className="badge" style={{ marginLeft: 4 }}>Conf: {(f.confidence * 100).toFixed(0)}%</span>}
                                  </div>
                                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{f.message}</div>
                                  {f.target_ro_reasons && f.target_ro_reasons.length > 0 && (
                                    <div style={{ fontSize: 11, color: 'var(--primary)' }}>
                                      <strong>Target RO Reasons:</strong>
                                      <ul style={{ margin: '2px 0 0 16px', padding: 0 }}>
                                        {f.target_ro_reasons.map((tr: string, trIdx: number) => (
                                          <li key={trIdx}>{tr}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="muted" style={{ fontSize: 12 }}>(none — we passed this ad)</div>
                          )}
                        </div>

                        <div className="col" style={{ flex: 1 }}>
                          <div className="muted" style={{ fontWeight: 600, marginBottom: 8, fontSize: 11, letterSpacing: '0.05em' }}>RO FLAGGED</div>
                          {ad.roFlags && ad.roFlags.length > 0 ? (
                            <div>
                              {ad.roFlags.map((flag: string, fIdx: number) => (
                                <div key={fIdx} style={{ marginBottom: 4, fontSize: 12 }}>
                                  <span className="badge" style={{ marginRight: 6 }}>RO</span> {flag}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="muted" style={{ fontSize: 12 }}>(none)</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
