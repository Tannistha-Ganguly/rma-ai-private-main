export type RuleType =
  | 'regex_ban'
  | 'must_contain'
  | 'word_count_max'
  | 'word_count_min'
  | 'language_only'
  | 'format_pattern'
  | 'category_match'
  | 'llm_semantic'
  | 'custom_function';

export type Severity = 'hard' | 'soft';
export type Verdict = 'pass' | 'warn' | 'block';

export type RegexBanPattern = { regex: string; flags?: string };
export type MustContainPattern = { patterns: string[]; match_any?: boolean };
export type WordCountMaxPattern = { max: number };
export type WordCountMinPattern = { min: number };
export type LanguageOnlyPattern = { scripts: string[] };
export type FormatPattern = { regex: string; flags?: string };
export type RuleExample = { text: string; is_violation: boolean; reasoning: string };
export type LlmSemanticPattern = { check_prompt: string; examples?: RuleExample[] };

export type RulePattern =
  | RegexBanPattern
  | MustContainPattern
  | WordCountMaxPattern
  | WordCountMinPattern
  | LanguageOnlyPattern
  | FormatPattern
  | LlmSemanticPattern
  | Record<string, unknown>;

export interface Rule {
  id: number;
  name: string;
  description: string;
  customer_message: string;
  rule_type: RuleType;
  pattern: RulePattern;
  hard_category_scope: number[] | null;
  hard_np_scope: number[] | null;
  soft_category_scope: number[] | null;
  soft_np_scope: number[] | null;
  severity: Severity;
  target_ro_reason: number[] | null;
  base_score: number;
  status: 'active' | 'proposed' | 'disabled';
}

export interface Finding {
  rule_id: number;
  rule_name: string;
  severity: Severity;
  score: number;
  confidence?: number;
  message: string;
  span?: { start: number; end: number; text: string };
  suggested_rewrite?: string;
}

export interface CategoryChoice {
  top?: number;
  sub?: number;
  sub_sub?: number;
  sub_sub_sub?: number;
}

export interface CheckInput {
  ad_text: string;
  category_chosen: CategoryChoice;
  np_id?: number;
  ad_type?: number;
  ad_id?: number;
  document_url?: string;
}

export interface CheckResult {
  verdict: Verdict;
  total_score: number;
  findings: Finding[];
  category_suggested?: CategoryChoice;
  language_detected?: string;
  llm_used: boolean;
  llm_cost_paise: number;
  latency_ms: number;
  engine_version: string;
}

export const ENGINE_VERSION = '0.1.4';
