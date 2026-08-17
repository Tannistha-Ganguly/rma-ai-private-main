'use server';

import { revalidatePath } from 'next/cache';
import Anthropic from '@anthropic-ai/sdk';
import { executeRmaAi, queryRmaAi } from '@/lib/db/rmaAi';
import { queryRma, executeRmaWrite } from '@/lib/db/rma';
import { checkAd } from '@/lib/engine';
import type { Rule, CategoryChoice, Finding, Verdict } from '@/lib/engine/types';
import { computeAlignment, type AlignmentResult } from '@/lib/alignment/compute';

import { EDITORIAL_REASONS_LIST as EDITORIAL_REASONS } from '@/lib/engine/constants';

interface ProposalRow {
  id: number;
  proposed_payload: string;
}

export interface ProposalOverrides {
  hard_np_scope?: number[] | null;
  hard_category_scope?: number[] | null;
  soft_np_scope?: number[] | null;
  soft_category_scope?: number[] | null;
  target_ro_reason?: number[] | null;
  name?: string;
  customer_message?: string;
  severity?: 'hard' | 'soft';
}

export async function fetchRoReasons(): Promise<Array<{ id: number; name: string }>> {
  const rows = await queryRma<{ id: number; name: string }>(
    `SELECT id, name FROM ro_reason ORDER BY name ASC`,
  );
  return rows;
}

