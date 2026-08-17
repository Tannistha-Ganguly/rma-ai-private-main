import { queryRmaAi } from '@/lib/db/rmaAi';
import Link from 'next/link';
import CustomerCarePanel from './CustomerCarePanel';

interface ModeRow { run_mode: string; n: number }
interface OutcomeRow { outcome: string; verdict: 'pass' | 'warn' | 'block'; n: number }
interface CountRow { n: number }

const ALL_BUCKETS = [
  'FULL_MATCH',
  'PARTIAL_OVERLAP',
  'NO_OVERLAP_BOTH_FLAGGED',
  'WE_ONLY',
  'RO_ONLY',
  'BOTH_CLEAN',
  'PENDING_RO_REVIEW',
  'DATA_QUALITY',
  'NON_EDITORIAL_RO_FLAG',
] as const;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ mode?: string; range?: string }> }) {
  const sp = await searchParams;
  const mode = (sp.mode ?? 'backtest') as 'backtest' | 'shadow' | 'live' | 'customer_care';
  const range = sp.range ?? 'all';

  let dateFilter = '';
  if (range === '24h') dateFilter = `AND r.created_at >= NOW() - INTERVAL 1 DAY`;
  else if (range === '7d') dateFilter = `AND r.created_at >= NOW() - INTERVAL 7 DAY`;
  else if (range === '30d') dateFilter = `AND r.created_at >= NOW() - INTERVAL 30 DAY`;

  let modeBreakdown: ModeRow[] = [];
  let outcomeBreakdown: OutcomeRow[] = [];
  let pendingProposals = 0;
  let activeRules = 0;
  let dbError: string | null = null;

  try {
    modeBreakdown = await queryRmaAi<ModeRow>(
      `SELECT run_mode, COUNT(*) AS n FROM editorial_check_run r ${dateFilter ? 'WHERE ' + dateFilter.slice(4) : ''} GROUP BY run_mode ORDER BY n DESC`,
    );
    outcomeBreakdown = await queryRmaAi<OutcomeRow>(
      `SELECT a.outcome, r.verdict, COUNT(*) AS n
       FROM editorial_check_alignment a
       JOIN editorial_check_run r ON r.id = a.check_run_id
       WHERE r.run_mode = ? ${dateFilter}
       GROUP BY a.outcome, r.verdict`,
      [mode],
    );
    const pp = await queryRmaAi<CountRow>(`SELECT COUNT(*) AS n FROM editorial_rule_proposal WHERE status='pending'`);
    pendingProposals = pp[0]?.n ?? 0;
    const ar = await queryRmaAi<CountRow>(`SELECT COUNT(*) AS n FROM editorial_rule WHERE status='active'`);
    activeRules = ar[0]?.n ?? 0;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const byBucket: Record<string, { total: number; pass: number; warn: number; block: number }> = Object.fromEntries(
    ALL_BUCKETS.map((b) => [b, { total: 0, pass: 0, warn: 0, block: 0 }])
  );
  
  for (const r of outcomeBreakdown) {
    if (byBucket[r.outcome]) {
      byBucket[r.outcome].total += r.n;
      if (r.verdict === 'pass') byBucket[r.outcome].pass += r.n;
      else if (r.verdict === 'warn') byBucket[r.outcome].warn += r.n;
      else if (r.verdict === 'block') byBucket[r.outcome].block += r.n;
    }
  }

  const total = Object.values(byBucket).reduce((a, b) => a + b.total, 0);
  const matched = byBucket.FULL_MATCH.total + byBucket.BOTH_CLEAN.total;
  const eligible = total - byBucket.PENDING_RO_REVIEW.total - byBucket.DATA_QUALITY.total - byBucket.NON_EDITORIAL_RO_FLAG.total;
  const strict = eligible ? ((matched / eligible) * 100).toFixed(1) : '—';
  const partial = eligible ? (((matched + 0.5 * byBucket.PARTIAL_OVERLAP.total) / eligible) * 100).toFixed(1) : '—';
  const max = Math.max(1, ...Object.values(byBucket).map(b => b.total));

  return (
    <>
      <h1>Dashboard</h1>

      {dbError && (
        <div className="card" style={{ background: 'var(--hard-bg)', color: 'var(--danger)' }}>
          <strong>DB error:</strong> {dbError}
          <div className="muted" style={{ marginTop: 8, color: 'var(--danger)' }}>
            Make sure .env.local has RMA_AI_DB_HOST/USER/PASS/NAME set.
          </div>
        </div>
      )}

      <div className="flex" style={{ marginBottom: 16 }}>
        <div className="muted">Mode:</div>
        {(['backtest', 'shadow', 'live', 'customer_care'] as const).map((m) => (
          <Link
            key={m}
            href={`/dashboard?mode=${m}&range=${range}`}
            className="btn"
            style={mode === m ? { background: 'var(--primary)', color: 'white', borderColor: 'var(--primary)' } : {}}
          >
            {m === 'customer_care' ? 'customer care review' : m}
          </Link>
        ))}
        <div className="spacer" style={{ width: 16 }} />
        <div className="muted">Range:</div>
        {(['all', '24h', '7d', '30d'] as const).map((r) => (
          <Link
            key={r}
            href={`/dashboard?mode=${mode}&range=${r}`}
            className="btn"
            style={range === r ? { background: 'var(--primary)', color: 'white', borderColor: 'var(--primary)' } : {}}
          >
            {r}
          </Link>
        ))}
        {mode !== 'customer_care' && (
          <>
            <div className="spacer" />
            <div className="muted">{total} eligible runs</div>
          </>
        )}
      </div>

      {mode === 'customer_care' ? (
        <CustomerCarePanel />
      ) : (
        <>
          <div className="row" style={{ marginBottom: 16 }}>
            <div className="card col">
              <div className="kpi-label">Strict alignment</div>
              <div className="kpi">{strict}{strict !== '—' ? '%' : ''}</div>
              <div className="muted">target ≥ 85% sustained for 2 weeks</div>
            </div>
            <div className="card col">
              <div className="kpi-label">Partial-credit rate</div>
              <div className="kpi">{partial}{partial !== '—' ? '%' : ''}</div>
              <div className="muted">strict + 0.5 × partial overlap</div>
            </div>
            <div className="card col">
              <div className="kpi-label">Active rules</div>
              <div className="kpi">{activeRules}</div>
              <div className="muted"><Link href="/rules">Manage →</Link></div>
            </div>
            <div className="card col">
              <div className="kpi-label">Pending proposals</div>
              <div className="kpi">{pendingProposals}</div>
              <div className="muted"><Link href="/proposals">Review →</Link></div>
            </div>
          </div>

          <div className="card">
            <h2>Outcome breakdown — {mode}</h2>
            {total === 0 ? (
              <p className="muted">
                No {mode} runs yet. {mode === 'backtest' && 'Run: '}
                {mode === 'backtest' && <code>npm run backtest</code>}
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th style={{ width: '50%' }}>Distribution</th>
                    <th style={{ width: 80 }}>Count</th>
                    <th style={{ width: 80 }}>%</th>
                    <th style={{ width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {ALL_BUCKETS.map((b) => (
                    <tr key={b}>
                      <td><code style={{ fontSize: 11 }}>{b}</code></td>
                      <td>
                        <div className="bar" style={{ display: 'flex' }}>
                          {byBucket[b].pass > 0 && (
                            <div
                              className="bar-fill"
                              style={{ width: `${(byBucket[b].pass / max) * 100}%`, backgroundColor: 'var(--success)' }}
                              title={`Pass: ${byBucket[b].pass}`}
                            />
                          )}
                          {byBucket[b].warn > 0 && (
                            <div
                              className="bar-fill"
                              style={{ width: `${(byBucket[b].warn / max) * 100}%`, backgroundColor: 'var(--warn)' }}
                              title={`Warn: ${byBucket[b].warn}`}
                            />
                          )}
                          {byBucket[b].block > 0 && (
                            <div
                              className="bar-fill"
                              style={{ width: `${(byBucket[b].block / max) * 100}%`, backgroundColor: 'var(--danger)' }}
                              title={`Block: ${byBucket[b].block}`}
                            />
                          )}
                        </div>
                      </td>
                      <td>{byBucket[b].total}</td>
                      <td>{total ? ((byBucket[b].total / total) * 100).toFixed(1) : '0'}%</td>
                      <td>
                        {byBucket[b].total > 0 && (
                          <Link href={`/review?mode=${mode}&outcome=${b}&range=${range}`}>Review →</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h2>Runs by mode</h2>
            {modeBreakdown.length === 0 ? (
              <p className="muted">No runs in any mode yet.</p>
            ) : (
              <table>
                <thead><tr><th>Mode</th><th>Count</th></tr></thead>
                <tbody>
                  {modeBreakdown.map((r) => (
                    <tr key={r.run_mode}>
                      <td><code>{r.run_mode}</code></td>
                      <td>{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
