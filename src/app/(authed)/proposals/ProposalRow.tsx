'use client';

import { useMemo, useState, useTransition } from 'react';
import { approveProposal, rejectProposal, reopenProposal, type ProposalOverrides } from '../actions';
import type { EnrichedProposal, NewspaperOption } from './data';
import { CategoryPicker } from './CategoryPicker';

const RO_REASON_LABELS: Record<number, string> = {
  1: 'Missing Contact',
  2: 'Wrong Abbreviations',
  4: 'Incorrect Categorization',
  10: 'Edit Ad Matter',
  11: 'Newspaper Does Not Accept',
  12: 'Exceeds Word Limit',
  13: 'Improper Spacing',
  18: 'Unidentified Characters',
  109: 'Spam',
  137: 'Editorially Disapproved',
  150: 'Category Missing',
  207: 'Verify Content',
};

interface EditState {
  name: string;
  customerMessage: string;
  npScopeMode: 'all' | 'specific';
  npScopeIds: number[];
  catScopeIds: number[];
  severity: 'hard' | 'soft';
  targetReason: number[];
}

function initialEditState(proposal: EnrichedProposal): EditState {
  const npScope = proposal.effectiveNpScope;
  const catScope = proposal.effectiveCategoryScope;
  return {
    name: proposal.name,
    customerMessage: proposal.customerMessage,
    npScopeMode: npScope === null ? 'all' : 'specific',
    npScopeIds: npScope ? npScope.map((n) => n.np_id) : [],
    catScopeIds: catScope ? catScope.map((c) => c.id) : [],
    severity: proposal.severity === 'hard' ? 'hard' : 'soft',
    targetReason: proposal.targetReason ?? [],
  };
}

