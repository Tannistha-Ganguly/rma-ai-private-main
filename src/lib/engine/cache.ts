import { queryRmaAi, executeRmaAi } from '../db/rmaAi';
import crypto from 'node:crypto';
import type { CheckResult, Rule } from './types';

export function getRulesHash(rules: Rule[]): string {
  const data = JSON.stringify(rules.map(r => ({
    id: r.id, 
    pat: r.pattern, 
    st: r.status, 
    hc: r.hard_category_scope,
    hn: r.hard_np_scope,
    sc: r.soft_category_scope,
    sn: r.soft_np_scope,
    sev: r.severity,
    bs: r.base_score
  })));
  return crypto.createHash('md5').update(data).digest('hex');
}

export function getAdContextHash(adText: string, categoryChosenCsv: string | null | undefined, npId: number | null | undefined): string {
  const data = JSON.stringify({ adText, categoryChosenCsv, npId });
  return crypto.createHash('sha256').update(data).digest('hex');
}

import { ENGINE_VERSION } from './types';

export async function checkCache(adHash: string, rulesHash: string): Promise<CheckResult | null> {
  const rows = await queryRmaAi<any>(
    `SELECT * FROM editorial_check_cache WHERE ad_hash = ? AND rules_hash = ? AND engine_version = ? LIMIT 1`,
    [adHash, rulesHash, ENGINE_VERSION]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    verdict: row.verdict,
    findings: typeof row.findings === 'string' ? JSON.parse(row.findings) : row.findings,
    category_suggested: row.category_suggested ? (typeof row.category_suggested === 'string' ? JSON.parse(row.category_suggested) : row.category_suggested) : undefined,
    language_detected: row.language_detected,
    total_score: row.total_score || 0,
    llm_used: false,
    llm_cost_paise: 0,
    latency_ms: 0,
    engine_version: row.engine_version,
  };
}

export async function writeCache(adHash: string, rulesHash: string, engineVersion: string, result: CheckResult) {
  try {
    await executeRmaAi(
      `INSERT IGNORE INTO editorial_check_cache
       (ad_hash, rules_hash, engine_version, category_suggested, findings, verdict, language_detected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        adHash, rulesHash, engineVersion,
        result.category_suggested ? JSON.stringify(result.category_suggested) : null,
        JSON.stringify(result.findings), result.verdict, result.language_detected ?? null
      ]
    );
  } catch (err) {
    console.error('Failed to write to cache:', err);
  }
}
