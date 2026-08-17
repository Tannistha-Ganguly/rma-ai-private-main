'use client';

import React, { useEffect, useRef, useState, Fragment } from 'react';
import {
  startShadowBatch,
  cancelShadowBatch,
  getShadowBatchStatus,
  processShadowChunk,
  getRecentShadowRuns,
  runOnDemandCheck,
  runAndSaveShadowCheck,
  type OnDemandCheckResult,
  type OnDemandCheckError,
  type ShadowBatch,
  type ShadowBatchStatus,
  type ShadowBatchDirection,
  type RecentShadowRun,
} from '../actions';
import { BacktestResult } from './BacktestPanel';

const DEFAULT_BATCH_SIZE = 500;
const CHUNK_SIZE = 5; // ads per server-action call for backward batches
const RECENT_RUNS_TO_SHOW = 100;

function fmt(dt: string | Date | null): string {
  if (!dt) return '—';
  const s = dt instanceof Date ? dt.toISOString() : String(dt);
  return s.replace('T', ' ').replace(/\..*$/, '');
}

export function ShadowBatchPanel() {
  const [status, setStatus] = useState<ShadowBatchStatus | null>(null);
  const [recent, setRecent] = useState<RecentShadowRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [batchSize, setBatchSize] = useState<string>(String(DEFAULT_BATCH_SIZE));
  const [direction, setDirection] = useState<ShadowBatchDirection>('backward');
  const [running, setRunning] = useState(false);
  const [chunkMsg, setChunkMsg] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const stopRef = useRef(false);

  const [offset, _setOffset] = useState<number>(0);
  const offsetRef = useRef<number>(0);
  const setOffset = (newOffset: number) => {
    offsetRef.current = newOffset;
    _setOffset(newOffset);
    refresh();
  };

  const refresh = async () => {
    try {
      const [s, r] = await Promise.all([
        getShadowBatchStatus(),
        getRecentShadowRuns(RECENT_RUNS_TO_SHOW, offsetRef.current),
      ]);
      setStatus(s);
      setRecent(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
    // Light polling so forward-batch progress (advanced by cron) stays current.
    const t = setInterval(refresh, 30_000);
    return () => { stopRef.current = true; clearInterval(t); };
  }, []);

  const driveChunks = async (batchId: number) => {
    setRunning(true);
    stopRef.current = false;
    let totalEngineErrors = 0;
    try {
      while (!stopRef.current) {
        setChunkMsg('Processing chunk…');
        const r = await processShadowChunk(batchId, CHUNK_SIZE);
        if (!r.ok) { setError(r.error); break; }
        totalEngineErrors += r.engine_errors;
        await refresh();
        if (r.done) {
          if (r.no_more_ads) {
            setChunkMsg(`Stopped: no more unshadowed ads in ad_master. ${r.processed_total} / ${r.target} processed${totalEngineErrors > 0 ? ` · ${totalEngineErrors} engine errors` : ''}.`);
          } else {
            setChunkMsg(`Done. ${r.processed_total} / ${r.target} processed${totalEngineErrors > 0 ? ` · ${totalEngineErrors} engine errors` : ''}.`);
          }
          break;
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const onStart = async () => {
    const n = Number(batchSize);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Batch size must be a positive integer');
      return;
    }
    setError(null);
    setChunkMsg(null);

    const r = await startShadowBatch(n, direction);
    if (!r.ok) { setError(r.error); return; }
    await refresh();
    if (direction === 'backward') {
      void driveChunks(r.batchId);
    } else {
      setChunkMsg(`Forward batch #${r.batchId} created — the PM2 cron worker will process new ads every 5 minutes until ${n} are done.`);
    }
  };

  const onResume = async (batchId: number) => {
    setError(null);
    setChunkMsg(null);
    void driveChunks(batchId);
  };

  const onCancel = async (batchId: number) => {
    if (!confirm(`Cancel shadow batch #${batchId}?`)) return;
    stopRef.current = true;
    const r = await cancelShadowBatch(batchId);
    if (!r.ok && r.error) setError(r.error);
    setChunkMsg(null);
    await refresh();
  };

  const activeOfChosenDirection = direction === 'backward' ? status?.activeBackward : status?.activeForward;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>Shadow batches</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Run the engine on real ads in <code>ad_master</code> with{' '}
        <code>run_mode=&apos;shadow&apos;</code>. Each shadow run is immediately visible in the{' '}
        <code>shadow</code> mode below under the <em>Pending RO</em> bucket; after 48h the
        alignment outcome is recomputed against whatever RO ticketed in the meantime.
      </p>

      {error && (
        <div style={{ color: 'var(--danger)', marginBottom: 8 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {activeOfChosenDirection ? (
        <ActiveBatchView
          batch={activeOfChosenDirection}
          running={running}
          onCancel={onCancel}
          onResume={direction === 'backward' ? onResume : undefined}
        />
      ) : (
        <StartForm
          direction={direction}
          setDirection={setDirection}
          batchSize={batchSize}
          setBatchSize={setBatchSize}
          onStart={onStart}
          running={running}
        />
      )}

      {/* Show the OTHER direction's active batch as a smaller note so the team
          knows it's still running. */}
      {direction === 'backward' && status?.activeForward && (
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Also active: forward batch #{status.activeForward.id} — {status.activeForward.processed_count} / {status.activeForward.target_count} (cron-driven)
        </div>
      )}
      {direction === 'forward' && status?.activeBackward && (
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Also active: backward batch #{status.activeBackward.id} — {status.activeBackward.processed_count} / {status.activeBackward.target_count}
        </div>
      )}

      {chunkMsg && (
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>{chunkMsg}</div>
      )}

      {recent.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
            RECENT SHADOW RUNS (last {recent.length})
          </div>
          <div style={{ maxHeight: 350, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--background, #fff)', zIndex: 1 }}>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px' }}>run</th>
                  <th style={{ padding: '8px' }}>ad</th>
                  <th style={{ padding: '8px' }}>np</th>
                  <th style={{ padding: '8px' }}>cat</th>
                  <th style={{ padding: '8px' }}>verdict</th>
                  <th style={{ padding: '8px' }}>flags</th>
                  <th style={{ padding: '8px' }}>alignment</th>
                  <th style={{ padding: '8px' }}>when</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      style={{
                        borderBottom: '1px solid var(--border-light, #eee)',
                        cursor: 'pointer',
                        background: expandedRow === r.id ? 'var(--border-light, #f0f0f0)' : undefined
                      }}
                      onClick={() => setExpandedRow(expandedRow === r.id ? null : r.id)}
                    >
                      <td style={{ padding: '6px 8px' }}>#{r.id}</td>
                      <td style={{ padding: '6px 8px' }}>#{r.ad_id}</td>
                      <td style={{ padding: '6px 8px' }}>{r.np_name || <span className="muted">—</span>}</td>
                      <td style={{ padding: '6px 8px', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.category_name || ''}>
                        {r.category_name || <span className="muted">—</span>}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <span className={`badge badge-${r.verdict}`}>{r.verdict}</span>
                        {r.findings && r.findings.length > 0 && (
                          <span className="badge" style={{ marginLeft: 4 }}>
                            Score: {r.findings.reduce((acc: number, f: any) => acc + (f.score || 0), 0).toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{r.finding_count}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {r.alignment_outcome
                          ? <span className="badge">{r.alignment_outcome}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td style={{ padding: '6px 8px' }} className="muted">{fmt(r.created_at)}</td>
                    </tr>
                    {expandedRow === r.id && (
                      <tr style={{ borderBottom: '1px solid var(--border-light, #eee)', background: 'var(--border-light, #f8f8f8)' }}>
                        <td colSpan={8} style={{ padding: '16px' }}>
                          <div style={{ display: 'flex', gap: '24px', marginBottom: '24px' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Ad Matter</div>
                              <div style={{
                                fontSize: 13,
                                fontFamily: 'monospace',
                                background: 'var(--background, #fff)',
                                padding: '12px',
                                borderRadius: 6,
                                border: '1px solid var(--border)',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word'
                              }}>
                                {r.ad_text_snapshot || <span className="muted">No ad text available.</span>}
                              </div>
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>RO Flagged Reasons</div>
                              <div style={{
                                fontSize: 13,
                                background: 'var(--background, #fff)',
                                padding: '12px',
                                borderRadius: 6,
                                border: '1px solid var(--border)',
                              }}>
                                {r.ro_reasons && r.ro_reasons.length > 0 ? (
                                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                                    {r.ro_reasons.map((ro: any) => (
                                      <li key={ro.id}>{ro.name} (ID: {ro.id})</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <span className="muted">No RO reasons flagged.</span>
                                )}
                              </div>
                              <div style={{ marginTop: 12 }}>
                                <InlineEvaluateAd adId={r.ad_id} checkRunId={r.id} onSuccess={refresh} />
                                {(r.verdict === 'block' || r.ad_status === 5) && (
                                  <InlineRaiseTicket adId={r.ad_id} />
                                )}
                              </div>
                            </div>
                          </div>

                          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Blocking Rules / Findings</div>
                          {r.findings && r.findings.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {r.findings.map((f, idx) => (
                                <div key={idx} style={{ padding: 12, background: 'var(--background, #fff)', borderRadius: 6, border: '1px solid var(--border)' }}>
                                  <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>
                                    Rule #{f.rule_id}: {f.rule_name}
                                    <span className="badge" style={{ marginLeft: 8 }}>Score: {f.score?.toFixed(2) ?? 'N/A'}</span>
                                    {f.confidence != null && <span className="badge" style={{ marginLeft: 4 }}>Conf: {(f.confidence * 100).toFixed(0)}%</span>}
                                  </div>
                                  {f.rule_description && (
                                    <div style={{ fontSize: 13, marginBottom: 6, color: 'var(--muted)', fontStyle: 'italic' }}>
                                      {f.rule_description}
                                    </div>
                                  )}
                                  {f.message && (
                                    <div style={{ fontSize: 13, marginBottom: 6, lineHeight: 1.4 }}>
                                      <strong>Reasoning:</strong> {f.message}
                                    </div>
                                  )}
                                  {f.matched_text && (
                                    <div style={{
                                      fontSize: 12,
                                      fontFamily: 'monospace',
                                      background: 'var(--border-light, #f0f0f0)',
                                      padding: '6px 8px',
                                      borderRadius: 4,
                                      wordBreak: 'break-all'
                                    }}>
                                      {f.matched_text}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="muted">No blocking rules found for this run.</div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <button
              className="btn"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - RECENT_RUNS_TO_SHOW))}
            >
              &larr; Newer {RECENT_RUNS_TO_SHOW}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              Showing {offset + 1} - {offset + recent.length}
            </span>
            <button
              className="btn"
              disabled={recent.length < RECENT_RUNS_TO_SHOW}
              onClick={() => setOffset(offset + RECENT_RUNS_TO_SHOW)}
            >
              Older {RECENT_RUNS_TO_SHOW} &rarr;
            </button>
          </div>
        </div>
      )}

      {status?.recent && status.recent.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>RECENT BATCHES</div>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '4px 8px' }}>#</th>
                <th style={{ padding: '4px 8px' }}>dir</th>
                <th style={{ padding: '4px 8px' }}>status</th>
                <th style={{ padding: '4px 8px' }}>progress</th>
                <th style={{ padding: '4px 8px' }}>started</th>
                <th style={{ padding: '4px 8px' }}>ended</th>
              </tr>
            </thead>
            <tbody>
              {status.recent.map((b) => (
                <tr key={b.id} style={{ borderBottom: '1px solid var(--border-light, #eee)' }}>
                  <td style={{ padding: '4px 8px' }}>{b.id}</td>
                  <td style={{ padding: '4px 8px' }}>{b.direction}</td>
                  <td style={{ padding: '4px 8px' }}><span className="badge">{b.status}</span></td>
                  <td style={{ padding: '4px 8px' }}>{b.processed_count} / {b.target_count}</td>
                  <td style={{ padding: '4px 8px' }} className="muted">{fmt(b.started_at)}</td>
                  <td style={{ padding: '4px 8px' }} className="muted">{fmt(b.completed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StartForm({
  direction, setDirection, batchSize, setBatchSize, onStart, running,
}: {
  direction: ShadowBatchDirection;
  setDirection: (d: ShadowBatchDirection) => void;
  batchSize: string;
  setBatchSize: (v: string) => void;
  onStart: () => void;
  running: boolean;
}) {
  return (
    <div>
      <div className="flex" style={{ gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="shadow-direction"
            checked={direction === 'backward'}
            onChange={() => setDirection('backward')}
            disabled={running}
          />
          <span><strong>Backward</strong> — run on the N newest unshadowed ads NOW</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="shadow-direction"
            checked={direction === 'forward'}
            onChange={() => setDirection('forward')}
            disabled={running}
          />
          <span><strong>Forward</strong> — watch for the next N new ads as they arrive (cron every 5 min)</span>
        </label>
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {direction === 'backward'
          ? 'Synchronous, chunked client loop. Ads may already be ops-edited.'
          : 'Asynchronous, runs on the EC2 PM2 cron. Catches each ad before ops touches it. Batch sits until 500 new ads have been submitted.'}
      </div>

      <div className="flex" style={{ gap: 8 }}>
        <input
          type="number"
          min={1}
          max={500}
          step={1}
          value={batchSize}
          onChange={(e) => setBatchSize(e.target.value)}
          disabled={running}
          style={{ padding: '6px 10px', width: 120 }}
          aria-label="Batch size"
        />
        <button onClick={onStart} className="btn" disabled={running || !batchSize}>
          {running
            ? 'Running…'
            : direction === 'backward'
              ? `Run next ${batchSize || '?'}`
              : `Watch next ${batchSize || '?'}`}
        </button>
      </div>
    </div>
  );
}

function ActiveBatchView({
  batch, running, onCancel, onResume,
}: {
  batch: ShadowBatch;
  running: boolean;
  onCancel: (id: number) => void;
  onResume?: (id: number) => void;
}) {
  const pct = batch.target_count > 0
    ? Math.min(100, Math.round((batch.processed_count / batch.target_count) * 100))
    : 0;
  const isForward = batch.direction === 'forward';

  return (
    <div>
      <div className="flex" style={{ marginBottom: 8 }}>
        <strong>Batch #{batch.id} active ({batch.direction})</strong>
        <span className="muted">
          {batch.processed_count} / {batch.target_count} processed
          {' '}· started {fmt(batch.started_at)}
          {isForward && (
            <> · anchor ad_id &gt; {batch.start_ad_id.toLocaleString()}</>
          )}
          {batch.last_processed_ad_id != null && (
            <> · last processed #{batch.last_processed_ad_id.toLocaleString()}</>
          )}
        </span>
        <div className="spacer" />
        {!running && onResume && (
          <button onClick={() => onResume(batch.id)} className="btn">Resume</button>
        )}
        <button
          onClick={() => onCancel(batch.id)}
          className="btn"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          Cancel
        </button>
      </div>

      <div style={{ height: 8, background: 'var(--border-light, #eee)', borderRadius: 4, overflow: 'hidden' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'var(--primary)',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {pct}% complete · {isForward
          ? 'cron advances every 5 min as new ads arrive in ad_master'
          : (running ? 'running…' : 'paused (refresh-safe — click Resume)')}
      </div>
    </div>
  );
}

function InlineEvaluateAd({ adId, checkRunId, onSuccess }: { adId: number, checkRunId: number, onSuccess?: () => void }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<OnDemandCheckResult | OnDemandCheckError | null>(null);

  const handleRun = async () => {
    setPending(true);
    setResult(null);
    try {
      const res = await runAndSaveShadowCheck(checkRunId, adId);
      setResult(res);
      if (res.ok && onSuccess) {
        onSuccess();
      }
    } catch (e: any) {
      setResult({ ok: false, error: e.message || String(e) });
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <button
        className="btn"
        onClick={handleRun}
        disabled={pending}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span>{pending ? 'Evaluating...' : 'Evaluate Individually'}</span>
        {!pending && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        )}
      </button>

      {result && !result.ok && (
        <div style={{ marginTop: 12, color: 'var(--danger)' }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}

      {result && result.ok && (
        <div style={{
          marginTop: 16,
          padding: 16,
          background: 'var(--background, #fff)',
          border: '1px solid var(--border)',
          borderRadius: 6
        }}>
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 14 }}>Individual Evaluation Result</h3>
          <BacktestResult r={result} />
        </div>
      )}
    </div>
  );
}

export function InlineRaiseTicket({ adId }: { adId: number }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean, error?: string, reportRoId?: number } | null>(null);

  const handleRaise = async () => {
    if (!confirm('Raise a Customer Care Ticket for this blocked ad?')) return;
    setPending(true);
    setResult(null);
    try {
      const { raiseCustomerCareTicket } = await import('../actions');
      const res = await raiseCustomerCareTicket(adId);
      setResult(res);
    } catch (e: any) {
      setResult({ ok: false, error: e.message || String(e) });
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <button
        className="btn"
        onClick={handleRaise}
        disabled={pending}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderColor: 'var(--danger)', color: 'var(--danger)' }}
      >
        <span>{pending ? 'Raising Ticket...' : 'Raise Ticket (Customer Care)'}</span>
      </button>

      {result && !result.ok && (
        <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 13 }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}

      {result && result.ok && (
        <div style={{ marginTop: 8, color: 'var(--success)', fontSize: 13 }}>
          <strong>Success!</strong> Raised ticket #{result.reportRoId} in CRM.
        </div>
      )}
    </div>
  );
}