export function ProposalRow({
  proposal,
  editable,
  allNewspapers,
  allReasons,
}: {
  proposal: EnrichedProposal;
  editable: boolean;
  allNewspapers: NewspaperOption[];
  allReasons: {id: number, name: string}[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [rejectNote, setRejectNote] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [edit, setEdit] = useState<EditState>(() => initialEditState(proposal));
  const [npSearch, setNpSearch] = useState('');

  const initial = useMemo(() => initialEditState(proposal), [proposal]);
  const isDirty =
    edit.name.trim() !== initial.name.trim() ||
    edit.customerMessage.trim() !== initial.customerMessage.trim() ||
    edit.npScopeMode !== initial.npScopeMode ||
    edit.npScopeIds.slice().sort().join(',') !== initial.npScopeIds.slice().sort().join(',') ||
    edit.catScopeIds.slice().sort().join(',') !== initial.catScopeIds.slice().sort().join(',') ||
    edit.severity !== initial.severity ||
    edit.targetReason.slice().sort().join(',') !== initial.targetReason.slice().sort().join(',');

  function buildOverrides(): ProposalOverrides | null {
    if (!isDirty) return null;
    const overrides: ProposalOverrides = {};
    if (edit.name.trim() !== initial.name.trim()) {
      if (!edit.name.trim()) throw new Error('Rule name cannot be empty');
      overrides.name = edit.name.trim();
    }
    if (edit.customerMessage.trim() !== initial.customerMessage.trim()) {
      overrides.customer_message = edit.customerMessage.trim();
    }
    const scopes = edit.catScopeIds.length > 0 ? edit.catScopeIds.slice().sort((a, b) => a - b) : null;
    const nps = edit.npScopeMode === 'all' ? null : edit.npScopeIds.slice().sort((a, b) => a - b);
    if (edit.severity === 'hard') {
      overrides.hard_category_scope = scopes;
      overrides.hard_np_scope = nps;
      overrides.soft_category_scope = null;
      overrides.soft_np_scope = null;
    } else {
      overrides.soft_category_scope = scopes;
      overrides.soft_np_scope = nps;
      overrides.hard_category_scope = null;
      overrides.hard_np_scope = null;
    }
    overrides.target_ro_reason = edit.targetReason.length > 0 ? edit.targetReason.slice().sort((a, b) => a - b) : null;
    return overrides;
  }

  function approve() {
    startTransition(async () => {
      try {
        const overrides = buildOverrides();
        await approveProposal(proposal.id, null, overrides);
      } catch (e) {
        alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function reject() {
    startTransition(async () => {
      try {
        await rejectProposal(proposal.id, null, rejectNote);
      } catch (e) {
        alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function reopen() {
    startTransition(async () => {
      try {
        await reopenProposal(proposal.id);
      } catch (e) {
        alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function toggleNp(npId: number) {
    setEdit((s) => ({
      ...s,
      npScopeIds: s.npScopeIds.includes(npId)
        ? s.npScopeIds.filter((id) => id !== npId)
        : [...s.npScopeIds, npId],
    }));
  }

  function resetEdits() {
    setEdit(initialEditState(proposal));
  }

  // Summary line reflects the rule's *effective* scope (what the engine will match on).
  // Source-advisory scope is still shown in full inside the expanded Scope block.
  const npLabel =
    proposal.effectiveNpScope === null
      ? 'all newspapers'
      : proposal.effectiveNpScope.length === 0
        ? '(no newspapers)'
        : proposal.effectiveNpScope.length <= 2
          ? proposal.effectiveNpScope.map((n) => n.title).join(', ')
          : `${proposal.effectiveNpScope[0].title} +${proposal.effectiveNpScope.length - 1}`;

  const catLabel =
    proposal.effectiveCategoryScope === null
      ? 'all categories'
      : proposal.effectiveCategoryScope.length === 0
        ? '(no categories)'
        : proposal.effectiveCategoryScope.length <= 2
          ? proposal.effectiveCategoryScope.map((c) => c.name).join(', ')
          : `${proposal.effectiveCategoryScope[0].name} +${proposal.effectiveCategoryScope.length - 1}`;

  const filteredNewspapers = npSearch.trim()
    ? allNewspapers.filter((n) => n.title.toLowerCase().includes(npSearch.trim().toLowerCase()))
    : allNewspapers;

  return (
    <div className="prow">
      <div className="prow-summary" onClick={() => setExpanded((v) => !v)}>
        <span className="prow-id">#{proposal.id}</span>
        <span className={`badge badge-${proposal.severity}`}>{proposal.severity}</span>
        <span className="badge">{proposal.ruleType}</span>
        <span className="prow-name">{proposal.name}</span>
        <span className="prow-meta">
          {proposal.targetReason && proposal.targetReason.length > 0 && <span>reasons: {proposal.targetReason.join(', ')}</span>}
          {catLabel && <span>· {catLabel}</span>}
          {npLabel && <span>· {npLabel}</span>}
          {proposal.isNewspaperSpecificCategory && <span className="badge">np-specific cat</span>}
        </span>
      </div>

      {expanded && (
        <div className="prow-detail">
          <p className="muted" style={{ marginTop: 0 }}>
            {proposal.description}
          </p>
          <div style={{ padding: 8, background: 'var(--soft-bg)', borderRadius: 4 }}>
            <strong>Customer sees:</strong> {proposal.customerMessage}
          </div>

          <ScopeBlock proposal={proposal} />

          {proposal.sourceAdvisory && (
            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontWeight: 600 }}>
                Source advisory{' '}
                {proposal.source_cat_mes_id != null && <>(cat_mes#{proposal.source_cat_mes_id})</>}
                {proposal.sourceAdvisoryPage && <> · {proposal.sourceAdvisoryPage}</>}
              </summary>
              <div className="prow-advisory">{proposal.sourceAdvisory}</div>
            </details>
          )}

          <div className="flex" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setShowPayload((v) => !v)}>
              {showPayload ? 'Hide pattern JSON' : 'Show pattern JSON'}
            </button>
            <span className="muted">by {proposal.proposed_by}</span>
            {proposal.source_alignment_id != null && (
              <span className="muted">· from alignment #{proposal.source_alignment_id}</span>
            )}
            {proposal.status !== 'pending' && (
              <span className="badge">
                {proposal.status}
                {proposal.resulting_rule_id ? ` → rule #${proposal.resulting_rule_id}` : ''}
              </span>
            )}
          </div>

          {showPayload && (
            <pre style={{ background: '#f9fafb', padding: 8, fontSize: 11, marginTop: 8, overflow: 'auto' }}>
{JSON.stringify(proposal.payload, null, 2)}
            </pre>
          )}

          {!editable && proposal.status === 'rejected' && (
            <div style={{ marginTop: 12 }}>
              <button className="btn" disabled={pending} onClick={reopen}>
                Reopen → pending
              </button>
              {proposal.notes && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  Rejection note: {proposal.notes}
                </div>
              )}
            </div>
          )}

          {editable && (
            <div style={{ marginTop: 12 }}>
              <div className="flex" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-success" disabled={pending} onClick={approve}>
                  {isDirty ? 'Approve with edits → active rule' : 'Approve → active rule'}
                </button>
                <button className="btn" onClick={() => setShowEdit((v) => !v)}>
                  {showEdit ? 'Hide edit' : 'Edit scope / severity'}
                </button>
                <button className="btn btn-danger" disabled={pending} onClick={() => setShowReject((v) => !v)}>
                  Reject
                </button>
                {isDirty && (
                  <button className="btn" onClick={resetEdits} disabled={pending}>
                    Reset edits
                  </button>
                )}
              </div>

              {showEdit && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 12,
                    background: '#fff',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                  }}
                >
                  <div className="field">
                    <label>Rule name (the criterion this rule checks)</label>
                    <input
                      type="text"
                      value={edit.name}
                      onChange={(e) => setEdit((s) => ({ ...s, name: e.target.value }))}
                    />
                  </div>

                  <div className="field">
                    <label>Customer message (what the customer sees if this rule fires)</label>
                    <textarea
                      value={edit.customerMessage}
                      onChange={(e) => setEdit((s) => ({ ...s, customerMessage: e.target.value }))}
                      rows={2}
                    />
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <label>Newspaper scope</label>
                    <div className="flex" style={{ marginBottom: 6 }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
                        <input
                          type="radio"
                          checked={edit.npScopeMode === 'all'}
                          onChange={() => setEdit((s) => ({ ...s, npScopeMode: 'all' }))}
                          style={{ width: 'auto' }}
                        />
                        <span>All newspapers</span>
                      </label>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
                        <input
                          type="radio"
                          checked={edit.npScopeMode === 'specific'}
                          onChange={() => setEdit((s) => ({ ...s, npScopeMode: 'specific' }))}
                          style={{ width: 'auto' }}
                        />
                        <span>Specific newspapers ({edit.npScopeIds.length} selected)</span>
                      </label>
                    </div>
                    {edit.npScopeMode === 'specific' && (
                      <div
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          padding: 6,
                          maxHeight: 200,
                          overflow: 'auto',
                          background: '#fafafa',
                        }}
                      >
                        <input
                          type="text"
                          placeholder="Filter newspapers…"
                          value={npSearch}
                          onChange={(e) => setNpSearch(e.target.value)}
                          style={{ marginBottom: 6 }}
                        />
                        {filteredNewspapers.length === 0 && (
                          <div className="muted" style={{ padding: 4 }}>
                            No newspapers match.
                          </div>
                        )}
                        {filteredNewspapers.map((n) => (
                          <label
                            key={n.np_id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              margin: 0,
                              padding: '2px 4px',
                              fontSize: 12,
                              color: 'var(--text)',
                              fontWeight: 400,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={edit.npScopeIds.includes(n.np_id)}
                              onChange={() => toggleNp(n.np_id)}
                              style={{ width: 'auto' }}
                            />
                            <span>
                              {n.title} <span className="muted">#{n.np_id}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="field">
                    <label>Category scope (search by name; leave empty = all categories)</label>
                    <CategoryPicker
                      initialSelected={proposal.effectiveCategoryScope ?? []}
                      onChange={(ids) => setEdit((s) => ({ ...s, catScopeIds: ids }))}
                    />
                  </div>

                  <div className="row">
                    <div className="col field">
                      <label>Severity</label>
                      <select
                        value={edit.severity}
                        onChange={(e) =>
                          setEdit((s) => ({ ...s, severity: e.target.value === 'hard' ? 'hard' : 'soft' }))
                        }
                      >
                        <option value="soft">soft</option>
                        <option value="hard">hard</option>
                      </select>
                    </div>
                    <div className="col field">
                      <label>Target RO reasons</label>
                      <select
                        multiple
                        value={edit.targetReason.map(String)}
                        onChange={(e) => {
                          const values = Array.from(e.target.selectedOptions, option => parseInt(option.value, 10));
                          setEdit((s) => ({ ...s, targetReason: values }));
                        }}
                        style={{ height: 120 }}
                      >
                        {allReasons.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.id} · {r.name}
                          </option>
                        ))}
                      </select>
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Hold Ctrl/Cmd to select multiple</div>
                    </div>
                  </div>
                </div>
              )}

              {showReject && (
                <div style={{ marginTop: 8 }}>
                  <textarea
                    placeholder="Why are you rejecting? (optional, helps the LLM learn)"
                    value={rejectNote}
                    onChange={(e) => setRejectNote(e.target.value)}
                  />
                  <button className="btn btn-danger" disabled={pending} onClick={reject} style={{ marginTop: 4 }}>
                    Confirm rejection
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScopeBlock({ proposal }: { proposal: EnrichedProposal }) {
  const ruleAllNp = proposal.effectiveNpScope === null;
  const ruleAllCat = proposal.effectiveCategoryScope === null;

  const ruleNpLabel = ruleAllNp
    ? 'All newspapers'
    : proposal.effectiveNpScope!.length === 0
      ? '(empty list — will not match any newspaper)'
      : proposal.effectiveNpScope!.map((n) => `${n.title} (#${n.np_id})`).join(', ');

  const ruleCatLabel = ruleAllCat
    ? 'All categories'
    : proposal.effectiveCategoryScope!.length === 0
      ? '(empty list — will not match any category)'
      : proposal.effectiveCategoryScope!.map((c) => `${c.name} (#${c.id})`).join(', ');

  // Detect mismatch between advisory source and rule scope to surface it.
  const sourceHasSpecificNp = !proposal.appliesToAllNewspapers && proposal.newspapers.length > 0;
  const npMismatch = sourceHasSpecificNp && ruleAllNp;

  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        background: '#fff',
        border: '1px solid var(--border)',
        borderRadius: 4,
      }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 13 }}>Scope</h3>

      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '4px 12px', fontSize: 12 }}>
        <div className="muted">Rule applies to</div>
        <div>
          <strong>Newspapers:</strong> {ruleNpLabel}
        </div>
        <div></div>
        <div>
          <strong>Categories:</strong> {ruleCatLabel}
        </div>
        <div></div>
        <div>
          <strong>Severity:</strong> <span className={`badge badge-${proposal.severity}`}>{proposal.severity}</span>
          {proposal.targetReason && proposal.targetReason.length > 0 && (
            <>
              {' · '}
              <strong>Target reasons:</strong> {proposal.targetReason.join(', ')}
            </>
          )}
        </div>

        <div className="muted" style={{ marginTop: 6 }}>
          From advisory
        </div>
        <div style={{ marginTop: 6 }}>
          <strong>Newspapers in advisory:</strong>{' '}
          {proposal.appliesToAllNewspapers
            ? 'All newspapers (cat_mes.newspaper is empty)'
            : proposal.newspapers.length === 0
              ? '(no source advisory or no newspapers listed)'
              : proposal.newspapers.map((n) => `${n.title} (#${n.np_id})`).join(', ')}
        </div>
        <div></div>
        <div>
          <strong>Category in advisory:</strong>{' '}
          {proposal.sourceCategoryName || proposal.sourceCategoryId
            ? `${proposal.topCategoryName ?? '?'} (#${proposal.topCategoryId ?? '?'})${
                proposal.sourceCategoryName && proposal.sourceCategoryName !== proposal.topCategoryName
                  ? ` → ${proposal.sourceCategoryName} (#${proposal.sourceCategoryId})`
                  : ''
              }`
            : '(none)'}
          {proposal.isNewspaperSpecificCategory && (
            <span className="badge" style={{ marginLeft: 6 }}>
              np-specific cat
            </span>
          )}
        </div>
      </div>

      {npMismatch && (
        <div
          style={{
            marginTop: 8,
            padding: 6,
            background: 'var(--soft-bg)',
            border: '1px solid #fde68a',
            borderRadius: 4,
            fontSize: 11,
            color: 'var(--warn)',
          }}
        >
          ⚠ The advisory is scoped to specific newspapers, but the rule will apply to{' '}
          <strong>all newspapers</strong> on approval. Use &ldquo;Edit scope / severity&rdquo; below to narrow it.
        </div>
      )}
    </div>
  );
}
