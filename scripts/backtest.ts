#!/usr/bin/env tsx
/**
 * Backtest harness — Phase A milestone.
 *
 * For ~1,528 ads where we have a pre-edit text snapshot (ad_master_update) AND a
 * matched editorial ticket (forum_report_email_master), run the engine on the
 * pre-edit text and compare what we flag against what RO flagged.
 *
 * Writes results to:
 *   rma_ai.editorial_check_run  (one row per ad, mode='backtest')
 *   rma_ai.editorial_check_alignment (one row per ad, with outcome)
 *
 * Then prints a recall/precision summary by ro_reason and overall outcome buckets.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npm run backtest -- [--limit N] [--no-llm] [--reset]
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { queryRma } from '../src/lib/db/rma';
import { queryRmaAi, executeRmaAi } from '../src/lib/db/rmaAi';
import { checkAd } from '../src/lib/engine';
import type { Rule, CategoryChoice } from '../src/lib/engine/types';
import { computeAlignment, type AlignmentOutcome } from '../src/lib/alignment/compute';
import crypto from 'node:crypto';

const EDITORIAL_REASONS = [1, 2, 4, 10, 11, 12, 13, 18, 109, 137, 150, 207];

interface BacktestRow {
  ad_id: number;
  pre_edit_text: string;
  current_text: string;
  category_csv: string;
  np_id: number | null;
  ro_reason_ids: number[];
  ops_notes: string[];
  ticket_count: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    limit: args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : undefined,
    noLlm: args.includes('--no-llm'),
    reset: args.includes('--reset'),
  };
}

function parseCategory(csv: string): CategoryChoice {
  const parts = csv.split(',').map((s) => s.trim());
  const toNum = (s: string | undefined): number | undefined => {
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    top: toNum(parts[0]),
    sub: toNum(parts[1]),
    sub_sub: toNum(parts[2]),
    sub_sub_sub: toNum(parts[3]),
  };
}

async function loadBacktestData(limit: number | undefined): Promise<BacktestRow[]> {
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const rows = await queryRma<{
    ad_id: number; pre_edit_text: string; current_text: string;
    category_csv: string; np_id: number | null; ro_reason_ids: string; ops_notes: string;
  }>(`
    SELECT
      amu.ad_id,
      amu.ad_text AS pre_edit_text,
      am.ad_text AS current_text,
      am.category AS category_csv,
      av.np_id,
      GROUP_CONCAT(DISTINCT CAST(frem.reason AS UNSIGNED) ORDER BY frem.reason) AS ro_reason_ids,
      GROUP_CONCAT(DISTINCT
        SUBSTRING(COALESCE((
          SELECT email FROM forum_report_email
           WHERE report_ro_id = frem.id AND type='note' AND email != ''
           ORDER BY date LIMIT 1
        ), ''), 1, 300)
        SEPARATOR ' ||| '
      ) AS ops_notes
    FROM ad_master_update amu
    JOIN ad_master am ON am.ad_id = amu.ad_id
    JOIN forum_report_email_master frem ON frem.ad_id = amu.ad_id
    LEFT JOIN ad_value av ON av.ad_id = amu.ad_id
    WHERE frem.generated_by = '6'
      AND frem.reason REGEXP '^[0-9]+$'
      AND CAST(frem.reason AS UNSIGNED) IN (${EDITORIAL_REASONS.join(',')})
      AND CHAR_LENGTH(amu.ad_text) > 20
    GROUP BY amu.ad_id, amu.ad_text, am.ad_text, am.category, av.np_id
    ORDER BY amu.added_on DESC
    ${limitClause}
  `);
  return rows.map((r) => ({
    ad_id: r.ad_id,
    pre_edit_text: r.pre_edit_text,
    current_text: r.current_text,
    category_csv: r.category_csv,
    np_id: r.np_id,
    ro_reason_ids: r.ro_reason_ids ? r.ro_reason_ids.split(',').map((s) => Number(s.trim())) : [],
    ops_notes: r.ops_notes ? r.ops_notes.split(' ||| ').filter(Boolean) : [],
    ticket_count: r.ro_reason_ids ? r.ro_reason_ids.split(',').length : 0,
  }));
}

async function loadActiveRules(): Promise<Rule[]> {
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
    base_score: r.base_score,
    status: r.status
  }));
}

async function resetBacktestData() {
  console.log('Clearing previous backtest results…');
  await executeRmaAi(`DELETE FROM editorial_check_alignment WHERE check_run_id IN (SELECT id FROM editorial_check_run WHERE run_mode='backtest')`);
  await executeRmaAi(`DELETE FROM editorial_check_run WHERE run_mode='backtest'`);
}

async function main() {
  const { limit, noLlm, reset } = parseArgs();

  if (reset) await resetBacktestData();

  const rules = await loadActiveRules();
  console.log(`Loaded ${rules.length} active rule(s) from rma_ai.editorial_rule`);
  if (rules.length === 0) {
    console.log('⚠  No active rules. Did you run extract_starter_rules.py and approve proposals?');
    console.log('   Proceeding anyway — all ads will get verdict=pass (useful for engine smoke-test).');
  }
  const ruleById = new Map<number, Rule>(rules.map((r) => [r.id, r]));

  const data = await loadBacktestData(limit);
  console.log(`Loaded ${data.length} backtest ads (pre-edit text + RO tickets)`);

  const anthropic = noLlm ? undefined : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!anthropic) console.log('LLM passes DISABLED (--no-llm). Pass-1 only.');

  const bucketCounts: Record<AlignmentOutcome, number> = {
    FULL_MATCH: 0, PARTIAL_OVERLAP: 0, NO_OVERLAP_BOTH_FLAGGED: 0,
    WE_ONLY: 0, RO_ONLY: 0, BOTH_CLEAN: 0,
    PENDING_RO_REVIEW: 0, DATA_QUALITY: 0, NON_EDITORIAL_RO_FLAG: 0,
  };
  let totalLlmCost = 0;
  let totalLatency = 0;

  const CONCURRENCY = 20;
  for (let i = 0; i < data.length; i += CONCURRENCY) {
    const chunk = data.slice(i, i + CONCURRENCY);
    
    await Promise.all(chunk.map(async (row, index) => {
      const globalIndex = i + index;
      const category = parseCategory(row.category_csv);
      const adTextHash = crypto.createHash('sha256').update(row.pre_edit_text).digest('hex');

      let result;
      try {
        result = await checkAd(
          { ad_text: row.pre_edit_text, category_chosen: category, np_id: row.np_id ?? undefined, ad_id: row.ad_id },
          { rules, anthropic, skip_categorization: true /* pass2 needs candidate list; deferred */ },
        );
      } catch (e) {
        console.error(`  [${globalIndex + 1}/${data.length}] ad ${row.ad_id} — engine error:`, e);
        return;
      }

      totalLlmCost += result.llm_cost_paise;
      totalLatency += result.latency_ms;

      const checkRunInsert = await executeRmaAi(
        `INSERT INTO editorial_check_run
          (ad_id, run_mode, ad_text_snapshot, ad_text_hash, category_chosen, np_id, language_detected,
           category_suggested, findings, verdict, llm_used, llm_cost_paise, latency_ms, engine_version)
         VALUES (?, 'backtest', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.ad_id, row.pre_edit_text, adTextHash, JSON.stringify(category), row.np_id,
          result.language_detected ?? null,
          result.category_suggested ? JSON.stringify(result.category_suggested) : null,
          JSON.stringify(result.findings),
          result.verdict, result.llm_used ? 1 : 0, result.llm_cost_paise, result.latency_ms, result.engine_version,
        ],
      );
      const checkRunId = checkRunInsert.insertId;

      // For backtest, every ad is by definition past — eligible.
      const alignment = computeAlignment(
        { ad_id: row.ad_id, our_findings: result.findings, ro_reason_ids: row.ro_reason_ids, eligible: true },
        ruleById,
      );
      bucketCounts[alignment.outcome]++;

      await executeRmaAi(
        `INSERT INTO editorial_check_alignment
          (check_run_id, ad_id, our_rule_ids, ro_reason_ids, flag_overlap, we_extra, ro_extra, outcome, eligible_at, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          checkRunId, row.ad_id,
          JSON.stringify(alignment.our_rule_ids),
          JSON.stringify(alignment.ro_reason_ids),
          JSON.stringify(alignment.flag_overlap),
          JSON.stringify(alignment.we_extra),
          JSON.stringify(alignment.ro_extra),
          alignment.outcome,
        ],
      );
    }));

    const processedCount = Math.min(i + CONCURRENCY, data.length);
    const pct = ((processedCount / data.length) * 100).toFixed(1);
    console.log(`  [${processedCount}/${data.length} ${pct}%] outcome so far: ${JSON.stringify(bucketCounts)}`);
  }

  // === Report ===
  console.log('\n=== Backtest Summary ===');
  console.log(`Total ads: ${data.length}`);
  console.log(`Active rules: ${rules.length}`);
  console.log(`LLM total cost: ₹${(totalLlmCost / 100).toFixed(2)}`);
  console.log(`Avg latency: ${data.length ? Math.round(totalLatency / data.length) : 0}ms`);
  console.log('\nOutcome buckets:');
  const total = data.length || 1;
  for (const [bucket, n] of Object.entries(bucketCounts)) {
    const pct = ((n / total) * 100).toFixed(1);
    console.log(`  ${bucket.padEnd(28)} ${String(n).padStart(5)}  ${pct}%`);
  }
  const matched = bucketCounts.FULL_MATCH + bucketCounts.BOTH_CLEAN;
  const eligible = total - bucketCounts.PENDING_RO_REVIEW - bucketCounts.DATA_QUALITY;
  const strict = eligible ? ((matched / eligible) * 100).toFixed(1) : 'n/a';
  const partial = eligible ? (((matched + 0.5 * bucketCounts.PARTIAL_OVERLAP) / eligible) * 100).toFixed(1) : 'n/a';
  console.log(`\nStrict alignment rate:  ${strict}%`);
  console.log(`Partial-credit rate:    ${partial}%`);
  console.log('\nPer-reason recall (RO_ONLY rows show what we missed):');
  // Aggregate ro_reason occurrences by outcome
  const reasonStats = new Map<number, { caught: number; missed: number }>();
  for (const row of data) {
    for (const rid of row.ro_reason_ids) {
      if (!reasonStats.has(rid)) reasonStats.set(rid, { caught: 0, missed: 0 });
    }
  }
  // Re-query to count caught vs missed per reason — simpler: count rows per outcome where reason was present.
  const recallRows = await queryRmaAi<{ ro_reason: number; total: number; caught: number }>(
    `SELECT
       JSON_EXTRACT(ro_reason_ids, '$[0]') AS ro_reason,
       COUNT(*) AS total,
       SUM(CASE WHEN outcome IN ('FULL_MATCH','PARTIAL_OVERLAP') THEN 1 ELSE 0 END) AS caught
     FROM editorial_check_alignment
     WHERE check_run_id IN (SELECT id FROM editorial_check_run WHERE run_mode='backtest')
       AND JSON_LENGTH(ro_reason_ids) = 1
     GROUP BY ro_reason
     ORDER BY total DESC`,
  );
  for (const r of recallRows) {
    const recall = r.total ? ((r.caught / r.total) * 100).toFixed(1) : 'n/a';
    console.log(`  reason ${String(r.ro_reason).padStart(4)}: ${r.caught}/${r.total} = ${recall}%`);
  }

  console.log('\nDone. Inspect details:');
  console.log(`  SELECT * FROM rma_ai.editorial_check_alignment WHERE outcome='RO_ONLY' LIMIT 10;`);
  console.log(`  SELECT * FROM rma_ai.editorial_check_run WHERE run_mode='backtest' ORDER BY id DESC LIMIT 10;`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
