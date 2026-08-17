import Link from 'next/link';
import { queryRmaAi } from '@/lib/db/rmaAi';
import { queryRma } from '@/lib/db/rma';
import { ReviewRowActions } from './ReviewRowActions';
import { BacktestPanel } from './BacktestPanel';
import { BatchBacktestPanel } from './BatchBacktestPanel';
import { AdTextBacktestPanel } from './AdTextBacktestPanel';
import { ShadowBatchPanel } from './ShadowBatchPanel';
import { runShadowAlignmentPass } from '../actions';

interface AlignmentRow {
  id: number;
  check_run_id: number;
  ad_id: number;
  our_rule_ids: string | unknown;
  ro_reason_ids: string | unknown;
  flag_overlap: string | unknown;
  we_extra: string | unknown;
  ro_extra: string | unknown;
  outcome: string;
  ad_text_snapshot: string;
  category_chosen: string | unknown;
  np_id: number | null;
  findings: string | unknown;
  verdict: string;
  reviewed_by: number | null;
  review_decision: string | null;
}

interface BucketCount { outcome: string; n: number }

const TABS = [
  { key: 'FULL_MATCH', label: 'Confirms' },
  { key: 'WE_ONLY', label: 'False positives?' },
  { key: 'RO_ONLY', label: 'Missed' },
  { key: 'PARTIAL_OVERLAP', label: 'Partial overlap' },
  { key: 'NO_OVERLAP_BOTH_FLAGGED', label: 'Different things flagged' },
  { key: 'BOTH_CLEAN', label: 'Clean' },
  { key: 'PENDING_RO_REVIEW', label: 'Pending RO' },
  { key: 'DATA_QUALITY', label: 'Data quality' },
  { key: 'NON_EDITORIAL_RO_FLAG', label: 'Non-Editorial RO Flag' },
] as const;

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ mode?: string; outcome?: string; page?: string; range?: string }> }) {
  const sp = await searchParams;
  const mode = (sp.mode ?? 'backtest') as 'backtest' | 'shadow' | 'live';
  const range = sp.range ?? 'all';
  const outcome = sp.outcome ?? 'RO_ONLY';
  const page = Math.max(1, Number(sp.page ?? '1'));
  const pageSize = 20;

  // Tab counts
  let bucketCounts: BucketCount[] = [];
  let rows: AlignmentRow[] = [];
  let reasonNames = new Map<number, string>();
  let npNames = new Map<number, string>();
  let catNames = new Map<number, string>();
  let dbError: string | null = null;

  // Replaces the cron-based alignment worker on the Render free plan:
  // each /review request brings shadow-mode alignment up to date for any
  // runs that have crossed the 48h wait. Self-throttling (cap of 50/call)
  // and DB-only (no LLM) so it adds <1s to page load.
  if (mode === 'shadow') {
    try { await runShadowAlignmentPass(); } catch { /* never block the page on this */ }
  }

  let dateFilter = '';
  if (range === '24h') dateFilter = `AND r.created_at >= NOW() - INTERVAL 1 DAY`;
  else if (range === '7d') dateFilter = `AND r.created_at >= NOW() - INTERVAL 7 DAY`;
  else if (range === '30d') dateFilter = `AND r.created_at >= NOW() - INTERVAL 30 DAY`;

  try {
    bucketCounts = await queryRmaAi<BucketCount>(
      `SELECT a.outcome, COUNT(*) AS n
       FROM editorial_check_alignment a
       JOIN editorial_check_run r ON r.id = a.check_run_id
       WHERE r.run_mode = ? ${dateFilter}
       GROUP BY a.outcome`,
      [mode],
    );

    rows = await queryRmaAi<AlignmentRow>(
      `SELECT a.id, a.check_run_id, a.ad_id, a.our_rule_ids, a.ro_reason_ids,
              a.flag_overlap, a.we_extra, a.ro_extra, a.outcome,
              r.ad_text_snapshot, r.category_chosen, r.np_id, r.findings, r.verdict,
              a.reviewed_by, a.review_decision
       FROM editorial_check_alignment a
       JOIN editorial_check_run r ON r.id = a.check_run_id
       WHERE r.run_mode = ? AND a.outcome = ? ${dateFilter}
       ORDER BY a.computed_at DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      [mode, outcome],
    );

    if (rows.length > 0) {
      const allReasons = new Set<number>();
      const allNps = new Set<number>();
      const allCats = new Set<number>();

      for (const r of rows) {
        for (const id of parseJson<number[]>(r.ro_reason_ids, [])) allReasons.add(id);
        if (r.np_id != null) allNps.add(r.np_id);
        const cat = parseJson<{ top?: number; sub?: number; sub_sub?: number }>(r.category_chosen, {});
        if (cat.top) allCats.add(cat.top);
        if (cat.sub) allCats.add(cat.sub);
        if (cat.sub_sub) allCats.add(cat.sub_sub);
      }

      if (allReasons.size > 0) {
        const reasonRows = await queryRma<{ id: number; name: string }>(
          `SELECT id, name FROM ro_reason WHERE id IN (${[...allReasons].join(',')})`,
        );
        for (const r of reasonRows) reasonNames.set(r.id, r.name);
      }

      if (allNps.size > 0) {
        const npRows = await queryRma<{ np_id: number; title: string }>(
          `SELECT np_id, title FROM newspaper_master WHERE np_id IN (${[...allNps].join(',')})`
        );
        for (const r of npRows) npNames.set(r.np_id, r.title);
      }

      if (allCats.size > 0) {
        const catRows = await queryRma<{ category_id: number; category_name: string }>(
          `SELECT category_id, category_name FROM new_categories WHERE category_id IN (${[...allCats].join(',')})`
        );
        for (const r of catRows) catNames.set(r.category_id, r.category_name);
      }
    }
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const countByBucket: Record<string, number> = {};
  for (const b of bucketCounts) countByBucket[b.outcome] = b.n;
  const currentCount = countByBucket[outcome] ?? 0;
  const totalPages = Math.max(1, Math.ceil(currentCount / pageSize));

  return (
    <>
      <h1>Alignment Review</h1>

      <BacktestPanel />
      <BatchBacktestPanel />
      <AdTextBacktestPanel />

      <ShadowBatchPanel />

      {dbError && (
        <div className="card" style={{ background: 'var(--hard-bg)', color: 'var(--danger)' }}>
          <strong>DB error:</strong> {dbError}
        </div>
      )}

      <div className="flex" style={{ marginBottom: 12 }}>
        <span className="muted">Mode:</span>
        {(['backtest', 'shadow', 'live'] as const).map((m) => (
          <Link
            key={m}
            href={`/review?mode=${m}&outcome=${outcome}&range=${range}`}
            className="btn"
            style={mode === m ? { background: 'var(--primary)', color: 'white', borderColor: 'var(--primary)' } : {}}
          >
            {m}
          </Link>
        ))}
        <div className="spacer" style={{ width: 16 }} />
        <span className="muted">Range:</span>
        {(['all', '24h', '7d', '30d'] as const).map((r) => (
          <Link
            key={r}
            href={`/review?mode=${mode}&outcome=${outcome}&range=${r}`}
            className="btn"
            style={range === r ? { background: 'var(--primary)', color: 'white', borderColor: 'var(--primary)' } : {}}
          >
            {r}
          </Link>
        ))}
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/review?mode=${mode}&outcome=${t.key}&range=${range}`}
            className={`tab ${outcome === t.key ? 'active' : ''}`}
          >
            {t.label}
            <span className="tab-count">{countByBucket[t.key] ?? 0}</span>
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <p className="muted">
            No rows in this bucket for mode <code>{mode}</code>.
            {' '}
            {mode === 'backtest' && currentCount === 0 && (
              <>Run <code>npm run backtest</code> to populate.</>
            )}
          </p>
        </div>
      ) : (
        rows.map((row) => {
          const findings = parseJson<Array<{ rule_id: number; rule_name: string; severity: string; message: string; score?: number; confidence?: number; }>>(row.findings, []);
          const roIds = parseJson<number[]>(row.ro_reason_ids, []);
          const overlap = parseJson<number[]>(row.flag_overlap, []);
          const weExtra = parseJson<number[]>(row.we_extra, []);
          const roExtra = parseJson<number[]>(row.ro_extra, []);
          const category = parseJson<{ top?: number; sub?: number; sub_sub?: number; sub_sub_sub?: number }>(row.category_chosen, {});
          const npName = row.np_id ? npNames.get(row.np_id) ?? `#${row.np_id}` : '—';
          const catChain = [category.top, category.sub, category.sub_sub]
            .filter(Boolean)
            .map(id => catNames.get(id!) ?? `#${id}`)
            .join('/');
          const catLabel = catChain || '—';

          return (
            <div className="card" key={row.id}>
              <div className="flex" style={{ marginBottom: 8 }}>
                <strong>ad #{row.ad_id}</strong>
                <span className={`badge badge-${row.verdict}`}>{row.verdict}</span>
                <span className="muted">
                  cat={catLabel} · np={npName}
                </span>
                <div className="spacer" />
                <Link href={`/review/${row.id}`} className="btn">Open detail →</Link>
              </div>

              <div className="ad-text">{row.ad_text_snapshot.slice(0, 800)}{row.ad_text_snapshot.length > 800 ? '…' : ''}</div>

              <div className="row" style={{ marginTop: 12 }}>
                <div className="col">
                  <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>OUR FLAGS</div>
                  {findings.length === 0 ? (
                    <div className="muted">(none — we passed this ad)</div>
                  ) : (
                    findings.map((f, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>
                        <span className={`badge badge-${f.severity}`}>{f.severity}</span>{' '}
                        <strong>{f.rule_name}</strong>
                        <div className="muted">{f.message}</div>
                      </div>
                    ))
                  )}
                </div>

                <div className="col">
                  <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>RO FLAGGED</div>
                  {roIds.length === 0 ? (
                    <div className="muted">(none)</div>
                  ) : (
                    roIds.map((rid) => (
                      <div key={rid} style={{ marginBottom: 4 }}>
                        <span className="badge">#{rid}</span> {reasonNames.get(rid) ?? `reason ${rid}`}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {(overlap.length > 0 || weExtra.length > 0 || roExtra.length > 0) && (
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  overlap=[{overlap.join(',')}] · we_extra=[{weExtra.join(',')}] · ro_extra=[{roExtra.join(',')}]
                </div>
              )}

              <ReviewRowActions
                alignmentId={row.id}
                outcome={row.outcome}
                reviewDecision={row.review_decision}
              />
            </div>
          );
        })
      )}

      {totalPages > 1 && (
        <div className="flex" style={{ justifyContent: 'center', margin: '24px 0' }}>
          {page > 1 && (
            <Link className="btn" href={`/review?mode=${mode}&outcome=${outcome}&range=${range}&page=${page - 1}`}>← Prev</Link>
          )}
          <span className="muted">Page {page} / {totalPages}</span>
          {page < totalPages && (
            <Link className="btn" href={`/review?mode=${mode}&outcome=${outcome}&range=${range}&page=${page + 1}`}>Next →</Link>
          )}
        </div>
      )}
    </>
  );
}
