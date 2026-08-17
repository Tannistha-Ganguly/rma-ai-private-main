// Maps our rules' target_ro_reason → RO's ro_reason ids, then derives the 8-bucket outcome.

import type { Finding, Rule } from '@/lib/engine/types';

export type AlignmentOutcome =
  | 'FULL_MATCH'
  | 'PARTIAL_OVERLAP'
  | 'NO_OVERLAP_BOTH_FLAGGED'
  | 'WE_ONLY'
  | 'RO_ONLY'
  | 'BOTH_CLEAN'
  | 'PENDING_RO_REVIEW'
  | 'DATA_QUALITY'
  | 'NON_EDITORIAL_RO_FLAG';

import { EDITORIAL_REASONS_LIST } from '@/lib/engine/constants';
const EDITORIAL_REASONS = new Set(EDITORIAL_REASONS_LIST);

export interface AlignmentInput {
  ad_id: number;
  our_findings: Finding[];
  ro_reason_ids: number[];         // distinct ro_reason ids from forum_report_email_master for this ad
  eligible: boolean;                // ad_master.status=5 OR earliest_publish_date < today
  data_quality_flag?: boolean;
}

export interface AlignmentResult {
  outcome: AlignmentOutcome;
  our_rule_ids: number[];
  ro_reason_ids: number[];
  flag_overlap: number[];           // ro_reason_ids both sides identified
  we_extra: number[];               // our_target_reasons not in RO
  ro_extra: number[];               // ro_reason_ids not implied by our findings
}

export function computeAlignment(input: AlignmentInput, ruleById: Map<number, Rule>): AlignmentResult {
  const our_rule_ids = input.our_findings.map((f) => f.rule_id).filter((id) => id > 0);

  const ro_set = new Set(input.ro_reason_ids.filter((r) => EDITORIAL_REASONS.has(r)));

  const our_target_reasons = new Set<number>();
  for (const f of input.our_findings) {
    const r = ruleById.get(f.rule_id);
    if (r?.target_ro_reason && Array.isArray(r.target_ro_reason)) {
      for (const tr of r.target_ro_reason) {
        if (f.severity === 'hard' || ro_set.has(tr)) {
          our_target_reasons.add(tr);
        }
      }
    }
  }

  const flag_overlap = [...our_target_reasons].filter((r) => ro_set.has(r));
  const we_extra = [...our_target_reasons].filter((r) => !ro_set.has(r));
  const ro_extra = [...ro_set].filter((r) => !our_target_reasons.has(r));

  const totalScore = input.our_findings.reduce((acc, f) => acc + (f.score ?? 0), 0);
  const is_blocked = totalScore >= 1.0 || input.our_findings.some((f) => f.severity === 'hard' && (f.score ?? 0) >= 1.0);

  // Outcome determination:
  // FULL_MATCH  = we found at least one of the RO's editorial findings (flag_overlap > 0).
  //               Even if we missed some RO findings (ro_extra > 0) or found extra ones (we_extra > 0),
  //               any overlap is considered a FULL_MATCH.
  // PARTIAL_OVERLAP = effectively merged into FULL_MATCH per business logic.
  // NO_OVERLAP_BOTH_FLAGGED = both sides flagged the ad but for completely different editorial reasons.
  let outcome: AlignmentOutcome;
  if (input.data_quality_flag) {
    outcome = 'DATA_QUALITY';
  } else if (!input.eligible) {
    outcome = 'PENDING_RO_REVIEW';
  } else if (is_blocked && ro_set.size === 0) {
    outcome = 'WE_ONLY';
  } else if (!is_blocked && ro_set.size > 0) {
    outcome = 'RO_ONLY';
  } else if (!is_blocked && ro_set.size === 0) {
    outcome = input.ro_reason_ids.length > 0 ? 'NON_EDITORIAL_RO_FLAG' : 'BOTH_CLEAN';
  } else if (flag_overlap.length > 0) {
    outcome = 'FULL_MATCH';
  } else {
    // is_blocked && ro_set.size > 0 && flag_overlap.length === 0
    outcome = 'NO_OVERLAP_BOTH_FLAGGED';
  }

  return {
    outcome,
    our_rule_ids,
    ro_reason_ids: input.ro_reason_ids,
    flag_overlap,
    we_extra,
    ro_extra,
  };
}
