import type {
  CheckInput,
  Finding,
  Rule,
  RegexBanPattern,
  MustContainPattern,
  WordCountMaxPattern,
  WordCountMinPattern,
  LanguageOnlyPattern,
  FormatPattern,
  Severity,
} from './types';
import { detectScript, looksLikeMojibake } from './languageDetect';

export function applies(rule: Rule, input: CheckInput): Severity | null {
  if (rule.status !== 'active') return null;

  const ids = [
    input.category_chosen.top,
    input.category_chosen.sub,
    input.category_chosen.sub_sub,
    input.category_chosen.sub_sub_sub,
  ].filter((x): x is number => typeof x === 'number');

  const checkScope = (catScope: number[] | null, npScope: number[] | null): boolean => {
    if (catScope && !catScope.some((c) => ids.includes(c))) return false;
    if (npScope && (input.np_id == null || !npScope.includes(input.np_id))) return false;
    return true;
  };

  if ((rule.hard_category_scope || rule.hard_np_scope) && checkScope(rule.hard_category_scope, rule.hard_np_scope)) {
    return 'hard';
  }
  
  if ((rule.soft_category_scope || rule.soft_np_scope) && checkScope(rule.soft_category_scope, rule.soft_np_scope)) {
    return 'soft';
  }

  // Fallback to global severity if no granular scopes apply or are defined
  if (rule.severity === 'hard' && !rule.hard_category_scope && !rule.hard_np_scope) {
    return 'hard';
  }
  if (rule.severity === 'soft' && !rule.soft_category_scope && !rule.soft_np_scope) {
    return 'soft';
  }

  return null;
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function evalRule(rule: Rule, input: CheckInput): Finding | null {
  const severity = applies(rule, input);
  if (!severity) return null;
  
  const text = input.ad_text;
  const make = (message: string, span?: Finding['span']): Finding => ({
    rule_id: rule.id,
    rule_name: rule.name,
    severity: severity,
    score: rule.base_score ?? (severity === 'hard' ? 1.0 : 0.5),
    confidence: 1.0,
    message,
    ...(span ? { span } : {}),
  });

  switch (rule.rule_type) {
    case 'regex_ban': {
      const { regex, flags } = rule.pattern as RegexBanPattern;
      const re = new RegExp(regex, flags ?? 'gi');
      const m = re.exec(text);
      if (m) {
        return make(rule.customer_message, {
          start: m.index,
          end: m.index + m[0].length,
          text: m[0],
        });
      }
      return null;
    }

    case 'must_contain': {
      const { patterns, match_any = true } = rule.pattern as MustContainPattern;
      const matches = patterns.map((p) => new RegExp(p, 'i').test(text));
      const ok = match_any ? matches.some(Boolean) : matches.every(Boolean);
      return ok ? null : make(rule.customer_message);
    }

    case 'word_count_max': {
      const { max } = rule.pattern as WordCountMaxPattern;
      const n = tokenize(text).length;
      return n > max ? make(`${rule.customer_message} (current: ${n} words, max: ${max})`) : null;
    }

    case 'word_count_min': {
      const { min } = rule.pattern as WordCountMinPattern;
      const n = tokenize(text).length;
      return n < min ? make(`${rule.customer_message} (current: ${n} words, min: ${min})`) : null;
    }

    case 'language_only': {
      const { scripts } = rule.pattern as LanguageOnlyPattern;
      if (looksLikeMojibake(text)) {
        return make(rule.customer_message);
      }
      const profile = detectScript(text);
      if (profile.total_letters < 5) return null; // too short to judge
      const allowed = new Set(scripts);
      const dominantOk = allowed.has(profile.dominant);
      return dominantOk ? null : make(rule.customer_message);
    }

    case 'format_pattern': {
      const { regex, flags } = rule.pattern as FormatPattern;
      const re = new RegExp(regex, flags ?? 'i');
      return re.test(text) ? null : make(rule.customer_message);
    }

    case 'category_match':
      // Handled in pass2 (needs LLM); skipped in pass1.
      return null;

    case 'llm_semantic':
      // Handled in pass3 (needs LLM); skipped in pass1.
      return null;

    case 'custom_function':
      // Not implemented in v1.
      return null;
  }
}

export function runPass1(input: CheckInput, rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!applies(rule, input)) continue;
    try {
      const f = evalRule(rule, input);
      if (f) findings.push(f);
    } catch (e) {
      console.error(`Rule ${rule.id} (${rule.name}) errored:`, e);
    }
  }
  return findings;
}
