import { queryRmaAi } from '@/lib/db/rmaAi';
import { queryRma } from '@/lib/db/rma';

export interface ProposalFilters {
  status: string;
  severity?: string;
  ruleType?: string;
  targetReason?: number;
  sourceTable?: string;
  catId?: number;
  npId?: number;
  q?: string;
}

interface RawProposalRow {
  id: number;
  proposed_by: string;
  source_alignment_id: number | null;
  source_cat_mes_id: number | null;
  source_table: string | null;
  proposed_payload: unknown;
  status: string;
  notes: string | null;
  created_at: string;
  decided_at: string | null;
  resulting_rule_id: number | null;
}

interface CatMesRow {
  id: number;
  category_id: string | null;
  newspaper: string | null;
  msg: string | null;
  msg_page: string | null;
}

interface CategoryRow {
  category_id: number;
  category_name: string;
  parent_cat_id: number | null;
  np_id: number | null;
}

interface NewspaperRow {
  np_id: number;
  title: string;
}

export interface ResolvedCategory {
  id: number;
  name: string;
  npId: number | null;
  npTitle: string | null;
}

export interface EnrichedProposal {
  id: number;
  proposed_by: string;
  status: string;
  notes: string | null;
  created_at: string;
  decided_at: string | null;
  resulting_rule_id: number | null;
  source_alignment_id: number | null;
  source_table: string | null;
  source_cat_mes_id: number | null;

  payload: Record<string, unknown>;
  name: string;
  description: string;
  customerMessage: string;
  severity: string;
  ruleType: string;
  targetReason: number[] | null;

  sourceCategoryId: number | null;
  sourceCategoryName: string | null;
  topCategoryId: number | null;
  topCategoryName: string | null;
  isNewspaperSpecificCategory: boolean;
  newspapers: { np_id: number; title: string }[];
  appliesToAllNewspapers: boolean;
  sourceAdvisory: string | null;
  sourceAdvisoryPage: string | null;

  // The rule's *effective* scope on approval, resolved to names.
  // null array = applies to all (newspapers or categories respectively).
  effectiveNpScope: { np_id: number; title: string }[] | null;
  effectiveCategoryScope: ResolvedCategory[] | null;
  // Root ancestors of every category in effectiveCategoryScope, deduped.
  // null when effectiveCategoryScope is null (= rule applies to all categories).
  effectiveTopCategories: { id: number; name: string }[] | null;
}

export interface NewspaperOption {
  np_id: number;
  title: string;
}

export interface FilterOptions {
  categories: { id: number; name: string; count: number }[];
  newspapers: { id: number; title: string; count: number }[];
  targetReasons: { id: number; count: number }[];
  severities: { value: string; count: number }[];
  ruleTypes: { value: string; count: number }[];
  sources: { value: string; count: number }[];
}

export interface ProposalsResult {
  proposals: EnrichedProposal[];
  filterOptions: FilterOptions;
  total: number;
  unfilteredTotal: number;
}

