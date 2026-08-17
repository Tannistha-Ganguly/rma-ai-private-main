import Link from 'next/link';
import { notFound } from 'next/navigation';
import { queryRmaAi } from '@/lib/db/rmaAi';
import { queryRma } from '@/lib/db/rma';

interface RowJoined {
  alignment_id: number;
  ad_id: number;
  outcome: string;
  our_rule_ids: unknown;
  ro_reason_ids: unknown;
  flag_overlap: unknown;
  we_extra: unknown;
  ro_extra: unknown;
  reviewed_by: number | null;
  review_decision: string | null;
  reviewed_at: string | null;
  // run
  run_mode: string;
  ad_text_snapshot: string;
  ad_text_hash: string;
  category_chosen: unknown;
  np_id: number | null;
  language_detected: string | null;
  category_suggested: unknown;
  findings: unknown;
  verdict: string;
  llm_used: number;
  llm_cost_paise: number;
  latency_ms: number | null;
  engine_version: string;
  created_at: string;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}

export default async function AdDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const alignmentId = Number(id);
  if (!Number.isFinite(alignmentId)) notFound();

  const rows = await queryRmaAi<RowJoined>(
    `SELECT a.id AS alignment_id, a.ad_id, a.outcome, a.our_rule_ids, a.ro_reason_ids,
            a.flag_overlap, a.we_extra, a.ro_extra,
            a.reviewed_by, a.review_decision, a.reviewed_at,
            r.run_mode, r.ad_text_snapshot, r.ad_text_hash, r.category_chosen, r.np_id,
            r.language_detected, r.category_suggested, r.findings, r.verdict,
            r.llm_used, r.llm_cost_paise, r.latency_ms, r.engine_version, r.created_at
     FROM editorial_check_alignment a
     JOIN editorial_check_run r ON r.id = a.check_run_id
     WHERE a.id = ?`,
    [alignmentId],
  );
  if (rows.length === 0) notFound();
  const row = rows[0];

  const findings = parseJson<Array<{ rule_id: number; rule_name: string; severity: string; message: string }>>(row.findings, []);
  const roIds = parseJson<number[]>(row.ro_reason_ids, []);
  const category = parseJson<{ top?: number; sub?: number; sub_sub?: number; sub_sub_sub?: number }>(row.category_chosen, {});
  const categorySuggested = parseJson<{ top?: number } | null>(row.category_suggested, null);

  let reasonNames = new Map<number, string>();
  let npName: string | null = null;
  let catNames = new Map<number, string>();
  let opsNotes: Array<{ note: string; date: string }> = [];
  let currentText: string | null = null;
  let currentStatus: number | null = null;
  let earliestPub: string | null = null;
  try {
    if (roIds.length > 0) {
      const reasonRows = await queryRma<{ id: number; name: string }>(
        `SELECT id, name FROM ro_reason WHERE id IN (${roIds.join(',')})`,
      );
      for (const r of reasonRows) reasonNames.set(r.id, r.name);

      const noteRows = await queryRma<{ note: string; date: string }>(
        `SELECT fre.email AS note, fre.date AS date
         FROM forum_report_email_master frem
         JOIN forum_report_email fre ON fre.report_ro_id = frem.id
         WHERE frem.ad_id = ? AND fre.type='note' AND fre.email != ''
         ORDER BY fre.date ASC LIMIT 5`,
        [row.ad_id],
      );
      opsNotes = noteRows;
    }

    if (row.np_id != null) {
      const npRows = await queryRma<{ title: string }>(
        `SELECT title FROM newspaper_master WHERE np_id = ?`,
        [row.np_id]
      );
      if (npRows.length > 0) npName = npRows[0].title;
    }

    const allCats = new Set<number>();
    if (category.top) allCats.add(category.top);
    if (category.sub) allCats.add(category.sub);
    if (category.sub_sub) allCats.add(category.sub_sub);
    if (category.sub_sub_sub) allCats.add(category.sub_sub_sub);

    if (allCats.size > 0) {
      const catRows = await queryRma<{ category_id: number; category_name: string }>(
        `SELECT category_id, category_name FROM new_categories WHERE category_id IN (${[...allCats].join(',')})`
      );
      for (const r of catRows) catNames.set(r.category_id, r.category_name);
    }

    const adNow = await queryRma<{ ad_text: string; status: number | null; earliest_publish_date: string | null }>(
      `SELECT ad_text, status, earliest_publish_date FROM ad_master WHERE ad_id = ? LIMIT 1`,
      [row.ad_id],
    );
    if (adNow.length > 0) {
      currentText = adNow[0].ad_text;
      currentStatus = adNow[0].status;
      earliestPub = adNow[0].earliest_publish_date;
    }
  } catch {
    // non-fatal — RO context is supplementary
  }

  const catChain = [category.top, category.sub, category.sub_sub, category.sub_sub_sub]
    .filter(Boolean)
    .map(id => catNames.get(id!) ?? `#${id}`)
    .join('/');
  const catLabel = catChain || '—';

  return (
    <>
      <div className="flex" style={{ marginBottom: 8 }}>
        <Link href="/review">← Back to review</Link>
        <div className="spacer" />
        <span className={`badge badge-${row.verdict}`}>{row.verdict}</span>
        <span className="badge">{row.outcome}</span>
        <span className="badge">{row.run_mode}</span>
      </div>

      <h1>Ad #{row.ad_id}</h1>
      <p className="muted">
        Category: {catLabel} ·
        Newspaper: {npName ?? row.np_id ?? '—'} ·
        Detected language: {row.language_detected ?? '—'} ·
        Booked: {String(row.created_at)}
      </p>

      <div className="card">
        <h2>Ad text (snapshot at check time)</h2>
        <div className="ad-text" style={{ maxHeight: 'none' }}>{row.ad_text_snapshot}</div>
        {currentText && currentText !== row.ad_text_snapshot && (
          <>
            <h3 style={{ marginTop: 16 }}>Current ad_master text (after any RO edits)</h3>
            <div className="ad-text" style={{ maxHeight: 'none' }}>{currentText}</div>
          </>
        )}
      </div>

      <div className="row">
        <div className="card col">
          <h2>Our engine</h2>
          <p className="muted">
            Engine v{row.engine_version} · Verdict: <strong>{row.verdict}</strong> · Latency: {row.latency_ms ?? '—'}ms · LLM: {row.llm_used ? `yes (₹${(row.llm_cost_paise / 100).toFixed(2)})` : 'no'}
          </p>
          {findings.length === 0 ? (
            <div className="muted">(no findings — we passed this ad)</div>
          ) : (
            findings.map((f, i) => (
              <div key={i} className="card" style={{ marginBottom: 8, background: f.severity === 'hard' ? 'var(--hard-bg)' : 'var(--soft-bg)' }}>
                <div className="flex">
                  <span className={`badge badge-${f.severity}`}>{f.severity}</span>
                  <strong>{f.rule_name}</strong>
                  <span className="muted">rule #{f.rule_id}</span>
                </div>
                <div style={{ marginTop: 4 }}>{f.message}</div>
              </div>
            ))
          )}
          {categorySuggested && (
            <p className="muted" style={{ marginTop: 8 }}>
              Category suggested: <code>{JSON.stringify(categorySuggested)}</code>
            </p>
          )}
        </div>

        <div className="card col">
          <h2>RO team</h2>
          <p className="muted">
            ad_master.status: {currentStatus ?? '—'} · earliest_publish_date: {String(earliestPub ?? '—')}
          </p>
          {roIds.length === 0 ? (
            <div className="muted">(no editorial ticket on this ad)</div>
          ) : (
            <>
              <h3>Tickets ({roIds.length})</h3>
              {roIds.map((rid) => (
                <div key={rid} className="card" style={{ marginBottom: 8 }}>
                  <strong>#{rid}</strong> {reasonNames.get(rid) ?? `reason ${rid}`}
                </div>
              ))}
              {opsNotes.length > 0 && (
                <>
                  <h3>Internal ops notes</h3>
                  {opsNotes.map((n, i) => (
                    <div key={i} className="card" style={{ marginBottom: 6, fontFamily: 'monospace', fontSize: 12 }}>
                      <div className="muted">{String(n.date)}</div>
                      <div>{n.note}</div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Alignment outcome</h2>
        <p>
          <span className="badge">{row.outcome}</span>{' '}
          {row.review_decision ? (
            <span className="muted">
              · reviewed: <code>{row.review_decision}</code> at {String(row.reviewed_at)}
            </span>
          ) : (
            <span className="muted">· not yet reviewed</span>
          )}
        </p>
      </div>
    </>
  );
}
