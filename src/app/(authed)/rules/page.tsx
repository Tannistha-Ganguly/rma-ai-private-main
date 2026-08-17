import Link from 'next/link';
import { queryRmaAi } from '@/lib/db/rmaAi';
import { queryRma } from '@/lib/db/rma';
import { RuleStatusToggle } from './RuleStatusToggle';
import { RuleFilters } from './RuleFilters';
import { RuleRoReasonSelect } from './RuleRoReasonSelect';
import { fetchRoReasons, fetchTopLevelCategories, fetchCategoryDescendants } from '../actions';

interface RuleRow {
  id: number;
  name: string;
  rule_type: string;
  hard_category_scope: unknown;
  hard_np_scope: unknown;
  soft_category_scope: unknown;
  soft_np_scope: unknown;
  status: string;
  target_ro_reason: unknown;
  source: string;
  customer_message: string;
}

interface CountRow { fired_count: number; rule_id: number }

function parseScope(v: unknown): number[] | null {
  if (v == null) return null;
  const arr = typeof v === 'string' ? JSON.parse(v) : v;
  if (!Array.isArray(arr)) return null;
  return arr as number[];
}

function formatScope(
  ids: number[] | null,
  prefix: 'cat' | 'np',
  allLabel: string,
): { text: string; tooltip: string | null } {
  if (ids === null) return { text: allLabel, tooltip: null };
  if (ids.length === 0) return { text: `0 ${prefix === 'cat' ? 'categories' : 'nps'}`, tooltip: null };
  if (ids.length <= 4) return { text: `${prefix}:${ids.join(',')}`, tooltip: null };
  return {
    text: `${prefix}: ${ids.length} ${prefix === 'cat' ? 'categories' : 'newspapers'}`,
    tooltip: `${prefix}:${ids.join(',')}`,
  };
}

