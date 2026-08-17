'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { markAlignmentReviewed, proposeRuleFromAlignment } from '../actions';

const DECISIONS_BY_OUTCOME: Record<string, Array<{ value: string; label: string }>> = {
  FULL_MATCH: [
    { value: 'rule_correct', label: 'Confirm — rule was correct' },
    { value: 'data_quality_issue', label: 'Mark data quality' },
  ],
  WE_ONLY: [
    { value: 'rule_too_strict', label: 'Rule too strict' },
    { value: 'rule_correct', label: 'RO missed it (we were right)' },
    { value: 'data_quality_issue', label: 'Data quality' },
  ],
  RO_ONLY: [
    { value: 'new_rule_needed', label: 'Needs new rule' },
    { value: 'ignored', label: 'Skip — not an editorial issue' },
    { value: 'data_quality_issue', label: 'Data quality' },
  ],
  PARTIAL_OVERLAP: [
    { value: 'rule_needs_refinement', label: 'Refine our rule(s)' },
    { value: 'new_rule_needed', label: 'Add rule for RO extra' },
    { value: 'rule_correct', label: 'Partial agreement is fine' },
  ],
  NO_OVERLAP_BOTH_FLAGGED: [
    { value: 'rule_too_strict', label: 'Our flag wrong; investigate' },
    { value: 'new_rule_needed', label: 'Add rule for RO flag' },
    { value: 'rule_needs_refinement', label: 'Refine our rule' },
  ],
  BOTH_CLEAN: [
    { value: 'rule_correct', label: 'Confirm — clean both sides' },
  ],
  PENDING_RO_REVIEW: [],
  DATA_QUALITY: [
    { value: 'data_quality_issue', label: 'Confirm DQ' },
    { value: 'ignored', label: 'Re-categorise (clear DQ)' },
  ],
};

export function ReviewRowActions({
  alignmentId,
  outcome,
  reviewDecision,
}: {
  alignmentId: number;
  outcome: string;
  reviewDecision: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const decisions = DECISIONS_BY_OUTCOME[outcome] ?? [];

  if (reviewDecision) {
    if (reviewDecision === 'new_rule_needed') {
      return (
        <div style={{ marginTop: 12 }} className="muted">
          ✓ Drafted as proposal — <Link href="/proposals?status=pending">review on /proposals →</Link>
        </div>
      );
    }
    return (
      <div style={{ marginTop: 12 }} className="muted">
        ✓ Reviewed: <code>{reviewDecision}</code>
      </div>
    );
  }
  if (decisions.length === 0) return null;

  function decide(value: string) {
    if (value === 'new_rule_needed') {
      setDrafting(true);
      return;
    }
    startTransition(async () => {
      try {
        await markAlignmentReviewed(alignmentId, value as Parameters<typeof markAlignmentReviewed>[1], null, note);
      } catch (e) {
        alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function submitDraft() {
    const trimmed = ruleName.trim();
    if (!trimmed) {
      alert('Please enter a rule name (the criteria the rule should check for).');
      return;
    }
    startTransition(async () => {
      try {
        await proposeRuleFromAlignment(alignmentId, trimmed, note);
      } catch (e) {
        alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex" style={{ flexWrap: 'wrap' }}>
        {decisions.map((d) => (
          <button key={d.value} className="btn" disabled={pending} onClick={() => decide(d.value)}>
            {d.label}
          </button>
        ))}
        <button className="btn" onClick={() => setShowNote((v) => !v)}>{showNote ? 'Hide note' : '+ Note'}</button>
      </div>
      {drafting && (
        <div
          style={{
            marginTop: 8,
            padding: 10,
            background: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 4,
          }}
        >
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
            Rule name — what should this rule check for?
          </label>
          <input
            type="text"
            placeholder="e.g. Ads must not promise guaranteed returns"
            value={ruleName}
            onChange={(e) => setRuleName(e.target.value)}
            autoFocus
            style={{ width: '100%' }}
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            This becomes the rule&apos;s name and the criterion the LLM checks each ad against. You can refine it later on /proposals.
          </div>
          <div className="flex" style={{ marginTop: 8 }}>
            <button className="btn btn-success" disabled={pending} onClick={submitDraft}>
              Draft proposal
            </button>
            <button className="btn" disabled={pending} onClick={() => { setDrafting(false); setRuleName(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {showNote && (
        <textarea
          placeholder="Optional reviewer note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ marginTop: 8 }}
        />
      )}
    </div>
  );
}
