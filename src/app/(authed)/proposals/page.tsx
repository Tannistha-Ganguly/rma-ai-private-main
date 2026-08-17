import Link from 'next/link';
import {
  fetchAllNewspapers,
  fetchEnrichedProposals,
  type NewspaperOption,
  type ProposalFilters as Filters,
} from './data';
import { ProposalFilters } from './ProposalFilters';
import { ProposalRow } from './ProposalRow';
import { fetchRoReasons } from '../actions';

function parseIntParam(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const get = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const filters: Filters = {
    status: get('status') ?? 'pending',
    severity: get('severity'),
    ruleType: get('rule_type'),
    targetReason: parseIntParam(get('target_reason')),
    sourceTable: get('source'),
    catId: parseIntParam(get('cat')),
    npId: parseIntParam(get('np')),
    q: get('q'),
  };

  let result: Awaited<ReturnType<typeof fetchEnrichedProposals>> | null = null;
  let allNewspapers: NewspaperOption[] = [];
  let allReasons: {id: number, name: string}[] = [];
  let dbError: string | null = null;
  try {
    [result, allNewspapers, allReasons] = await Promise.all([
      fetchEnrichedProposals(filters),
      fetchAllNewspapers(),
      fetchRoReasons(),
    ]);
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  // Status tab links preserve other filters
  function statusHref(s: string) {
    const params = new URLSearchParams();
    Object.entries(sp).forEach(([k, v]) => {
      if (k === 'status') return;
      const val = Array.isArray(v) ? v[0] : v;
      if (val) params.set(k, val);
    });
    params.set('status', s);
    return `?${params.toString()}`;
  }

  return (
    <>
      <h1>Rule Proposals</h1>

      {dbError && (
        <div className="card" style={{ background: 'var(--hard-bg)', color: 'var(--danger)' }}>
          <strong>DB error:</strong> {dbError}
        </div>
      )}

      <div className="flex" style={{ marginBottom: 12 }}>
        {(['pending', 'approved', 'rejected', 'superseded'] as const).map((s) => (
          <Link
            key={s}
            href={statusHref(s)}
            className="btn"
            style={
              filters.status === s
                ? { background: 'var(--primary)', color: 'white', borderColor: 'var(--primary)' }
                : {}
            }
          >
            {s}
          </Link>
        ))}
      </div>

      {result && (
        <ProposalFilters
          options={result.filterOptions}
          total={result.total}
          unfilteredTotal={result.unfilteredTotal}
          status={filters.status}
        />
      )}

      {result?.proposals.length === 0 ? (
        <div className="card">
          <p className="muted">
            No <code>{filters.status}</code> proposals match the current filters.{' '}
            {filters.status === 'pending' && result.unfilteredTotal === 0 && (
              <>
                Run <code>python3 scripts/extract_starter_rules.py</code> to populate, or use the
                &ldquo;Draft a rule&rdquo; action in the review UI.
              </>
            )}
          </p>
        </div>
      ) : (
        result?.proposals.map((p) => (
          <ProposalRow
            key={p.id}
            proposal={p}
            editable={filters.status === 'pending'}
            allNewspapers={allNewspapers}
            allReasons={allReasons}
          />
        ))
      )}
    </>
  );
}