export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cat?: string; np?: string }>;
}) {
  const sp = await searchParams;
  const status = sp.status ?? 'active';
  const catId = sp.cat ? Number(sp.cat) : undefined;
  const npId = sp.np ? Number(sp.np) : undefined;

  let rules: RuleRow[] = [];
  let firedCounts = new Map<number, number>();
  let categoryOptions: { id: number; name: string }[] = [];
  let newspaperOptions: { id: number; title: string }[] = [];
  let allReasons: { id: number; name: string }[] = [];
  let allNewspapers: { np_id: number; title: string }[] = [];
  let dbError: string | null = null;

  try {
    const [fetchedRules, fetchedReasons, fetchedAllNewspapers] = await Promise.all([
      queryRmaAi<RuleRow>(
        `SELECT id, name, rule_type, status, target_ro_reason, hard_category_scope, hard_np_scope, soft_category_scope, soft_np_scope, source, customer_message
         FROM editorial_rule
         WHERE status = ?
         ORDER BY id DESC`,
        [status],
      ),
      fetchRoReasons(),
      queryRma<{ np_id: number; title: string }>(
        `SELECT np_id, title FROM newspaper_master WHERE act = '1' ORDER BY title`
      )
    ]);
    rules = fetchedRules;
    allReasons = fetchedReasons;
    allNewspapers = fetchedAllNewspapers;

    // Collect every category id and np id referenced in any rule's scope.
    const allCatIds = new Set<number>();
    const allNpIds = new Set<number>();
    for (const r of rules) {
      parseScope(r.hard_category_scope)?.forEach((id) => allCatIds.add(id));
      parseScope(r.soft_category_scope)?.forEach((id) => allCatIds.add(id));
      parseScope(r.hard_np_scope)?.forEach((id) => allNpIds.add(id));
      parseScope(r.soft_np_scope)?.forEach((id) => allNpIds.add(id));
    }

    categoryOptions = await fetchTopLevelCategories();

    if (allNpIds.size > 0) {
      const ids = Array.from(allNpIds);
      const rows = await queryRma<{ np_id: number; title: string }>(
        `SELECT np_id, title FROM newspaper_master WHERE np_id IN (${ids.join(',')})`,
      );
      newspaperOptions = rows
        .map((r) => ({ id: r.np_id, title: r.title }))
        .sort((a, b) => a.title.localeCompare(b.title));
    }

    if (rules.length > 0) {
      const ids = rules.map((r) => r.id);
      const counts = await queryRmaAi<CountRow>(
        `SELECT JSON_EXTRACT(JSON_EXTRACT(f.value, '$.rule_id'), '$') AS rule_id, COUNT(*) AS fired_count
         FROM editorial_check_run r,
              JSON_TABLE(r.findings, '$[*]' COLUMNS (value JSON PATH '$')) f
         WHERE JSON_EXTRACT(f.value, '$.rule_id') IN (${ids.join(',')})
         GROUP BY rule_id`,
      ).catch(() => [] as CountRow[]);
      for (const c of counts) firedCounts.set(Number(c.rule_id), c.fired_count);
    }
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  let catDescendants: number[] = [];
  if (catId != null) {
    catDescendants = await fetchCategoryDescendants(catId);
  }

  // Apply category and newspaper filters in memory.
  // null scope = applies to all → always passes the filter.
  // empty scope ([]) = applies to none → always fails the filter.
  const filteredRules = rules.filter((r) => {
    if (catId != null) {
      const hScope = parseScope(r.hard_category_scope);
      const sScope = parseScope(r.soft_category_scope);
      
      const inHard = hScope !== null && !hScope.some(id => catDescendants.includes(id));
      const inSoft = sScope !== null && !sScope.some(id => catDescendants.includes(id));
      
      if (inHard && inSoft) return false;
    }
    if (npId != null) {
      const hScope = parseScope(r.hard_np_scope);
      const sScope = parseScope(r.soft_np_scope);
      const inHard = hScope !== null && !hScope.includes(npId);
      const inSoft = sScope !== null && !sScope.includes(npId);
      if (inHard && inSoft) return false;
    }
    return true;
  });

  return (
    <>
      <h1>Rules</h1>

      {dbError && (
        <div className="card" style={{ background: 'var(--hard-bg)', color: 'var(--danger)' }}>
          <strong>DB error:</strong> {dbError}
        </div>
      )}

      <div className="flex" style={{ marginBottom: 12 }}>
        {(['active', 'proposed', 'disabled'] as const).map((s) => (
          <Link
            key={s}
            href={`/rules?status=${s}`}
            className="btn"
            style={status === s ? { background: 'var(--primary)', color: 'white', borderColor: 'var(--primary)' } : {}}
          >
            {s}
          </Link>
        ))}
      </div>

      <RuleFilters
        categories={categoryOptions}
        newspapers={newspaperOptions}
        total={filteredRules.length}
        unfilteredTotal={rules.length}
        status={status}
      />

      {filteredRules.length === 0 ? (
        <div className="card">
          <p className="muted">
            No <code>{status}</code> rules match the current filters.{' '}
            {status === 'active' && rules.length === 0 && (
              <Link href="/proposals">Approve some from the proposals queue →</Link>
            )}
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th></th>
              <th>ID</th>
              <th>Name</th>
              <th>Type</th>
              <th>RO reason</th>
              <th>Source</th>
              <th>Scope</th>
              <th>Fired</th>
            </tr>
          </thead>
          <tbody>
            {filteredRules.map((r) => {
              const hCatScope = parseScope(r.hard_category_scope);
              const sCatScope = parseScope(r.soft_category_scope);
              const hNpScope = parseScope(r.hard_np_scope);
              const sNpScope = parseScope(r.soft_np_scope);
              
              const hCatLabel = formatScope(hCatScope, 'cat', 'all cats');
              const sCatLabel = formatScope(sCatScope, 'cat', 'all cats');
              const hNpLabel = formatScope(hNpScope, 'np', 'all nps');
              const sNpLabel = formatScope(sNpScope, 'np', 'all nps');

              return (
                <tr key={r.id}>
                  <td>
                    <RuleStatusToggle ruleId={r.id} currentStatus={r.status as 'active' | 'disabled' | 'proposed'} />
                  </td>
                  <td>{r.id}</td>
                  <td>
                    <Link href={`/rules/${r.id}`}>{r.name}</Link>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {r.customer_message.slice(0, 80)}{r.customer_message.length > 80 ? '…' : ''}
                    </div>
                  </td>
                  <td><code style={{ fontSize: 11 }}>{r.rule_type}</code></td>
                  <td>
                    <RuleRoReasonSelect
                      ruleId={r.id}
                      currentReasons={parseScope(r.target_ro_reason) ?? []}
                      allReasons={allReasons}
                    />
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>{r.source}</td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ color: 'var(--danger)' }}>Hard: {hCatLabel.text} / {hNpLabel.text}</div>
                      <div style={{ color: 'var(--warning)' }}>Soft: {sCatLabel.text} / {sNpLabel.text}</div>
                    </div>
                  </td>
                  <td>{firedCounts.get(r.id) ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