function stripHtml(html: string | null): string {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseNewspaperCsv(csv: string | null): number[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

// cat_mes.category_id is *usually* a single id but the column can hold a CSV.
// When it does, the rightmost id is the most-specific (leafmost) category, so
// we take the tail rather than the head.
function parseLastCategoryId(raw: string | null): number | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const n = parseInt(parts[i], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export async function fetchAllNewspapers(): Promise<NewspaperOption[]> {
  const rows = await queryRma<NewspaperRow>(
    `SELECT np_id, title FROM newspaper_master WHERE act = '1' ORDER BY title`,
  );
  return rows.map((r) => ({ np_id: r.np_id, title: r.title }));
}

export async function fetchEnrichedProposals(filters: ProposalFilters): Promise<ProposalsResult> {
  // Phase 1: pull proposals with non-relational filters pushed down to SQL.
  const where: string[] = ['status = ?'];
  const params: (string | number)[] = [filters.status];
  if (filters.severity) {
    where.push(`JSON_UNQUOTE(JSON_EXTRACT(proposed_payload, '$.severity')) = ?`);
    params.push(filters.severity);
  }
  if (filters.ruleType) {
    where.push(`JSON_UNQUOTE(JSON_EXTRACT(proposed_payload, '$.rule_type')) = ?`);
    params.push(filters.ruleType);
  }
  if (filters.targetReason != null) {
    where.push(`JSON_CONTAINS(JSON_EXTRACT(proposed_payload, '$.target_ro_reason'), ?)`);
    params.push(String(filters.targetReason));
  }
  if (filters.sourceTable) {
    where.push(`source_table = ?`);
    params.push(filters.sourceTable);
  }

  const rawProposals = await queryRmaAi<RawProposalRow>(
    `SELECT id, proposed_by, source_alignment_id, source_cat_mes_id, source_table,
            proposed_payload, status, notes, created_at, decided_at, resulting_rule_id
     FROM editorial_rule_proposal
     WHERE ${where.join(' AND ')}
     ORDER BY id DESC`,
    params,
  );

  // Parse every payload once so we can both resolve scope and reuse later.
  const parsedPayloads = new Map<number, Record<string, unknown>>();
  for (const p of rawProposals) {
    const parsed =
      typeof p.proposed_payload === 'string'
        ? (JSON.parse(p.proposed_payload) as Record<string, unknown>)
        : (p.proposed_payload as Record<string, unknown>);
    parsedPayloads.set(p.id, parsed);
  }

  function payloadNumberArray(value: unknown): number[] | null {
    if (!Array.isArray(value)) return null;
    const out: number[] = [];
    for (const v of value) {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
    return out.length > 0 ? out : null;
  }

  // Phase 2: pull cat_mes rows for proposals that reference one (used purely for
  // the "From advisory" block in the UI; effective scope comes from the payload).
  const catMesIds = Array.from(
    new Set(rawProposals.map((p) => p.source_cat_mes_id).filter((id): id is number => id != null)),
  );

  const catMesById = new Map<number, CatMesRow>();
  const categoryById = new Map<number, CategoryRow>();
  const newspaperById = new Map<number, NewspaperRow>();

  if (catMesIds.length > 0) {
    const placeholders = catMesIds.map(() => '?').join(',');
    const catMesRows = await queryRma<CatMesRow>(
      `SELECT id, category_id, newspaper, msg, msg_page
       FROM cat_mes
       WHERE id IN (${placeholders})`,
      catMesIds,
    );
    catMesRows.forEach((r) => catMesById.set(r.id, r));
  }

  // Phase 3: collect every category id and np id we'll need to resolve to names —
  // both source-advisory side (cat_mes) and rule-effective side (payload).
  const allLeafCatIds = new Set<number>();
  for (const cm of catMesById.values()) {
    const id = parseLastCategoryId(cm.category_id);
    if (id != null) allLeafCatIds.add(id);
  }
  for (const payload of parsedPayloads.values()) {
    const cats = payloadNumberArray(payload.category_scope);
    if (cats) for (const id of cats) allLeafCatIds.add(id);
  }
  if (allLeafCatIds.size > 0) {
    const ids = Array.from(allLeafCatIds);
    const placeholders = ids.map(() => '?').join(',');
    const leafRows = await queryRma<CategoryRow>(
      `SELECT category_id, category_name, parent_cat_id, np_id
       FROM new_categories
       WHERE category_id IN (${placeholders})`,
      ids,
    );
    leafRows.forEach((r) => categoryById.set(r.category_id, r));

    // Walk up the tree until every parent is resolved (capped to avoid cycles).
    for (let hop = 0; hop < 6; hop++) {
      const missing = Array.from(categoryById.values())
        .map((r) => r.parent_cat_id)
        .filter((id): id is number => id != null && id > 0 && !categoryById.has(id));
      if (missing.length === 0) break;
      const uniq = Array.from(new Set(missing));
      const pPlaceholders = uniq.map(() => '?').join(',');
      const parentRows = await queryRma<CategoryRow>(
        `SELECT category_id, category_name, parent_cat_id, np_id
         FROM new_categories
         WHERE category_id IN (${pPlaceholders})`,
        uniq,
      );
      parentRows.forEach((r) => categoryById.set(r.category_id, r));
    }
  }

  const allNpIds = new Set<number>();
  for (const cm of catMesById.values()) {
    for (const id of parseNewspaperCsv(cm.newspaper)) allNpIds.add(id);
  }
  for (const payload of parsedPayloads.values()) {
    const np = payloadNumberArray(payload.np_scope);
    if (np) for (const id of np) allNpIds.add(id);
  }
  // Include np_ids referenced by newspaper-specific categories so the picker
  // can surface "this category belongs to <Newspaper>" on the chip.
  for (const cat of categoryById.values()) {
    if (cat.np_id != null && cat.np_id > 0) allNpIds.add(cat.np_id);
  }
  if (allNpIds.size > 0) {
    const ids = Array.from(allNpIds);
    const placeholders = ids.map(() => '?').join(',');
    const rows = await queryRma<NewspaperRow>(
      `SELECT np_id, title FROM newspaper_master WHERE np_id IN (${placeholders})`,
      ids,
    );
    rows.forEach((r) => newspaperById.set(r.np_id, r));
  }

  function topAncestor(catId: number | null): CategoryRow | null {
    if (catId == null) return null;
    let cur = categoryById.get(catId);
    let safety = 6;
    while (cur && cur.parent_cat_id && cur.parent_cat_id > 0 && safety-- > 0) {
      const next = categoryById.get(cur.parent_cat_id);
      if (!next) break;
      cur = next;
    }
    return cur ?? null;
  }

  // Phase 3: build enriched rows
  const enriched: EnrichedProposal[] = rawProposals.map((p) => {
    const payload = parsedPayloads.get(p.id) as Record<string, unknown>;

    const catMes = p.source_cat_mes_id != null ? catMesById.get(p.source_cat_mes_id) : undefined;
    const leafCatId = catMes?.category_id ? parseLastCategoryId(catMes.category_id) : null;
    const leafCat = leafCatId != null ? categoryById.get(leafCatId) ?? null : null;
    const topCat = leafCat ? topAncestor(leafCat.category_id) : null;

    const npIds = parseNewspaperCsv(catMes?.newspaper ?? null);
    const appliesToAllNewspapers = !!catMes && (catMes.newspaper ?? '').trim() === '';
    const newspapers = npIds
      .map((id) => newspaperById.get(id))
      .filter((n): n is NewspaperRow => !!n)
      .map((n) => ({ np_id: n.np_id, title: n.title }));

    const payloadNpScope = payloadNumberArray(payload.hard_np_scope) ?? payloadNumberArray(payload.soft_np_scope) ?? payloadNumberArray(payload.np_scope);
    const payloadCatScope = payloadNumberArray(payload.hard_category_scope) ?? payloadNumberArray(payload.soft_category_scope) ?? payloadNumberArray(payload.category_scope);
    const effectiveNpScope = payloadNpScope
      ? payloadNpScope.map((id) => {
          const row = newspaperById.get(id);
          return { np_id: id, title: row?.title ?? `np#${id}` };
        })
      : null;
    const effectiveCategoryScope = payloadCatScope
      ? payloadCatScope.map((id) => {
          const row = categoryById.get(id);
          const npId = row?.np_id != null && row.np_id > 0 ? row.np_id : null;
          const npTitle = npId != null ? newspaperById.get(npId)?.title ?? null : null;
          return {
            id,
            name: row?.category_name ?? `cat#${id}`,
            npId,
            npTitle,
          };
        })
      : null;
    let effectiveTopCategories: { id: number; name: string }[] | null = null;
    if (payloadCatScope) {
      const seen = new Set<number>();
      effectiveTopCategories = [];
      for (const leafId of payloadCatScope) {
        const top = topAncestor(leafId);
        if (top && !seen.has(top.category_id)) {
          seen.add(top.category_id);
          effectiveTopCategories.push({ id: top.category_id, name: top.category_name });
        }
      }
    }

    return {
      id: p.id,
      proposed_by: p.proposed_by,
      status: p.status,
      notes: p.notes,
      created_at: p.created_at,
      decided_at: p.decided_at,
      resulting_rule_id: p.resulting_rule_id,
      source_alignment_id: p.source_alignment_id,
      source_table: p.source_table,
      source_cat_mes_id: p.source_cat_mes_id,
      payload,
      name: (payload.name as string) ?? '(no name)',
      description: (payload.description as string) ?? '',
      customerMessage: (payload.customer_message as string) ?? '',
      severity: (payload.hard_category_scope || payload.hard_np_scope || payload.severity === 'hard') ? 'hard' : 'soft',
      ruleType: (payload.rule_type as string) ?? 'custom_function',
      targetReason: payloadNumberArray(payload.target_ro_reason),
      sourceCategoryId: leafCat?.category_id ?? (Number.isFinite(leafCatId) ? leafCatId : null),
      sourceCategoryName: leafCat?.category_name ?? null,
      topCategoryId: topCat?.category_id ?? null,
      topCategoryName: topCat?.category_name ?? null,
      isNewspaperSpecificCategory: !!leafCat && leafCat.np_id != null && leafCat.np_id > 0,
      newspapers,
      appliesToAllNewspapers,
      sourceAdvisory: stripHtml(catMes?.msg ?? null) || null,
      sourceAdvisoryPage: catMes?.msg_page ?? null,
      effectiveNpScope,
      effectiveCategoryScope,
      effectiveTopCategories,
    };
  });

  // Phase 4: build filter options from the *pre-category-filter* universe so
  // dropdowns show what's actually pickable inside the current status/etc. scope.
  const filterOptions = buildFilterOptions(enriched);

  // Phase 5: apply filters using the rule's *effective* scope. A null scope on a
  // proposal means "applies to all" — so it matches any specific filter value.
  // The Category filter is a single field that matches against either the rule's
  // leaf scope or any top-ancestor of it, so picking a parent category still
  // surfaces rules scoped to one of its descendants.
  const q = filters.q?.trim().toLowerCase();
  const filtered = enriched.filter((p) => {
    if (filters.catId != null) {
      if (p.effectiveCategoryScope !== null) {
        const leafMatch = p.effectiveCategoryScope.some((c) => c.id === filters.catId);
        const topMatch = p.effectiveTopCategories?.some((c) => c.id === filters.catId) ?? false;
        if (!leafMatch && !topMatch) return false;
      }
    }
    if (filters.npId != null) {
      if (p.effectiveNpScope !== null && !p.effectiveNpScope.some((n) => n.np_id === filters.npId))
        return false;
    }
    if (q) {
      const hay = `${p.name} ${p.description} ${p.customerMessage}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return {
    proposals: filtered,
    filterOptions,
    total: filtered.length,
    unfilteredTotal: rawProposals.length,
  };
}

function buildFilterOptions(rows: EnrichedProposal[]): FilterOptions {
  // For effective-scope filters: count = proposals that would match if you selected
  // this option = proposals where the scope is null (applies-to-all) PLUS proposals
  // whose specific scope includes this option. The dropdown lists every value that
  // appears in at least one specific scope.
  //
  // Category is a single filter: each proposal contributes its leaves AND each
  // leaf's top ancestor (deduped) so picking either a parent or a leaf works.
  const categorySpecific = new Map<number, { name: string; count: number }>();
  const npSpecific = new Map<number, { title: string; count: number }>();
  let allCategoryCount = 0;
  let allNpCount = 0;

  const targetReason = new Map<number, number>();
  const severity = new Map<string, number>();
  const ruleType = new Map<string, number>();
  const source = new Map<string, number>();

  for (const r of rows) {
    if (r.effectiveCategoryScope === null) {
      allCategoryCount++;
    } else {
      const seen = new Map<number, string>();
      for (const c of r.effectiveCategoryScope) seen.set(c.id, c.name);
      if (r.effectiveTopCategories) {
        for (const c of r.effectiveTopCategories) {
          if (!seen.has(c.id)) seen.set(c.id, c.name);
        }
      }
      for (const [id, name] of seen) {
        const existing = categorySpecific.get(id);
        categorySpecific.set(id, { name, count: (existing?.count ?? 0) + 1 });
      }
    }

    if (r.effectiveNpScope === null) {
      allNpCount++;
    } else {
      for (const n of r.effectiveNpScope) {
        const existing = npSpecific.get(n.np_id);
        npSpecific.set(n.np_id, { title: n.title, count: (existing?.count ?? 0) + 1 });
      }
    }

    if (r.targetReason != null) {
      for (const tr of r.targetReason) {
        targetReason.set(tr, (targetReason.get(tr) ?? 0) + 1);
      }
    }
    severity.set(r.severity, (severity.get(r.severity) ?? 0) + 1);
    ruleType.set(r.ruleType, (ruleType.get(r.ruleType) ?? 0) + 1);
    if (r.source_table) {
      source.set(r.source_table, (source.get(r.source_table) ?? 0) + 1);
    }
  }

  // Bake the all-scope count into every specific option's count so the displayed
  // number matches what the filter will actually return.
  for (const [id, v] of categorySpecific)
    categorySpecific.set(id, { ...v, count: v.count + allCategoryCount });
  for (const [id, v] of npSpecific) npSpecific.set(id, { ...v, count: v.count + allNpCount });

  const byCountDesc = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

  return {
    categories: Array.from(categorySpecific, ([id, v]) => ({ id, ...v })).sort(byCountDesc),
    newspapers: Array.from(npSpecific, ([id, v]) => ({ id, ...v })).sort(byCountDesc),
    targetReasons: Array.from(targetReason, ([id, count]) => ({ id, count })).sort(byCountDesc),
    severities: Array.from(severity, ([value, count]) => ({ value, count })).sort(byCountDesc),
    ruleTypes: Array.from(ruleType, ([value, count]) => ({ value, count })).sort(byCountDesc),
    sources: Array.from(source, ([value, count]) => ({ value, count })).sort(byCountDesc),
  };
}
