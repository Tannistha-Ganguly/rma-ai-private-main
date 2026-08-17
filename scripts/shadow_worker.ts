#!/usr/bin/env tsx
/**
 * Shadow worker — single tick, forward-mode only.
 *
 * Invoked by PM2 cron (see ecosystem.config.js: app "rma-ai-shadow-cron",
 * cron_restart "*\/5 * * * *", autorestart:false).
 *
 * Each invocation:
 *   1. Find the active 'forward' shadow_batch (else exit).
 *   2. Pull ad_master rows with ad_id > (last_processed_ad_id ?? start_ad_id),
 *      ascending, up to (target - processed). Cap per tick so a high-volume
 *      backlog doesn't burn the whole 5-min window.
 *   3. For each ad: run checkAd → insert editorial_check_run (shadow) →
 *      insert placeholder editorial_check_alignment (PENDING_RO_REVIEW).
 *   4. Advance the watermark + processed counter; mark completed when target hit.
 *
 * Backward batches are NOT processed here — they're advanced from the UI by
 * processShadowChunk. The alignment-refresh pass (48h-old placeholders →
 * real outcomes) runs lazily on /review page load, not here.
 *
 * Usage (manual): set -a; source .env.local; set +a; npx tsx scripts/shadow_worker.ts
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { queryRma } from '../src/lib/db/rma';
import { queryRmaAi, executeRmaAi } from '../src/lib/db/rmaAi';
import { checkAd } from '../src/lib/engine';
import { computeAlignment } from '../src/lib/alignment/compute';
import type { Rule, CategoryChoice } from '../src/lib/engine/types';
import crypto from 'node:crypto';

const PER_TICK_CAP = 20; // upper bound per cron invocation

interface ActiveForwardBatch {
  id: number;
  target_count: number;
  processed_count: number;
  start_ad_id: number;
  last_processed_ad_id: number | null;
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
    status: r.status,
  }));
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`shadow_worker tick @ ${startedAt}`);

  const batchRows = await queryRmaAi<ActiveForwardBatch>(
    `SELECT id, target_count, processed_count, start_ad_id, last_processed_ad_id
       FROM shadow_batch
      WHERE status = 'active' AND direction = 'forward'
      ORDER BY id ASC
      LIMIT 1`,
  );
  if (batchRows.length === 0) {
    console.log('no active forward batch — nothing to do');
    process.exit(0);
  }
  const batch = batchRows[0];
  const remaining = batch.target_count - batch.processed_count;
  if (remaining <= 0) {
    await executeRmaAi(
      `UPDATE shadow_batch SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [batch.id],
    );
    console.log(`batch #${batch.id} already at target — marked completed`);
    process.exit(0);
  }

  const watermark = batch.last_processed_ad_id ?? batch.start_ad_id;
  const limit = Math.min(remaining, PER_TICK_CAP);

  const ads = await queryRma<{
    ad_id: number; ad_text: string; category: string | null; np_id: number | null;
    status: number; earliest_publish_date: string | null;
  }>(
    `SELECT am.ad_id, am.ad_text, am.category, av.np_id, am.status, am.earliest_publish_date
       FROM ad_master am
       LEFT JOIN ad_value av ON av.ad_id = am.ad_id
      WHERE am.ad_id > ?
        AND CHAR_LENGTH(am.ad_text) > 0
      ORDER BY am.ad_id ASC
      LIMIT ${limit}`,
    [watermark],
  );

  if (ads.length === 0) {
    console.log(`batch #${batch.id}: no new ads past ad_id=${watermark} yet`);
    process.exit(0);
  }

  console.log(`batch #${batch.id}: processing ${ads.length} ad(s), batch remaining=${remaining}`);
  const rules = await loadActiveRules();
  const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : undefined;

  let processedThisTick = 0;
  let engineErrors = 0;
  let maxAdId = watermark;
  const CONCURRENCY = 20;
  for (let i = 0; i < ads.length; i += CONCURRENCY) {
    const chunk = ads.slice(i, i + CONCURRENCY);
    
    await Promise.all(chunk.map(async (ad) => {
      const category = parseCategoryCsv(ad.category);
      const adText = ad.ad_text ?? '';
      const adTextHash = crypto.createHash('sha256').update(adText).digest('hex');

      try {
        const result = await checkAd(
          { ad_text: adText, category_chosen: category, np_id: ad.np_id ?? undefined, ad_id: ad.ad_id },
          { rules, anthropic, skip_categorization: true },
        );

        const runInsert = await executeRmaAi(
          `INSERT INTO editorial_check_run
            (ad_id, run_mode, ad_text_snapshot, ad_text_hash, category_chosen, np_id, language_detected,
             category_suggested, findings, verdict, llm_used, llm_cost_paise, latency_ms, engine_version)
           VALUES (?, 'shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ad.ad_id, adText, adTextHash, JSON.stringify(category), ad.np_id,
            result.language_detected ?? null,
            result.category_suggested ? JSON.stringify(result.category_suggested) : null,
            JSON.stringify(result.findings),
            result.verdict, result.llm_used ? 1 : 0, result.llm_cost_paise, result.latency_ms, result.engine_version,
          ],
        );

        const stat = Number(ad.status);
        const isEligibleStat = stat === 5 || stat === 4 || stat === 11 || (ad.earliest_publish_date ? new Date(ad.earliest_publish_date).getTime() < Date.now() : false);
        const computeImmediately = isEligibleStat && stat !== 12;

        if (computeImmediately) {
          const tickets = await queryRma<{ reason_id: number }>(
            `SELECT DISTINCT CAST(reason AS UNSIGNED) AS reason_id
               FROM forum_report_email_master
              WHERE ad_id = ?
                AND generated_by = '6'
                AND reason REGEXP '^[0-9]+$'`,
            [ad.ad_id],
          );
          const roReasonIds = tickets.map((t) => Number(t.reason_id)).filter((n) => Number.isFinite(n));
          const ruleById = new Map<number, Rule>(rules.map((r) => [r.id, r]));
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
        } else {
          const ruleIds = Array.isArray(result.findings)
            ? result.findings.map((f: any) => f.rule_id).filter((id: any) => typeof id === 'number' && id > 0)
            : [];
          await executeRmaAi(
            `INSERT INTO editorial_check_alignment
              (check_run_id, ad_id, our_rule_ids, ro_reason_ids, flag_overlap, we_extra, ro_extra, outcome, eligible_at, computed_at)
             VALUES (?, ?, ?, '[]', '[]', '[]', '[]', 'PENDING_RO_REVIEW', NULL, NOW())`,
            [runInsert.insertId, ad.ad_id, JSON.stringify(ruleIds)],
          );
        }

        processedThisTick++;
      } catch (e) {
        engineErrors++;
        console.error(`ad ${ad.ad_id} engine error:`, e instanceof Error ? e.message : e);
        try {
          const runInsert = await executeRmaAi(
            `INSERT INTO editorial_check_run
              (ad_id, run_mode, ad_text_snapshot, ad_text_hash, category_chosen, np_id, language_detected,
               category_suggested, findings, verdict, llm_used, llm_cost_paise, latency_ms, engine_version)
             VALUES (?, 'shadow', ?, ?, ?, ?, NULL, NULL, '[]', 'pass', 0, 0, 0, 'error')`,
            [ad.ad_id, adText, adTextHash, JSON.stringify(category), ad.np_id],
          );
          await executeRmaAi(
            `INSERT INTO editorial_check_alignment
              (check_run_id, ad_id, our_rule_ids, ro_reason_ids, flag_overlap, we_extra, ro_extra, outcome, eligible_at, computed_at)
             VALUES (?, ?, '[]', '[]', '[]', '[]', '[]', 'PENDING_RO_REVIEW', NULL, NOW())`,
            [runInsert.insertId, ad.ad_id],
          );
        } catch (innerE) {
          console.error(`ad ${ad.ad_id} failed to insert error fallback row:`, innerE);
        }
        processedThisTick++;
      }
    }));
    
    // Update watermark correctly
    const maxInChunk = Math.max(...chunk.map(ad => ad.ad_id));
    maxAdId = Math.max(maxAdId, maxInChunk);
  }

  const newProcessed = batch.processed_count + processedThisTick;
  const completed = newProcessed >= batch.target_count;
  await executeRmaAi(
    `UPDATE shadow_batch
        SET processed_count = ?,
            last_processed_ad_id = ?,
            status = ${completed ? `'completed'` : `'active'`},
            completed_at = ${completed ? 'NOW()' : 'completed_at'}
      WHERE id = ?`,
    [newProcessed, maxAdId, batch.id],
  );
  console.log(`batch #${batch.id}: +${processedThisTick} processed (total ${newProcessed}/${batch.target_count}), watermark=${maxAdId}${engineErrors > 0 ? `, ${engineErrors} engine errors` : ''}${completed ? ' — COMPLETED' : ''}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('shadow_worker fatal:', e);
  process.exit(1);
});
