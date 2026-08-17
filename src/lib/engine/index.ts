import Anthropic from '@anthropic-ai/sdk';
import { runPass1, applies } from './pass1Rules';
import { runPass2, type CategoryCandidate } from './pass2Categorization';
import { runPass3, type Pass3Context } from './pass3LlmJudge';
import { detectScript } from './languageDetect';
import { type CheckInput, type CheckResult, type Rule, type Finding, type Verdict, ENGINE_VERSION } from './types';

export interface EngineOptions {
  rules: Rule[];                  // active rules from editorial_rule
  cat_mes_advisories?: string[];  // for the (category, np) combo — stripped of HTML
  category_chosen_lookup?: CategoryCandidate | null;
  category_candidates?: CategoryCandidate[];
  anthropic?: Anthropic;          // omit to skip LLM passes (rules-only mode)
  skip_categorization?: boolean;
}

function deriveVerdict(findings: Finding[]): { verdict: Verdict; total_score: number } {
  const totalScore = findings.reduce((acc, f) => acc + (Number(f.score) || 0), 0);
  let verdict: Verdict = 'pass';
  if (totalScore >= 1.0) verdict = 'block';
  else if (totalScore > 0) verdict = 'warn';

  // Fallback: If any rule is explicitly marked as 'hard' severity, it must be a block,
  // even if the LLM's confidence multiplier (e.g. 0.95) dropped the final score below 1.0.
  if (findings.some((f) => f.severity === 'hard')) verdict = 'block';
  
  return { verdict, total_score: totalScore };
}

export async function checkAd(input: CheckInput, opts: EngineOptions): Promise<CheckResult> {
  const t0 = Date.now();
  const findings: Finding[] = [];
  let llmCostPaise = 0;
  let llmUsed = false;

  const applicableRules = opts.rules.filter((r) => r.status === 'active');

  // Pass 1 — deterministic.
  const pass1 = runPass1(input, applicableRules);
  findings.push(...pass1);
  const pass1Score = pass1.reduce((acc, f) => acc + f.score, 0);

  const hasNvidiaKey = !!process.env.NVIDIA_API_KEY;

  // Pass 2 — categorisation (LLM).
  let categorySuggested: CheckResult['category_suggested'];
  if ((opts.anthropic || hasNvidiaKey) && !opts.skip_categorization && opts.category_candidates && opts.category_candidates.length > 0) {
    try {
      const p2 = await runPass2(opts.anthropic, input, opts.category_chosen_lookup ?? null, opts.category_candidates);
      llmUsed = true;
      llmCostPaise += p2.cost_paise;
      if (p2.finding) findings.push(p2.finding);
      if (!p2.is_correct) categorySuggested = p2.suggested_category;
    } catch (e) {
      console.error('Pass 2 error:', e);
    }
  }

  // Pass 3 — semantic LLM judge over any llm_semantic rules.
  const semanticRules = applicableRules.filter((r) => r.rule_type === 'llm_semantic' && applies(r, input));
  if ((opts.anthropic || hasNvidiaKey) && semanticRules.length > 0) {
    try {
      const ctx: Pass3Context = {
        cat_mes_advisories: opts.cat_mes_advisories ?? [],
        pass1_findings: pass1,
        semantic_rules: semanticRules,
      };
      const p3 = await runPass3(opts.anthropic, input, ctx);
      llmUsed = true;
      llmCostPaise += p3.cost_paise;
      findings.push(...p3.findings);
    } catch (e) {
      console.error('Pass 3 error:', e);
    }
  }

  // Auto-flag document upload rules to ensure they are checked
  const isDocRule = (r: Rule) => {
    const str = (JSON.stringify(r.pattern || {}) + ' ' + (r.name || '')).toLowerCase();
    return str.includes('document') || str.includes('affidavit') || str.includes('upload') || str.includes('id proof');
  };
  
  const documentRules = applicableRules.filter(r => isDocRule(r) && applies(r, input));
  for (const dr of documentRules) {
    if (!findings.some(f => f.rule_id === dr.id)) {
      const dynSeverity = applies(dr, input) as 'hard' | 'soft';
      findings.push({
        rule_id: dr.id,
        rule_name: dr.name,
        severity: dynSeverity,
        score: dr.base_score ?? (dynSeverity === 'hard' ? 1.0 : 0.5),
        confidence: 1.0,
        message: 'Document upload required for this category.'
      });
    }
  }

  // Pass 4 — Fast document validation (bypass Vision LLM per user request)
  let finalFindings = findings;
  
  if (input.document_url && input.document_url.trim().length > 10) {
    // Document is provided, waive all document upload rules
    const waivedRuleIds = documentRules.map(r => r.id);
    if (waivedRuleIds.length > 0) {
      finalFindings = findings.filter(f => !waivedRuleIds.includes(f.rule_id));
    }
  }

  const profile = detectScript(input.ad_text);

  const { verdict, total_score } = deriveVerdict(finalFindings);

  return {
    verdict,
    total_score,
    findings: finalFindings,
    category_suggested: categorySuggested,
    language_detected: profile.dominant,
    llm_used: llmUsed,
    llm_cost_paise: llmCostPaise,
    latency_ms: Date.now() - t0,
    engine_version: ENGINE_VERSION,
  };
}

export { ENGINE_VERSION } from './types';
export type { CheckInput, CheckResult, Rule, Finding } from './types';