export async function fetchAllCategories(): Promise<Array<{ id: number; name: string }>> {
  const rows = await queryRma<{ category_id: number; category_name: string; parent_cat_id: number | null }>(
    `SELECT category_id, category_name, parent_cat_id FROM new_categories`
  );
  
  const map = new Map<number, { name: string; parent: number | null }>();
  for (const r of rows) {
    map.set(r.category_id, { name: r.category_name.trim(), parent: r.parent_cat_id });
  }

  return rows.map(r => {
    let name = r.category_name.trim();
    const parts = [];
    let cur = r.parent_cat_id;
    let safety = 5;
    while (cur && cur > 0 && map.has(cur) && safety-- > 0) {
      parts.push(map.get(cur)!.name);
      cur = map.get(cur)!.parent;
    }
    if (parts.length > 0) {
      name = `${name} (${parts.reverse().join(' > ')})`;
    }
    return { id: r.category_id, name };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchTopLevelCategories(): Promise<Array<{ id: number; name: string }>> {
  const rows = await queryRma<{ category_id: number; category_name: string }>(
    `SELECT category_id, category_name FROM new_categories WHERE parent_cat_id = 0 OR parent_cat_id IS NULL ORDER BY category_name ASC`
  );
  return rows.map(r => ({ id: r.category_id, name: r.category_name }));
}

export async function fetchCategoryDescendants(parentId: number): Promise<number[]> {
  const rows = await queryRma<{ category_id: number; parent_cat_id: number | null }>(
    `SELECT category_id, parent_cat_id FROM new_categories`
  );
  const childrenMap = new Map<number, number[]>();
  for (const r of rows) {
    const pid = r.parent_cat_id || 0;
    if (!childrenMap.has(pid)) childrenMap.set(pid, []);
    childrenMap.get(pid)!.push(r.category_id);
  }
  const descendants = new Set<number>();
  descendants.add(parentId);
  const queue = [parentId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const children = childrenMap.get(cur) || [];
    for (const child of children) {
      if (!descendants.has(child)) {
        descendants.add(child);
        queue.push(child);
      }
    }
  }
  return Array.from(descendants);
}

export async function fetchAllNewspapers(): Promise<Array<{ id: number; name: string }>> {
  const rows = await queryRma<{ np_id: number; title: string }>(
    `SELECT np_id, title FROM newspaper_master WHERE act = '1' ORDER BY title ASC`
  );
  return rows.map(r => ({ id: r.np_id, name: r.title }));
}

export async function approveProposal(
  proposalId: number,
  reviewerUserId: number | null = null,
  overrides: ProposalOverrides | null = null,
) {
  const rows = await queryRmaAi<ProposalRow>(
    `SELECT id, proposed_payload FROM editorial_rule_proposal WHERE id = ? AND status='pending'`,
    [proposalId],
  );
  if (rows.length === 0) throw new Error('Proposal not found or already decided');
  const original = typeof rows[0].proposed_payload === 'string' ? JSON.parse(rows[0].proposed_payload) : rows[0].proposed_payload;

  const merged = { ...original };
  if (overrides) {
    if (overrides.hard_np_scope !== undefined) merged.hard_np_scope = overrides.hard_np_scope;
    if (overrides.hard_category_scope !== undefined) merged.hard_category_scope = overrides.hard_category_scope;
    if (overrides.soft_np_scope !== undefined) merged.soft_np_scope = overrides.soft_np_scope;
    if (overrides.soft_category_scope !== undefined) merged.soft_category_scope = overrides.soft_category_scope;
    if (overrides.target_ro_reason !== undefined) merged.target_ro_reason = overrides.target_ro_reason;
    if (overrides.name !== undefined) merged.name = overrides.name;
    if (overrides.customer_message !== undefined) merged.customer_message = overrides.customer_message;
    if (overrides.severity !== undefined) merged.severity = overrides.severity;
  }

  // Normalize: if np_scope covers every active newspaper, store NULL so the rule
  // and the UI both treat it as the canonical "all newspapers" case.
  const countRows = await queryRma<{ c: number }>(`SELECT COUNT(*) AS c FROM newspaper_master WHERE act = '1'`);
  const activeNpCount = Number(countRows[0]?.c ?? 0);
  if (activeNpCount > 0) {
    if (Array.isArray(merged.hard_np_scope) && merged.hard_np_scope.length >= activeNpCount) merged.hard_np_scope = null;
    if (Array.isArray(merged.soft_np_scope) && merged.soft_np_scope.length >= activeNpCount) merged.soft_np_scope = null;
  }

  const catRows = await queryRma<{ c: number }>(`SELECT COUNT(*) AS c FROM new_categories`);
  const activeCatCount = Number(catRows[0]?.c ?? 0);
  if (activeCatCount > 0) {
    if (Array.isArray(merged.hard_category_scope) && merged.hard_category_scope.length >= activeCatCount) merged.hard_category_scope = null;
    if (Array.isArray(merged.soft_category_scope) && merged.soft_category_scope.length >= activeCatCount) merged.soft_category_scope = null;
  }

  const insert = await executeRmaAi(
    `INSERT INTO editorial_rule
      (name, description, customer_message, rule_type, pattern, severity,
       hard_category_scope, hard_np_scope, soft_category_scope, soft_np_scope, target_ro_reason, source, source_cat_mes_id, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      merged.name ?? '(no name)',
      merged.description ?? '',
      merged.customer_message ?? '',
      merged.rule_type ?? 'custom_function',
      JSON.stringify(merged.pattern ?? {}),
      merged.severity ?? 'hard',
      merged.hard_category_scope ? JSON.stringify(merged.hard_category_scope) : null,
      merged.hard_np_scope ? JSON.stringify(merged.hard_np_scope) : null,
      merged.soft_category_scope ? JSON.stringify(merged.soft_category_scope) : null,
      merged.soft_np_scope ? JSON.stringify(merged.soft_np_scope) : null,
      merged.target_ro_reason ? JSON.stringify(merged.target_ro_reason) : null,
      merged.source ?? 'llm_proposed',
      merged.source_cat_mes_id ?? null,
      reviewerUserId,
    ],
  );
  // Persist the merged payload so the audit trail reflects what was actually approved.
  await executeRmaAi(
    `UPDATE editorial_rule_proposal
       SET status='approved', decided_by=?, decided_at=NOW(), resulting_rule_id=?, proposed_payload=?
     WHERE id=?`,
    [reviewerUserId, insert.insertId, JSON.stringify(merged), proposalId],
  );
  revalidatePath('/proposals');
  revalidatePath('/rules');
  revalidatePath('/dashboard');
}

export async function rejectProposal(proposalId: number, reviewerUserId: number | null = null, notes: string = '') {
  await executeRmaAi(
    `UPDATE editorial_rule_proposal SET status='rejected', decided_by=?, decided_at=NOW(), notes=? WHERE id=? AND status='pending'`,
    [reviewerUserId, notes || null, proposalId],
  );
  revalidatePath('/proposals');
}

export async function reopenProposal(proposalId: number) {
  // Keep notes around so the original rejection reason is visible when re-reviewing.
  await executeRmaAi(
    `UPDATE editorial_rule_proposal SET status='pending', decided_by=NULL, decided_at=NULL WHERE id=? AND status='rejected'`,
    [proposalId],
  );
  revalidatePath('/proposals');
}

export async function setRuleStatus(ruleId: number, status: 'active' | 'disabled' | 'proposed') {
  await executeRmaAi(
    `UPDATE editorial_rule SET status=?, updated_at=NOW() WHERE id=?`,
    [status, ruleId],
  );
  revalidatePath('/rules');
  revalidatePath('/dashboard');
}

export async function updateRule(
  ruleId: number,
  patch: {
    name?: string;
    description?: string;
    customer_message?: string;
    pattern?: object;
    severity?: 'hard' | 'soft';
    hard_category_scope?: number[] | null;
    hard_np_scope?: number[] | null;
    soft_category_scope?: number[] | null;
    soft_np_scope?: number[] | null;
    target_ro_reason?: number[] | null;
  },
) {
  const countRows = await queryRma<{ c: number }>(`SELECT COUNT(*) AS c FROM newspaper_master WHERE act = '1'`);
  const activeNpCount = Number(countRows[0]?.c ?? 0);
  if (activeNpCount > 0) {
    if (Array.isArray(patch.hard_np_scope) && patch.hard_np_scope.length >= activeNpCount) patch.hard_np_scope = null;
    if (Array.isArray(patch.soft_np_scope) && patch.soft_np_scope.length >= activeNpCount) patch.soft_np_scope = null;
  }

  const catRows = await queryRma<{ c: number }>(`SELECT COUNT(*) AS c FROM new_categories`);
  const activeCatCount = Number(catRows[0]?.c ?? 0);
  if (activeCatCount > 0) {
    if (Array.isArray(patch.hard_category_scope) && patch.hard_category_scope.length >= activeCatCount) patch.hard_category_scope = null;
    if (Array.isArray(patch.soft_category_scope) && patch.soft_category_scope.length >= activeCatCount) patch.soft_category_scope = null;
  }

  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push('description = ?');
    params.push(patch.description);
  }
  if (patch.customer_message !== undefined) {
    fields.push('customer_message = ?');
    params.push(patch.customer_message);
  }
  if (patch.pattern !== undefined) {
    fields.push('pattern = ?');
    params.push(JSON.stringify(patch.pattern));
  }
  if (patch.severity !== undefined) {
    fields.push('severity = ?');
    params.push(patch.severity);
  }
  if (patch.hard_category_scope !== undefined) {
    fields.push('hard_category_scope = ?');
    params.push(patch.hard_category_scope ? JSON.stringify(patch.hard_category_scope) : null);
  }
  if (patch.hard_np_scope !== undefined) {
    fields.push('hard_np_scope = ?');
    params.push(patch.hard_np_scope ? JSON.stringify(patch.hard_np_scope) : null);
  }
  if (patch.soft_category_scope !== undefined) {
    fields.push('soft_category_scope = ?');
    params.push(patch.soft_category_scope ? JSON.stringify(patch.soft_category_scope) : null);
  }
  if (patch.soft_np_scope !== undefined) {
    fields.push('soft_np_scope = ?');
    params.push(patch.soft_np_scope ? JSON.stringify(patch.soft_np_scope) : null);
  }
  if (patch.target_ro_reason !== undefined) {
    fields.push('target_ro_reason = ?');
    params.push(patch.target_ro_reason && patch.target_ro_reason.length > 0 ? JSON.stringify(patch.target_ro_reason) : null);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = NOW()');
  params.push(ruleId);
  await executeRmaAi(`UPDATE editorial_rule SET ${fields.join(', ')} WHERE id = ?`, params);
  revalidatePath('/rules');
}

export interface OnDemandCheckResult {
  ok: true;
  ad_id: number;
  source: 'pre_edit' | 'current';
  ad_text: string;
  category: CategoryChoice;
  category_csv: string;
  category_name?: string;
  np_id: number | null;
  np_name?: string;
  findings: Finding[];
  verdict: Verdict;
  ro_reasons: Array<{ id: number; name: string }>;
  alignment: AlignmentResult;
  latency_ms: number;
  llm_used: boolean;
  llm_cost_paise: number;
}
export interface OnDemandCheckError {
  ok: false;
  error: string;
}

function parseCategoryCsv(csv: string | null | undefined): CategoryChoice {
  if (!csv) return {};
  const parts = csv.split(',').map((s) => s.trim());
  const toNum = (s: string | undefined): number | undefined => {
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return { top: toNum(parts[0]), sub: toNum(parts[1]), sub_sub: toNum(parts[2]), sub_sub_sub: toNum(parts[3]) };
}

async function loadActiveRulesForCheck(): Promise<Rule[]> {
  const rows = await queryRmaAi<{
    id: number; name: string; description: string; customer_message: string;
    rule_type: Rule['rule_type']; pattern: string;
    hard_category_scope: string | null; hard_np_scope: string | null;
    soft_category_scope: string | null; soft_np_scope: string | null;
    target_ro_reason: string | null; severity: Rule['severity']; base_score: number; status: Rule['status'];
  }>(`
    SELECT id, name, description, customer_message, rule_type, pattern,
           hard_category_scope, hard_np_scope, soft_category_scope, soft_np_scope, severity, target_ro_reason, base_score, status
    FROM editorial_rule
    WHERE status = 'active'
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    customer_message: r.customer_message,
    rule_type: r.rule_type,
    pattern: typeof r.pattern === 'string' ? JSON.parse(r.pattern) : r.pattern,
    hard_category_scope: r.hard_category_scope ? (typeof r.hard_category_scope === 'string' ? JSON.parse(r.hard_category_scope) : r.hard_category_scope) : null,
    hard_np_scope: r.hard_np_scope ? (typeof r.hard_np_scope === 'string' ? JSON.parse(r.hard_np_scope) : r.hard_np_scope) : null,
    soft_category_scope: r.soft_category_scope ? (typeof r.soft_category_scope === 'string' ? JSON.parse(r.soft_category_scope) : r.soft_category_scope) : null,
    soft_np_scope: r.soft_np_scope ? (typeof r.soft_np_scope === 'string' ? JSON.parse(r.soft_np_scope) : r.soft_np_scope) : null,
    severity: r.severity,
    target_ro_reason: r.target_ro_reason ? (typeof r.target_ro_reason === 'string' ? JSON.parse(r.target_ro_reason) : r.target_ro_reason) : null,
    base_score: r.base_score ?? 1.0,
    status: r.status,
  }));
}

export async function runOnDemandCheck(adId: number, isShadowRun = false): Promise<OnDemandCheckResult | OnDemandCheckError> {
  if (!Number.isFinite(adId) || adId <= 0) return { ok: false, error: 'Invalid ad ID' };

  try {
    const adRows = await queryRma<{ ad_text: string; category: string | null; scanned_image_file_name: string | null }>(
      `SELECT ad_text, category, scanned_image_file_name FROM ad_master WHERE ad_id = ? LIMIT 1`,
      [adId],
    );
    if (adRows.length === 0) return { ok: false, error: `Ad #${adId} not found in ad_master` };
    const current_text = adRows[0].ad_text ?? '';
    const category_csv = adRows[0].category ?? '';
    const scanned_image_file_name = adRows[0].scanned_image_file_name;

    const preEditRows = await queryRma<{ ad_text: string }>(
      `SELECT ad_text FROM ad_master_update WHERE ad_id = ? AND CHAR_LENGTH(ad_text) > 20 ORDER BY added_on ASC LIMIT 1`,
      [adId],
    );
    const source: 'pre_edit' | 'current' = preEditRows.length > 0 ? 'pre_edit' : 'current';
    const ad_text = source === 'pre_edit' ? preEditRows[0].ad_text : current_text;
    if (!ad_text || ad_text.length < 1) return { ok: false, error: `Ad #${adId} has no ad text` };

    const npRows = await queryRma<{ np_id: number | null }>(
      `SELECT np_id FROM ad_value WHERE ad_id = ? LIMIT 1`,
      [adId],
    );
    const np_id = npRows[0]?.np_id ?? null;

    const reasonRows = await queryRma<{ id: number; name: string }>(
      `SELECT DISTINCT r.id, r.name
         FROM forum_report_email_master frem
         JOIN ro_reason r ON r.id = CAST(frem.reason AS UNSIGNED)
        WHERE frem.ad_id = ?
          AND frem.reason REGEXP '^[0-9]+$'
          AND CAST(frem.reason AS UNSIGNED) IN (${EDITORIAL_REASONS.join(',')})`,
      [adId],
    );
    const ro_reasons = reasonRows.map((r) => ({ id: Number(r.id), name: r.name }));

    const rules = await loadActiveRulesForCheck();
    const ruleById = new Map<number, Rule>(rules.map((r) => [r.id, r]));

    const anthropic = (!isShadowRun && process.env.ANTHROPIC_API_KEY)
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : undefined;

    const category = parseCategoryCsv(category_csv);

    let npName: string | undefined = undefined;
    if (np_id != null) {
      const npTitleRows = await queryRma<{ title: string }>(`SELECT title FROM newspaper_master WHERE np_id = ?`, [np_id]);
      if (npTitleRows.length > 0) npName = npTitleRows[0].title;
    }

    let catName: string | undefined = undefined;
    const catIds = [category.top, category.sub, category.sub_sub].filter(Boolean) as number[];
    if (catIds.length > 0) {
      const catRows = await queryRma<{ category_id: number; category_name: string }>(
        `SELECT category_id, category_name FROM new_categories WHERE category_id IN (${catIds.join(',')})`
      );
      const nameMap = new Map(catRows.map(r => [r.category_id, r.category_name]));
      catName = catIds.map(id => nameMap.get(id) ?? `#${id}`).join('/');
    }

    const result = await checkAd(
      { ad_text, category_chosen: category, np_id: np_id ?? undefined, ad_id: adId, document_url: scanned_image_file_name || undefined },
      { rules, anthropic, skip_categorization: true },
    );

    const alignment = computeAlignment(
      { ad_id: adId, our_findings: result.findings, ro_reason_ids: ro_reasons.map((r) => r.id), eligible: true },
      ruleById,
    );

    return {
      ok: true,
      ad_id: adId,
      source,
      ad_text,
      category,
      category_csv,
      category_name: catName,
      np_id,
      np_name: npName,
      findings: result.findings,
      verdict: result.verdict,
      ro_reasons,
      alignment,
      latency_ms: result.latency_ms,
      llm_used: result.llm_used,
      llm_cost_paise: result.llm_cost_paise,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface NewspaperOptionForCheck {
  np_id: number;
  title: string;
}

export async function listNewspapersForCheck(): Promise<NewspaperOptionForCheck[]> {
  const rows = await queryRma<{ np_id: number; title: string }>(
    `SELECT np_id, title FROM newspaper_master WHERE act = '1' ORDER BY title`,
  );
  return rows.map((r) => ({ np_id: r.np_id, title: r.title }));
}

// Walks parent_cat_id from the picked leaf up to 6 hops and returns the chain
// as a CategoryChoice (top → sub_sub_sub). Lets rules scoped at any ancestor
// level still match when the user picks a deep leaf.
async function resolveCategoryChain(leafId: number): Promise<CategoryChoice> {
  const chain: number[] = [];
  let cur: number | null = leafId;
  const seen = new Set<number>();
  for (let hop = 0; hop < 6 && cur != null && cur > 0; hop++) {
    const here: number = cur;
    if (seen.has(here)) break;
    seen.add(here);
    chain.push(here);
    const rows: { parent_cat_id: number | null }[] = await queryRma<{ parent_cat_id: number | null }>(
      `SELECT parent_cat_id FROM new_categories WHERE category_id = ? LIMIT 1`,
      [here],
    );
    if (rows.length === 0) break;
    cur = rows[0].parent_cat_id ?? null;
  }
  chain.reverse();
  return {
    top: chain[0],
    sub: chain[1],
    sub_sub: chain[2],
    sub_sub_sub: chain[3],
  };
}

export interface OnDemandTextCheckResult {
  ok: true;
  ad_text: string;
  category: CategoryChoice;
  category_name?: string;
  category_id_picked: number | null;
  np_id: number | null;
  np_name?: string;
  findings: Finding[];
  verdict: Verdict;
  latency_ms: number;
  llm_used: boolean;
  llm_cost_paise: number;
}
export interface OnDemandTextCheckError {
  ok: false;
  error: string;
}

export async function runOnDemandCheckText(
  adText: string,
  npId: number | null,
  categoryId: number | null,
): Promise<OnDemandTextCheckResult | OnDemandTextCheckError> {
  const text = (adText ?? '').trim();
  if (text.length < 1) return { ok: false, error: 'Paste some ad text first' };

  try {
    const category: CategoryChoice =
      categoryId && categoryId > 0 ? await resolveCategoryChain(categoryId) : {};

    const rules = await loadActiveRulesForCheck();

    const anthropic = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : undefined;

    let npName: string | undefined = undefined;
    if (npId != null) {
      const npTitleRows = await queryRma<{ title: string }>(`SELECT title FROM newspaper_master WHERE np_id = ?`, [npId]);
      if (npTitleRows.length > 0) npName = npTitleRows[0].title;
    }

    let catName: string | undefined = undefined;
    const catIds = [category.top, category.sub, category.sub_sub].filter(Boolean) as number[];
    if (catIds.length > 0) {
      const catRows = await queryRma<{ category_id: number; category_name: string }>(
        `SELECT category_id, category_name FROM new_categories WHERE category_id IN (${catIds.join(',')})`
      );
      const nameMap = new Map(catRows.map(r => [r.category_id, r.category_name]));
      catName = catIds.map(id => nameMap.get(id) ?? `#${id}`).join('/');
    }

    const result = await checkAd(
      { ad_text: text, category_chosen: category, np_id: npId ?? undefined },
      { rules, anthropic, skip_categorization: true },
    );

    return {
      ok: true,
      ad_text: text,
      category,
      category_name: catName,
      category_id_picked: categoryId && categoryId > 0 ? categoryId : null,
      np_id: npId ?? null,
      np_name: npName,
      findings: result.findings,
      verdict: result.verdict,
      latency_ms: result.latency_ms,
      llm_used: result.llm_used,
      llm_cost_paise: result.llm_cost_paise,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function markAlignmentReviewed(
  alignmentId: number,
  decision:
    | 'rule_correct'
    | 'rule_too_strict'
    | 'rule_too_lax'
    | 'new_rule_needed'
    | 'rule_needs_refinement'
    | 'data_quality_issue'
    | 'ignored',
  reviewerUserId: number | null = null,
  action: string = '',
) {
  await executeRmaAi(
    `UPDATE editorial_check_alignment
     SET review_decision=?, reviewed_by=?, reviewed_at=NOW(), resulting_action=?
     WHERE id=?`,
    [decision, reviewerUserId, action || null, alignmentId],
  );
  revalidatePath('/review');
}

function parseJsonValue<T>(v: unknown, fallback: T): T {
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

interface AlignmentContextRow {
  ad_id: number;
  ro_reason_ids: unknown;
  ad_text_snapshot: string;
  np_id: number | null;
  category_chosen: unknown;
}

export async function proposeRuleFromAlignment(
  alignmentId: number,
  ruleName: string = '',
  note: string = '',
  reviewerUserId: number | null = null,
): Promise<{ proposalId: number }> {
  const trimmedName = ruleName.trim();
  // Idempotent: if a proposal already exists for this alignment, return it.
  const existing = await queryRmaAi<{ id: number; proposed_payload: unknown }>(
    `SELECT id, proposed_payload FROM editorial_rule_proposal WHERE source_alignment_id = ? ORDER BY id DESC LIMIT 1`,
    [alignmentId],
  );
  if (existing.length > 0) {
    // If a name was supplied this time, update the existing draft so the
    // reviewer's intent is captured even on re-click.
    if (trimmedName) {
      const existingPayload = parseJsonValue<Record<string, unknown>>(existing[0].proposed_payload, {});
      existingPayload.name = trimmedName;
      existingPayload.pattern = { prompt: `Flag if the ad text matches this criterion: ${trimmedName}.` };
      await executeRmaAi(
        `UPDATE editorial_rule_proposal SET proposed_payload = ? WHERE id = ?`,
        [JSON.stringify(existingPayload), existing[0].id],
      );
    }
    await executeRmaAi(
      `UPDATE editorial_check_alignment
         SET review_decision='new_rule_needed', reviewed_by=?, reviewed_at=NOW(), resulting_action=?
       WHERE id=?`,
      [reviewerUserId, note || null, alignmentId],
    );
    revalidatePath('/review');
    revalidatePath('/proposals');
    return { proposalId: existing[0].id };
  }

  const rows = await queryRmaAi<AlignmentContextRow>(
    `SELECT a.ad_id, a.ro_reason_ids,
            r.ad_text_snapshot, r.np_id, r.category_chosen
     FROM editorial_check_alignment a
     JOIN editorial_check_run r ON r.id = a.check_run_id
     WHERE a.id = ?`,
    [alignmentId],
  );
  if (rows.length === 0) throw new Error(`Alignment #${alignmentId} not found`);
  const row = rows[0];

  const roIds = parseJsonValue<number[]>(row.ro_reason_ids, []);
  const category = parseJsonValue<{ top?: number; sub?: number; sub_sub?: number; sub_sub_sub?: number }>(
    row.category_chosen,
    {},
  );

  // Most specific category we have — reviewer can widen on /proposals.
  const leafCategory =
    category.sub_sub_sub ?? category.sub_sub ?? category.sub ?? category.top ?? null;

  // Best-effort: resolve the first RO reason's name. Non-fatal if it fails.
  let reasonName = 'an editorial issue';
  const targetReasonId = roIds.length > 0 ? roIds[0] : null;
  if (targetReasonId != null) {
    try {
      const reasonRows = await queryRma<{ name: string }>(
        `SELECT name FROM ro_reason WHERE id = ? LIMIT 1`,
        [targetReasonId],
      );
      if (reasonRows.length > 0 && reasonRows[0].name) {
        reasonName = reasonRows[0].name;
      }
    } catch {
      // fall through with the placeholder name
    }
  }

  const snapshot = row.ad_text_snapshot ?? '';
  const excerpt = snapshot.slice(0, 200);
  const truncated = snapshot.length > 200 ? '…' : '';

  const finalName = trimmedName || `Rule for ad #${row.ad_id}: ${reasonName}`;
  const payload = {
    name: finalName,
    description: `Drafted from alignment #${alignmentId}. RO flagged this ad for: ${reasonName}. Excerpt: ${excerpt}${truncated}`,
    customer_message: `This ad may have an issue: ${reasonName}. Please review and adjust before submission.`,
    rule_type: 'llm_semantic',
    pattern: { prompt: `Flag if the ad text matches this criterion: ${finalName}.` },
    soft_category_scope: leafCategory != null ? [leafCategory] : null,
    soft_np_scope: row.np_id != null ? [row.np_id] : null,
    target_ro_reason: targetReasonId ? [targetReasonId] : null,
    source: 'team_added',
    source_cat_mes_id: null,
  };

  const insert = await executeRmaAi(
    `INSERT INTO editorial_rule_proposal
       (proposed_by, source_alignment_id, source_cat_mes_id, source_table,
        proposed_payload, status, notes, created_at)
     VALUES ('reviewer', ?, NULL, 'reviewer_flagged', ?, 'pending', ?, NOW())`,
    [alignmentId, JSON.stringify(payload), note || null],
  );

  await executeRmaAi(
    `UPDATE editorial_check_alignment
       SET review_decision='new_rule_needed', reviewed_by=?, reviewed_at=NOW(), resulting_action=?
     WHERE id=?`,
    [reviewerUserId, note || null, alignmentId],
  );

  revalidatePath('/review');
  revalidatePath('/proposals');
  return { proposalId: insert.insertId };
}

export interface CategorySearchHit {
  id: number;
  name: string;
  parentName: string | null;
  npId: number | null;
  npTitle: string | null;
}

export async function searchCategories(query: string, limit: number = 30): Promise<CategorySearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 100);
  // Match against category_name; tie-break by exact match, then prefix, then length.
  // LEFT JOIN newspaper_master so np-scoped categories carry the newspaper name.
  // No act='1' filter — we still want to show the title even if the newspaper is inactive.
  const rows = await queryRma<{
    category_id: number;
    category_name: string;
    parent_cat_id: number | null;
    np_id: number | null;
    np_title: string | null;
  }>(
    `SELECT c.category_id, c.category_name, c.parent_cat_id, c.np_id, n.title AS np_title
       FROM new_categories c
       LEFT JOIN newspaper_master n ON n.np_id = c.np_id AND c.np_id > 0
      WHERE c.category_name LIKE ?
      ORDER BY
        CASE WHEN c.category_name = ? THEN 0
             WHEN c.category_name LIKE ? THEN 1
             ELSE 2 END,
        CHAR_LENGTH(c.category_name),
        c.category_name
      LIMIT ${bounded}`,
    [`%${q}%`, q, `${q}%`],
  );
  if (rows.length === 0) return [];
  const parentIds = Array.from(
    new Set(rows.map((r) => r.parent_cat_id).filter((id): id is number => id != null && id > 0)),
  );
  const parentNames = new Map<number, string>();
  if (parentIds.length > 0) {
    const parentRows = await queryRma<{ category_id: number; category_name: string }>(
      `SELECT category_id, category_name FROM new_categories WHERE category_id IN (${parentIds.map(() => '?').join(',')})`,
      parentIds,
    );
    for (const p of parentRows) parentNames.set(p.category_id, p.category_name);
  }
  return rows.map((r) => ({
    id: r.category_id,
    name: r.category_name,
    parentName: r.parent_cat_id ? parentNames.get(r.parent_cat_id) ?? null : null,
    npId: r.np_id != null && r.np_id > 0 ? r.np_id : null,
    npTitle: r.np_title ?? null,
  }));
}

// === Shadow batch control ===
// Two modes:
//   'backward' — process the N newest unshadowed ads NOW, via processShadowChunk
//                called repeatedly from the UI. No cron needed. Catches existing
//                ads in ad_master that may already be ops-edited.
//   'forward'  — record start_ad_id at batch start; the PM2 cron worker
//                (scripts/shadow_worker.ts, schedule */5 * * * *) advances the
//                batch by processing ads with ad_id > start_ad_id as they
//                arrive. Catches ads BEFORE ops touches them.
//
// Single-active is enforced per-direction: one backward + one forward
// batch may coexist at any time.

export type ShadowBatchDirection = 'backward' | 'forward';

export interface ShadowBatch {
  id: number;
  target_count: number;
  direction: ShadowBatchDirection;
  processed_count: number;
  start_ad_id: number;
  last_processed_ad_id: number | null;
  status: 'active' | 'completed' | 'cancelled';
  started_at: string | Date;
  completed_at: string | Date | null;
  started_by: number | null;
}

const MAX_SHADOW_BATCH_SIZE = 500;

export async function startShadowBatch(
  targetCount: number,
  direction: ShadowBatchDirection = 'backward',
  startedBy: number | null = null,
): Promise<{ ok: true; batchId: number } | { ok: false; error: string }> {
  if (!Number.isFinite(targetCount) || targetCount <= 0) {
    return { ok: false, error: 'Batch size must be a positive integer' };
  }
  if (direction !== 'backward' && direction !== 'forward') {
    return { ok: false, error: `Invalid direction: ${direction}` };
  }
  const target = Math.min(Math.floor(targetCount), MAX_SHADOW_BATCH_SIZE);

  try {
    // Single-active invariant PER DIRECTION: refuse if same-direction batch is active.
    const active = await queryRmaAi<{ id: number }>(
      `SELECT id FROM shadow_batch WHERE status = 'active' AND direction = ? LIMIT 1`,
      [direction],
    );
    if (active.length > 0) {
      return { ok: false, error: `A ${direction} batch (#${active[0].id}) is already active. Cancel or wait for it to finish before starting a new one of the same kind.` };
    }

    // High-water mark: for forward batches it's the boundary ("process ads strictly newer
    // than this"). For backward batches it's informational/audit only.
    const maxRow = await queryRma<{ max_ad_id: number | null }>(
      `SELECT MAX(ad_id) AS max_ad_id FROM ad_master`,
    );
    const startAdId = Number(maxRow[0]?.max_ad_id ?? 0);
    if (!Number.isFinite(startAdId) || startAdId <= 0) {
      return { ok: false, error: 'Could not read MAX(ad_id) from ad_master' };
    }

    const insert = await executeRmaAi(
      `INSERT INTO shadow_batch (target_count, direction, start_ad_id, started_by) VALUES (?, ?, ?, ?)`,
      [target, direction, startAdId, startedBy],
    );
    revalidatePath('/review');
    return { ok: true, batchId: insert.insertId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function cancelShadowBatch(batchId: number): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(batchId) || batchId <= 0) {
    return { ok: false, error: 'Invalid batch id' };
  }
  try {
    await executeRmaAi(
      `UPDATE shadow_batch
          SET status = 'cancelled', completed_at = NOW()
        WHERE id = ? AND status = 'active'`,
      [batchId],
    );
    revalidatePath('/review');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ShadowBatchStatus {
  activeBackward: ShadowBatch | null;
  activeForward: ShadowBatch | null;
  recent: ShadowBatch[];
}

const SHADOW_BATCH_COLS = `id, target_count, direction, processed_count, start_ad_id, last_processed_ad_id, status, started_at, completed_at, started_by`;

export async function getShadowBatchStatus(): Promise<ShadowBatchStatus> {
  const active = await queryRmaAi<ShadowBatch>(
    `SELECT ${SHADOW_BATCH_COLS} FROM shadow_batch WHERE status = 'active' ORDER BY id DESC`,
  );
  const recent = await queryRmaAi<ShadowBatch>(
    `SELECT ${SHADOW_BATCH_COLS} FROM shadow_batch WHERE status <> 'active' ORDER BY id DESC LIMIT 5`,
  );
  return {
    activeBackward: active.find((b) => b.direction === 'backward') ?? null,
    activeForward: active.find((b) => b.direction === 'forward') ?? null,
    recent,
  };
}

export interface RecentShadowRun {
  id: number;
  ad_id: number;
  verdict: string;
  finding_count: number;
  llm_used: boolean;
  llm_cost_paise: number;
  created_at: string | Date;
  alignment_outcome: string | null;
  findings: any[];
  ad_text_snapshot?: string | null;
  ro_reasons?: { id: number; name: string }[];
  category_name?: string;
  np_name?: string;
  ad_status?: number;
}

export async function getRecentShadowRuns(limit: number = 2000, offset: number = 0): Promise<RecentShadowRun[]> {
  const n = Math.min(Math.max(Math.floor(limit), 1), 5000);
  const o = Math.max(Math.floor(offset), 0);
  const rows = await queryRmaAi<{
    id: number; ad_id: number; verdict: string;
    findings: unknown; llm_used: number; llm_cost_paise: number;
    created_at: string | Date; alignment_outcome: string | null;
    ad_text_snapshot: string | null; ro_reason_ids: unknown;
    category_chosen: unknown; np_id: number | null;
  }>(
    `SELECT r.id, r.ad_id, r.verdict, r.findings, r.llm_used, r.llm_cost_paise,
            r.created_at, r.ad_text_snapshot, r.category_chosen, r.np_id, a.outcome AS alignment_outcome, a.ro_reason_ids
       FROM editorial_check_run r
       LEFT JOIN editorial_check_alignment a ON a.check_run_id = r.id
      WHERE r.run_mode = 'shadow'
      ORDER BY r.id DESC
      LIMIT ${n} OFFSET ${o}`,
  );

  const ruleRows = await queryRmaAi<{ id: number; name: string; description: string; severity: string; base_score: number }>(
    `SELECT id, name, description, severity, base_score FROM editorial_rule`
  );
  const ruleMap = new Map<number, { name: string; description: string; severity: string; base_score: number }>();
  for (const r of ruleRows) ruleMap.set(r.id, { name: r.name, description: r.description, severity: r.severity, base_score: r.base_score ?? (r.severity === 'hard' ? 1.0 : 0.5) });

  const roReasonRows = await queryRma<{ id: number; name: string }>(`SELECT id, name FROM ro_reason`);
  const roReasonMap = new Map<number, string>();
  for (const r of roReasonRows) roReasonMap.set(Number(r.id), r.name);

  const npRows = await queryRma<{ np_id: number; title: string }>(`SELECT np_id, title FROM newspaper_master`);
  const npMap = new Map<number, string>();
  for (const r of npRows) npMap.set(Number(r.np_id), r.title);

  const catRows = await queryRma<{ category_id: number; category_name: string }>(`SELECT category_id, category_name FROM new_categories`);
  const catMap = new Map<number, string>();
  for (const r of catRows) catMap.set(Number(r.category_id), r.category_name);

  const adIds = Array.from(new Set(rows.map(r => r.ad_id)));
  const adStatusMap = new Map<number, number>();
  if (adIds.length > 0) {
    const adRows = await queryRma<{ ad_id: number; status: number }>(`SELECT ad_id, status FROM ad_master WHERE ad_id IN (${adIds.join(',')})`);
    for (const r of adRows) adStatusMap.set(Number(r.ad_id), r.status);
  }

  return rows.map((r) => {
    const rawFindings = typeof r.findings === 'string' ? JSON.parse(r.findings) : (r.findings ?? []);
    const findingsArray = Array.isArray(rawFindings) ? rawFindings : [];

    const enrichedFindings = findingsArray.map((f: any) => {
      const rInfo = ruleMap.get(f.rule_id);
      const conf = typeof f.confidence === 'number' ? f.confidence : 1.0;
      const base = rInfo?.base_score ?? (f.severity === 'hard' ? 1.0 : 0.5);
      const score = typeof f.score === 'number' ? f.score : base * conf;

      return {
        ...f,
        rule_name: f.rule_name || rInfo?.name || 'Unknown Rule',
        rule_description: rInfo?.description || 'No description available',
        message: f.message || f.reasoning,
        matched_text: f.span?.text || f.matched_text,
        score
      };
    });

    const roIdsStr = r.ro_reason_ids;
    let roIdsArr: number[] = [];
    try {
      roIdsArr = typeof roIdsStr === 'string' ? JSON.parse(roIdsStr) : (roIdsStr ?? []);
    } catch {
      // ignore
    }
    const roReasonsList = Array.isArray(roIdsArr) ? roIdsArr.map((id: number) => ({ id, name: roReasonMap.get(id) || `Reason ${id}` })) : [];

    const category = typeof r.category_chosen === 'string' ? JSON.parse(r.category_chosen) : (r.category_chosen ?? {});
    let catName: string | undefined = undefined;
    const catIds = [category.top, category.sub, category.sub_sub, category.sub_sub_sub].filter(Boolean) as number[];
    if (catIds.length > 0) {
      catName = catIds.map((id) => catMap.get(id) ?? `#${id}`).join('/');
    }

    let npName: string | undefined = undefined;
    if (r.np_id != null) {
      npName = npMap.get(Number(r.np_id));
    }

    return {
      id: r.id,
      ad_id: r.ad_id,
      verdict: r.verdict,
      finding_count: findingsArray.length,
      findings: enrichedFindings,
      llm_used: Boolean(r.llm_used),
      llm_cost_paise: r.llm_cost_paise,
      created_at: r.created_at,
      alignment_outcome: r.alignment_outcome,
      ad_text_snapshot: r.ad_text_snapshot,
      ro_reasons: roReasonsList,
      category_name: catName,
      np_name: npName,
      ad_status: adStatusMap.get(r.ad_id),
    };
  });
}

export interface ShadowChunkResult {
  ok: true;
  batchId: number;
  processed_this_chunk: number;
  processed_total: number;
  target: number;
  engine_errors: number;
  no_more_ads: boolean;  // true if ad_master has no more unshadowed rows
  done: boolean;          // true if batch has reached target or no_more_ads
}
export interface ShadowChunkError {
  ok: false;
  error: string;
}

const SHADOW_CHUNK_HARD_MAX = 25;       // upper bound per server call so a single chunk never blocks the request too long
const SHADOW_DUP_FETCH_LIMIT = 5000;    // ad_ids of existing shadow runs to consider when deduping; older shadows aren't candidates anyway

export async function processShadowChunk(
  batchId: number,
  chunkSize: number,
): Promise<ShadowChunkResult | ShadowChunkError> {
  if (!Number.isFinite(batchId) || batchId <= 0) {
    return { ok: false, error: 'Invalid batch id' };
  }
  const chunk = Math.min(Math.max(Math.floor(chunkSize), 1), SHADOW_CHUNK_HARD_MAX);

  try {
    const batchRows = await queryRmaAi<ShadowBatch>(
      `SELECT ${SHADOW_BATCH_COLS} FROM shadow_batch WHERE id = ? LIMIT 1`,
      [batchId],
    );
    if (batchRows.length === 0) return { ok: false, error: `Batch #${batchId} not found` };
    const batch = batchRows[0];
    if (batch.status !== 'active') {
      return { ok: false, error: `Batch #${batchId} is ${batch.status}, not active` };
    }
    if (batch.direction !== 'backward') {
      return { ok: false, error: `Batch #${batchId} is a ${batch.direction} batch — advanced by the cron worker, not the UI.` };
    }
    const remaining = batch.target_count - batch.processed_count;
    if (remaining <= 0) {
      await executeRmaAi(
        `UPDATE shadow_batch SET status = 'completed', completed_at = NOW() WHERE id = ?`,
        [batchId],
      );
      revalidatePath('/review');
      return {
        ok: true, batchId, processed_this_chunk: 0,
        processed_total: batch.processed_count, target: batch.target_count,
        engine_errors: 0, no_more_ads: false, done: true,
      };
    }
    const want = Math.min(remaining, chunk);

    // Dedup against ads we've already shadow-run. Bounded LIMIT keeps the IN-list small;
    // older shadows won't be among the newest unshadowed candidates anyway.
    const shadowed = await queryRmaAi<{ ad_id: number }>(
      `SELECT ad_id FROM editorial_check_run
         WHERE run_mode = 'shadow'
         ORDER BY id DESC
         LIMIT ${SHADOW_DUP_FETCH_LIMIT}`,
    );
    const shadowedSet = new Set(shadowed.map((s) => s.ad_id));
    const notInClause = shadowedSet.size > 0
      ? `AND am.ad_id NOT IN (${[...shadowedSet].join(',')})`
      : '';

    const cursorFilter = batch.last_processed_ad_id ? `AND am.ad_id < ${batch.last_processed_ad_id}` : '';

    // Overshoot the LIMIT in case some of the freshest ads slipped past dedup
    // between the two queries (race) or have empty ad_text.
    const candidates = await queryRma<{
      ad_id: number; ad_text: string; category: string | null; np_id: number | null; status: number | null; earliest_publish_date: string | null; scanned_image_file_name: string | null;
    }>(
      `SELECT am.ad_id, am.ad_text, am.category, am.status, am.earliest_publish_date, av.np_id, am.scanned_image_file_name
         FROM ad_master am
         LEFT JOIN ad_value av ON av.ad_id = am.ad_id
        WHERE CHAR_LENGTH(am.ad_text) > 0
          AND am.status NOT IN (1, 5)
          AND am.ad_text NOT LIKE 'http%'
          AND am.ad_text NOT LIKE '%s3.amazonaws.com%'
          AND LOWER(TRIM(am.ad_text)) != 'pdf'
          ${cursorFilter}
          ${notInClause}
        ORDER BY am.ad_id DESC
        LIMIT ${want * 2}`,
    );

    // Defensive client-side filter for the race case.
    const fresh = candidates.filter((c) => !shadowedSet.has(c.ad_id)).slice(0, want);

    if (fresh.length === 0) {
      await executeRmaAi(
        `UPDATE shadow_batch SET status = 'completed', completed_at = NOW() WHERE id = ?`,
        [batchId],
      );
      revalidatePath('/review');
      return {
        ok: true, batchId, processed_this_chunk: 0,
        processed_total: batch.processed_count, target: batch.target_count,
        engine_errors: 0, no_more_ads: true, done: true,
      };
    }

    const rules = await loadActiveRulesForCheck();
    // Shadow runs specifically use Nvidia NIM, skip Anthropic
    const anthropic = undefined;

    let processedThisChunk = 0;
    let engineErrors = 0;
    let lowestAdId = batch.last_processed_ad_id ?? Number.MAX_SAFE_INTEGER;

    const pLimit = (await import('p-limit')).default;
    const limitLLM = pLimit(5);
    const rulesHash = (await import('../../lib/engine/cache')).getRulesHash(rules);
    const { getAdContextHash, checkCache, writeCache } = await import('../../lib/engine/cache');

    const results = await Promise.all(fresh.map(async (ad) => {
      if (ad.ad_id < lowestAdId) lowestAdId = ad.ad_id;
      const category = parseCategoryCsv(ad.category);
      const adText = ad.ad_text ?? '';
      const adTextHash = (await import('node:crypto')).createHash('sha256').update(adText).digest('hex');
      const cacheHash = getAdContextHash(adText, ad.category, ad.np_id);

      try {
        let result = await checkCache(cacheHash, rulesHash);
        if (!result) {
          result = await limitLLM(() => checkAd(
            { ad_text: adText, category_chosen: category, np_id: ad.np_id ?? undefined, ad_id: ad.ad_id, document_url: ad.scanned_image_file_name || undefined },
            { rules, anthropic, skip_categorization: true },
          ));
          await writeCache(cacheHash, rulesHash, (result as any).engine_version, result as any);
        }
        return { ad, category, adText, adTextHash, result, error: null };
      } catch (e) {
        return { ad, category, adText, adTextHash, result: null, error: e };
      }
    }));

    if (results.length > 0) {
      const runValues = results.map(r => {
        if (r.error) {
          return [r.ad.ad_id, 'shadow', r.adText, r.adTextHash, JSON.stringify(r.category), r.ad.np_id, null, null, '[]', 'pass', 0, 0, 0, 'error'];
        }
        return [
          r.ad.ad_id, 'shadow', r.adText, r.adTextHash, JSON.stringify(r.category), r.ad.np_id,
          r.result!.language_detected ?? null,
          r.result!.category_suggested ? JSON.stringify(r.result!.category_suggested) : null,
          JSON.stringify(r.result!.findings),
          r.result!.verdict, r.result!.llm_used ? 1 : 0, r.result!.llm_cost_paise, r.result!.latency_ms, r.result!.engine_version,
        ];
      });

      const placeholders = runValues.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const flatValues = runValues.flat();

      const bulkRunRes = await executeRmaAi(
        `INSERT INTO editorial_check_run
          (ad_id, run_mode, ad_text_snapshot, ad_text_hash, category_chosen, np_id, language_detected,
           category_suggested, findings, verdict, llm_used, llm_cost_paise, latency_ms, engine_version)
         VALUES ${placeholders}`,
        flatValues
      );

      let firstInsertId = bulkRunRes.insertId;
      const alignmentValues = [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const currentRunId = firstInsertId + i;
        const stat = Number(r.ad.status);
        const isEligibleStat = stat === 5 || stat === 11 || (r.ad.earliest_publish_date ? new Date(r.ad.earliest_publish_date).getTime() < Date.now() : false);
        const computeImmediately = isEligibleStat && stat !== 12;

        if (r.error) {
          engineErrors++;
          processedThisChunk++;
          console.error(`[shadow] ad ${r.ad.ad_id} engine error:`, r.error instanceof Error ? r.error.message : r.error);
          alignmentValues.push([currentRunId, r.ad.ad_id, '[]', '[]', '[]', '[]', '[]', 'PENDING_RO_REVIEW']);
        } else if (computeImmediately) {
          const tickets = await queryRma<{ reason_id: number }>(
            `SELECT DISTINCT CAST(reason AS UNSIGNED) AS reason_id
               FROM forum_report_email_master
              WHERE ad_id = ?
                AND generated_by = '6'
                AND reason REGEXP '^[0-9]+$'`,
            [r.ad.ad_id],
          );
          const roReasonIds = tickets.map((t) => Number(t.reason_id)).filter((n) => Number.isFinite(n));
          const ruleById = new Map<number, Rule>(rules.map((rule) => [rule.id, rule]));
          const alignment = computeAlignment(
            { ad_id: r.ad.ad_id, our_findings: r.result!.findings, ro_reason_ids: roReasonIds, eligible: true },
            ruleById,
          );
          alignmentValues.push([
            currentRunId, r.ad.ad_id,
            JSON.stringify(alignment.our_rule_ids), JSON.stringify(alignment.ro_reason_ids),
            JSON.stringify(alignment.flag_overlap), JSON.stringify(alignment.we_extra),
            JSON.stringify(alignment.ro_extra), alignment.outcome
          ]);
          processedThisChunk++;
        } else {
          const ruleIds = Array.isArray(r.result!.findings)
            ? r.result!.findings.map((f: any) => f.rule_id).filter((id: any) => typeof id === 'number' && id > 0)
            : [];
          alignmentValues.push([
            currentRunId, r.ad.ad_id, JSON.stringify(ruleIds), '[]', '[]', '[]', '[]', 'PENDING_RO_REVIEW'
          ]);
          processedThisChunk++;
        }
      }

      if (alignmentValues.length > 0) {
        const alignPlaceholders = alignmentValues.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, NULL, NOW())').join(', ');
        const flatAlign = alignmentValues.flat();
        await executeRmaAi(
          `INSERT INTO editorial_check_alignment
            (check_run_id, ad_id, our_rule_ids, ro_reason_ids, flag_overlap, we_extra, ro_extra, outcome, eligible_at, computed_at)
           VALUES ${alignPlaceholders}`,
          flatAlign
        );
      }

      // Automatically raise tickets for ads blocked during this shadow run
      const blockedAds = results.filter(r => !r.error && r.result?.verdict === 'block');
      if (blockedAds.length > 0) {
        await Promise.allSettled(blockedAds.map(r => raiseCustomerCareTicket(r.ad.ad_id)));
      }
    }

    const newProcessed = batch.processed_count + processedThisChunk;
    const done = newProcessed >= batch.target_count;
    await executeRmaAi(
      `UPDATE shadow_batch
          SET processed_count = ?,
              last_processed_ad_id = ?,
              status = ${done ? `'completed'` : `'active'`},
              completed_at = ${done ? 'NOW()' : 'completed_at'}
        WHERE id = ?`,
      [newProcessed, lowestAdId === Number.MAX_SAFE_INTEGER ? null : lowestAdId, batchId],
    );

    revalidatePath('/review');
    return {
      ok: true,
      batchId,
      processed_this_chunk: processedThisChunk,
      processed_total: newProcessed,
      target: batch.target_count,
      engine_errors: engineErrors,
      no_more_ads: false,
      done,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Lifecycle of an editorial_check_alignment row for a shadow run:
//
//   1. Shadow run inserted into editorial_check_run (run_mode='shadow').
//   2. IMMEDIATELY: a placeholder alignment row is inserted with
//      outcome='PENDING_RO_REVIEW' so the run is visible in /review right
//      away (don't make the team wait 48h to see what just ran).
//   3. Once the run crosses SHADOW_ALIGNMENT_WAIT_HOURS, runShadowAlignmentPass
//      queries forum_report_email_master.generated_by='6' for any RO tickets
//      on the ad, recomputes the real outcome, and UPDATES the alignment row
//      in place.
//
// Step 1+2 happen synchronously inside processShadowChunk (backward batches)
// and the shadow_worker.ts cron (forward batches). Step 3 runs lazily before
// /review renders, capped per call so it doesn't slow the page.

const SHADOW_ALIGNMENT_WAIT_HOURS = 48;
const SHADOW_ALIGNMENT_MAX_AGE_DAYS = 14;
const SHADOW_BACKFILL_PER_CALL = 100;
const SHADOW_REFRESH_PER_CALL = 50;

// Compute what the alignment would look like if RO hasn't ticketed yet — just
// our findings, no overlap. Outcome is forced to PENDING_RO_REVIEW.
function buildPendingAlignmentFields(findings: Array<{ rule_id: number }>) {
  const ruleIds = (Array.isArray(findings) ? findings : [])
    .map((f) => f.rule_id)
    .filter((id) => typeof id === 'number' && id > 0);
  return {
    our_rule_ids: JSON.stringify(ruleIds),
    ro_reason_ids: JSON.stringify([]),
    flag_overlap: JSON.stringify([]),
    we_extra: JSON.stringify([]),
    ro_extra: JSON.stringify([]),
  };
}

export async function insertPendingShadowAlignment(
  checkRunId: number,
  adId: number,
  findings: Array<{ rule_id: number }>,
): Promise<void> {
  const f = buildPendingAlignmentFields(findings);
  await executeRmaAi(
    `INSERT INTO editorial_check_alignment
      (check_run_id, ad_id, our_rule_ids, ro_reason_ids, flag_overlap, we_extra, ro_extra, outcome, eligible_at, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_RO_REVIEW', NULL, NOW())`,
    [checkRunId, adId, f.our_rule_ids, f.ro_reason_ids, f.flag_overlap, f.we_extra, f.ro_extra],
  );
}

export async function runShadowAlignmentPass(): Promise<{ backfilled: number; refreshed: number }> {
  let backfilled = 0;
  let refreshed = 0;

  try {
    // === Pass A: backfill placeholders for any shadow run without an alignment row.
    // Catches the existing orphaned rows that were inserted before this fix
    // shipped, and is a safety net if a future code path forgets to insert one.
    const orphaned = await queryRmaAi<{ id: number; ad_id: number; findings: unknown }>(
      `SELECT r.id, r.ad_id, r.findings
         FROM editorial_check_run r
         LEFT JOIN editorial_check_alignment a ON a.check_run_id = r.id
        WHERE r.run_mode = 'shadow'
          AND a.id IS NULL
        ORDER BY r.id DESC
        LIMIT ${SHADOW_BACKFILL_PER_CALL}`,
    );
    for (const r of orphaned) {
      const findings = typeof r.findings === 'string' ? JSON.parse(r.findings) : (r.findings ?? []);
      await insertPendingShadowAlignment(r.id, r.ad_id, findings);
      backfilled++;
    }

    // === Pass B: refresh placeholders that have aged past the 48h wait.
    // Re-query RO tickets and recompute the real outcome in place.
    const ripe = await queryRmaAi<{
      alignment_id: number; check_run_id: number; ad_id: number; findings: unknown;
    }>(
      `SELECT a.id AS alignment_id, a.check_run_id, a.ad_id, r.findings
         FROM editorial_check_alignment a
         JOIN editorial_check_run r ON r.id = a.check_run_id
         JOIN rma.ad_master am ON am.ad_id = a.ad_id
        WHERE r.run_mode = 'shadow'
          AND a.outcome = 'PENDING_RO_REVIEW'
          AND (
            (am.status IN (4,5,11) AND am.status != 12)
            OR (am.earliest_publish_date IS NOT NULL AND am.earliest_publish_date < NOW() AND am.status != 12)
            OR r.created_at <= NOW() - INTERVAL ${SHADOW_ALIGNMENT_WAIT_HOURS} HOUR
          )
          AND r.created_at >= NOW() - INTERVAL ${SHADOW_ALIGNMENT_MAX_AGE_DAYS} DAY
        ORDER BY r.created_at ASC
        LIMIT ${SHADOW_REFRESH_PER_CALL}`,
    );
    if (ripe.length > 0) {
      const rules = await loadActiveRulesForCheck();
      const ruleById = new Map<number, Rule>(rules.map((r) => [r.id, r]));

      for (const row of ripe) {
        const findings = typeof row.findings === 'string' ? JSON.parse(row.findings) : (row.findings ?? []);
        const tickets = await queryRma<{ reason_id: number }>(
          `SELECT DISTINCT CAST(reason AS UNSIGNED) AS reason_id
             FROM forum_report_email_master
            WHERE ad_id = ?
              AND generated_by = '6'
              AND reason REGEXP '^[0-9]+$'`,
          [row.ad_id],
        );
        const roReasonIds = tickets.map((t) => Number(t.reason_id)).filter((n) => Number.isFinite(n));
        const alignment = computeAlignment(
          { ad_id: row.ad_id, our_findings: findings, ro_reason_ids: roReasonIds, eligible: true },
          ruleById,
        );
        await executeRmaAi(
          `UPDATE editorial_check_alignment
              SET our_rule_ids = ?, ro_reason_ids = ?, flag_overlap = ?, we_extra = ?, ro_extra = ?,
                  outcome = ?, eligible_at = NOW(), computed_at = NOW()
            WHERE id = ?`,
          [
            JSON.stringify(alignment.our_rule_ids),
            JSON.stringify(alignment.ro_reason_ids),
            JSON.stringify(alignment.flag_overlap),
            JSON.stringify(alignment.we_extra),
            JSON.stringify(alignment.ro_extra),
            alignment.outcome,
            row.alignment_id,
          ],
        );
        refreshed++;
      }
    }
    return { backfilled, refreshed };
  } catch (e) {
    console.error('[shadow] alignment pass error:', e instanceof Error ? e.message : e);
    return { backfilled, refreshed };
  }
}

export interface ProcessedAdSummary {
  adId: number;
  verdict: string;
  outcome: string;
  adText: string;
  roFlags: string[];
  findings?: {
    rule_id: number;
    rule_name: string;
    severity: string;
    message: string;
    target_ro_reasons: string[];
  }[];
}

export async function runBatchBacktest(limit: number, skipRevalidate?: boolean): Promise<{ ok: boolean; processed: number; processedAds?: ProcessedAdSummary[]; error?: string }> {
  const batchLimit = Math.min(Math.max(limit, 1), 500);

  try {
    const backtested = await queryRmaAi<{ ad_id: number }>(
      `SELECT ad_id FROM editorial_check_run WHERE run_mode = 'backtest'`
    );
    const backtestedSet = new Set(backtested.map((r) => r.ad_id));
    const notInClause = backtestedSet.size > 0
      ? `AND am.ad_id NOT IN (${[...backtestedSet].join(',')})`
      : '';

    // Fetch ads from the main ad_master pool that have RO tickets
    const candidates = await queryRma<{
      ad_id: number; ad_text: string; category_csv: string; np_id: number | null; ro_reason_ids: string;
    }>(
      `SELECT
         am.ad_id,
         am.ad_text,
         am.category AS category_csv,
         av.np_id,
         GROUP_CONCAT(DISTINCT CAST(frem.reason AS UNSIGNED) ORDER BY frem.reason) AS ro_reason_ids
       FROM ad_master am
       JOIN forum_report_email_master frem ON frem.ad_id = am.ad_id
       LEFT JOIN ad_value av ON av.ad_id = am.ad_id
       WHERE frem.reason REGEXP '^[0-9]+$'
         AND CHAR_LENGTH(am.ad_text) > 20
         ${notInClause}
       GROUP BY am.ad_id, am.ad_text, am.category, av.np_id
       ORDER BY am.ad_id DESC
       LIMIT ${batchLimit * 2}`
    );

    const fresh = candidates.filter((c) => !backtestedSet.has(c.ad_id)).slice(0, batchLimit);
    if (fresh.length === 0) {
      return { ok: true, processed: 0, processedAds: [] };
    }

    const rules = await loadActiveRulesForCheck();
    const ruleById = new Map<number, Rule>(rules.map((r) => [r.id, r]));
    const anthropic = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : undefined;

    const allRoReasons = await fetchRoReasons();
    const roReasonNames = new Map<number, string>(allRoReasons.map(r => [r.id, r.name]));

    let processedThisChunk = 0;
    const processedAds: ProcessedAdSummary[] = [];

    const promises = fresh.map(async (ad) => {
      const category = parseCategoryCsv(ad.category_csv);

      // Attempt to get pre-edit snapshot for a true backtest
      const preEditRows = await queryRma<{ ad_text: string }>(
        `SELECT ad_text FROM ad_master_update WHERE ad_id = ? AND CHAR_LENGTH(ad_text) > 20 ORDER BY added_on ASC LIMIT 1`,
        [ad.ad_id],
      );
      const adText = preEditRows.length > 0 ? preEditRows[0].ad_text : (ad.ad_text ?? '');

      const adTextHash = (await import('node:crypto')).createHash('sha256').update(adText).digest('hex');
      const roReasonIds = ad.ro_reason_ids ? ad.ro_reason_ids.split(',').map((s) => Number(s.trim())) : [];

      try {
        const result = await checkAd(
          { ad_text: adText, category_chosen: category, np_id: ad.np_id ?? undefined, ad_id: ad.ad_id },
          { rules, anthropic, skip_categorization: true },
        );

        const runInsert = await executeRmaAi(
          `INSERT INTO editorial_check_run
            (ad_id, run_mode, ad_text_snapshot, ad_text_hash, category_chosen, np_id, language_detected,
             category_suggested, findings, verdict, llm_used, llm_cost_paise, latency_ms, engine_version)
           VALUES (?, 'backtest', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ad.ad_id, adText, adTextHash, JSON.stringify(category), ad.np_id,
            result.language_detected ?? null,
            result.category_suggested ? JSON.stringify(result.category_suggested) : null,
            JSON.stringify(result.findings),
            result.verdict, result.llm_used ? 1 : 0, result.llm_cost_paise, result.latency_ms, result.engine_version,
          ],
        );

        const alignment = computeAlignment(
          { ad_id: ad.ad_id, our_findings: result.findings, ro_reason_ids: roReasonIds, eligible: true },
          ruleById,
        );

        await executeRmaAi(
          `INSERT INTO editorial_check_alignment
            (check_run_id, ad_id, our_rule_ids, ro_reason_ids, flag_overlap, we_extra, ro_extra, outcome, eligible_at, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            runInsert.insertId, ad.ad_id,
            JSON.stringify(alignment.our_rule_ids),
            JSON.stringify(alignment.ro_reason_ids),
            JSON.stringify(alignment.flag_overlap),
            JSON.stringify(alignment.we_extra),
            JSON.stringify(alignment.ro_extra),
            alignment.outcome,
          ],
        );

        const formattedRoFlags = roReasonIds.map(id => `#${id} - ${roReasonNames.get(id) ?? 'Unknown'}`);
        const formattedFindings = result.findings.map(f => {
          const rule = ruleById.get(f.rule_id);
          const targetIds = rule?.target_ro_reason || [];
          const targetStrings = targetIds.map(id => `#${id} - ${roReasonNames.get(id) ?? 'Unknown'}`);
          return {
            ...f,
            target_ro_reasons: targetStrings
          };
        });

        return {
          adId: ad.ad_id,
          verdict: result.verdict,
          outcome: alignment.outcome,
          adText: adText,
          roFlags: formattedRoFlags,
          findings: formattedFindings as any,
        };
      } catch (e) {
        console.error(`[backtest] ad ${ad.ad_id} engine error:`, e instanceof Error ? e.message : e);
        return null;
      }
    });

    const results = await Promise.all(promises);
    for (const res of results) {
      if (res) {
        processedThisChunk++;
        processedAds.push(res);
      }
    }

    if (!skipRevalidate) {
      revalidatePath('/review');
      revalidatePath('/dashboard');
    }
    return { ok: true, processed: processedThisChunk, processedAds };
  } catch (e) {
    return { ok: false, processed: 0, processedAds: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runAndSaveShadowCheck(checkRunId: number, adId: number): Promise<OnDemandCheckResult | OnDemandCheckError> {
  const res = await runOnDemandCheck(adId, true);
  if (!res.ok) return res;

  try {
    await executeRmaAi(
      `UPDATE editorial_check_run SET findings=?, verdict=?, llm_used=?, llm_cost_paise=?, latency_ms=? WHERE id=?`,
      [JSON.stringify(res.findings), res.verdict, res.llm_used ? 1 : 0, res.llm_cost_paise, res.latency_ms, checkRunId]
    );

    const alignment = res.alignment;
    await executeRmaAi(
      `UPDATE editorial_check_alignment SET our_rule_ids=?, ro_reason_ids=?, flag_overlap=?, we_extra=?, ro_extra=?, outcome=?, computed_at=NOW() WHERE check_run_id=?`,
      [
        JSON.stringify(alignment.our_rule_ids),
        JSON.stringify(alignment.ro_reason_ids),
        JSON.stringify(alignment.flag_overlap),
        JSON.stringify(alignment.we_extra),
        JSON.stringify(alignment.ro_extra),
        alignment.outcome,
        checkRunId
      ]
    );

    revalidatePath('/review');
    revalidatePath('/dashboard');
    return res;
  } catch (e: any) {
    return { ok: false, error: 'DB Update Failed: ' + (e.message || String(e)) };
  }
}


export async function raiseCustomerCareTicket(adId: number) {
  try {
    // 1. Fetch the editorial check run for the given ad
    const runs = await queryRmaAi<{ findings: string, verdict: string }>(
      `SELECT findings, verdict FROM editorial_check_run WHERE ad_id = ? AND run_mode = 'shadow' ORDER BY id DESC LIMIT 1`,
      [adId]
    );

    if (runs.length === 0) {
      return { ok: false, error: 'No shadow run found for this ad.' };
    }

    if (runs[0].verdict !== 'block') {
      return { ok: false, error: 'Ad is not blocked. Cannot raise a ticket.' };
    }

    let findings: Finding[] = [];
    if (typeof runs[0].findings === 'string') {
      findings = JSON.parse(runs[0].findings || '[]');
    } else if (Array.isArray(runs[0].findings)) {
      findings = runs[0].findings;
    }
    if (!findings || findings.length === 0) {
      return { ok: false, error: 'No block findings available.' };
    }

    // 2. Load active rules to map the rule_id to target_ro_reason
    const rules = await queryRmaAi<Rule>(`SELECT * FROM editorial_rule WHERE status = 'active'`);
    const ruleById = new Map(rules.map(r => [r.id, r]));

    // 3. Fetch user email and category from ad_master and np_id from ad_value
    const adData = await queryRma<{ email: string, category: string, status: string | number }>(
      `SELECT created_by as email, category, status FROM ad_master WHERE ad_id = ?`,
      [adId]
    );

    if (adData.length > 0) {
      const statusStr = String(adData[0].status);
      if (statusStr === '1') {
        return { ok: false, error: 'Cannot raise ticket for ad with Payment Due status.' };
      }
      if (statusStr === '4') {
        return { ok: false, error: 'Cannot raise ticket for Confirmed For Release ads.' };
      }
    }


    const email = adData.length > 0 ? adData[0].email : '';
    const categoryStr = adData.length > 0 ? adData[0].category : '';
    const catIdStr = categoryStr.split(',')[0];
    const categoryId = parseInt(catIdStr, 10) || 0;

    const adValueData = await queryRma<{ np_id: number }>(
      `SELECT np_id FROM ad_value WHERE ad_id = ? LIMIT 1`,
      [adId]
    );
    const npId = adValueData.length > 0 ? adValueData[0].np_id : 0;

    // Fetch names for string replacement in explanation
    let catName = String(categoryId);
    if (categoryId) {
      const catRow = await queryRma<{ category_name: string }>(`SELECT category_name FROM new_categories WHERE category_id = ?`, [categoryId]);
      if (catRow.length > 0) catName = catRow[0].category_name;
    }

    let npName = String(npId);
    if (npId) {
      const npRow = await queryRma<{ title: string }>(`SELECT title FROM newspaper_master WHERE np_id = ?`, [npId]);
      if (npRow.length > 0) npName = npRow[0].title;
    }

    // Deduplication check: if an OPEN ticket (status = '1') by the AI already exists for this ad, don't create a duplicate.
    const existingTicket = await queryRma<{ id: number }>(
      `SELECT id FROM forum_report_email_master WHERE ad_id = ? AND generated_by = '6' AND status = '1' LIMIT 1`,
      [adId]
    );
    if (existingTicket.length > 0) {
      return { ok: true, reportRoId: existingTicket[0].id, skipped: true, message: 'Open ticket already exists' };
    }

    const targetRoReasons = new Set<number>();
    let explanation = 'Blocked by Editorial Checker. Rules fired:\n';

    const totalScore = findings.reduce((acc, f) => {
      if (typeof f.score === 'number') {
        return acc + f.score;
      }
      const r = ruleById.get(f.rule_id);
      const conf = typeof f.confidence === 'number' ? f.confidence : 1.0;
      const base = r?.base_score ?? (f.severity === 'hard' ? 1.0 : 0.5);
      return acc + (base * conf);
    }, 0);

    const hasHardRule = findings.some(f => f.severity === 'hard');

    // Do not raise a ticket at all if there are no hard rules and score is less than 1.0
    if (!hasHardRule && totalScore < 1.0) {
      return { ok: false, error: 'All rules fired are soft and total score is less than 1.0. Not raising a ticket.' };
    }

    for (const f of findings) {
      const r = ruleById.get(f.rule_id);
      let message = f.message || '';
      if (categoryId) message = message.replace(new RegExp(`category ${categoryId}`, 'g'), `category "${catName}"`);
      if (npId) message = message.replace(new RegExp(`newspaper ${npId}`, 'g'), `newspaper "${npName}"`);

      if (r) {
        explanation += `- ${r.name}: ${message}\n`;
        if (r.target_ro_reason && Array.isArray(r.target_ro_reason)) {
          r.target_ro_reason.forEach(tr => targetRoReasons.add(tr));
        }
      } else {
        explanation += `- ${f.rule_name || 'Rule ' + f.rule_id}: ${message}\n`;
      }
    }

    // If no specific RO reason is mapped, fallback to a default reason (e.g. 4 for Incorrect Categorization)
    const reasonArr = Array.from(targetRoReasons);
    let singleReason = 4;
    if (reasonArr.includes(11)) {
      singleReason = 11; // Newspaper Does Not Accept
    } else if (reasonArr.length > 0) {
      singleReason = reasonArr[0];
    }

    // 4. Insert into forum_report_email_master (assing_to = 289 is Krishanu Debnath)
    const masterRes = await executeRmaWrite(
      `INSERT INTO forum_report_email_master
       (email, phone, ad_id, np_id, reason, priority, assign_by, assing_to, fixed_by, status, reporting_time, generated_by, report_in_time)
       VALUES (?, '', ?, ?, ?, '11', 6, 289, 0, '1', NOW(), '6', 1)`,
      [email, adId, npId, singleReason]
    );

    const reportRoId = masterRes.insertId;

    // 5. Insert into forum_report_email
    await executeRmaWrite(
      `INSERT INTO forum_report_email
       (report_ro_id, admin_id, name, subject, email, email_html, email_from, email_signature, attachment, type, date)
       VALUES (?, 6, 'Editorial AI', 'Editorial Check Block', ?, '', 'ai@releasemyad.com', '', '', 'reply', NOW())`,
      [reportRoId, explanation]
    );

    return { ok: true, reportRoId };
  } catch (e: any) {
    console.error('Error raising ticket:', e);
    return { ok: false, error: e.message || String(e) };
  }
}
