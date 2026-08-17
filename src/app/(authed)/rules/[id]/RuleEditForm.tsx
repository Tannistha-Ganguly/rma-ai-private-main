'use client';

import { useState, useTransition, useMemo, useEffect, useRef } from 'react';
import { updateRule } from '../../actions';

interface RuleFormData {
  id: number;
  name: string;
  description: string;
  customer_message: string;
  pattern: string;
  severity: 'hard' | 'soft';
  hard_category_scope: string;
  hard_np_scope: string;
  soft_category_scope: string;
  soft_np_scope: string;
  target_ro_reason: number[];
}

function MultiSelectDropdown({ 
  label, 
  valueStr, 
  onChangeStr, 
  options 
}: { 
  label: string, 
  valueStr: string, 
  onChangeStr: (s: string) => void, 
  options: {id: number, name: string}[] 
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  const selectedSet = useMemo(() => {
    if (valueStr === '') {
      return new Set(options.map(o => o.id));
    }
    let ids: number[] = [];
    try {
      const parsed = valueStr.trim() ? JSON.parse(valueStr) : [];
      if (Array.isArray(parsed)) ids = parsed;
    } catch (e) {}
    return new Set(ids);
  }, [valueStr, options]);

  const toggle = (id: number) => {
    const set = new Set(selectedSet);
    if (set.has(id)) set.delete(id); else set.add(id);
    
    if (set.size === options.length) {
      onChangeStr('');
    } else {
      onChangeStr(JSON.stringify(Array.from(set)));
    }
  };

  const selectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    const toAdd = search.trim() ? filtered : options;
    const set = new Set(selectedSet);
    toAdd.forEach(o => set.add(o.id));
    
    if (set.size === options.length) {
      onChangeStr('');
    } else {
      onChangeStr(JSON.stringify(Array.from(set)));
    }
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (search.trim()) {
      const set = new Set(selectedSet);
      filtered.forEach(o => set.delete(o.id));
      onChangeStr(JSON.stringify(Array.from(set)));
    } else {
      onChangeStr('[]');
    }
  };

  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    if (!term) return options;
    return options.filter(o => o.name.toLowerCase().includes(term));
  }, [options, search]);

  const renderedOptions = useMemo(() => {
    const selected = options.filter(o => selectedSet.has(o.id));
    const unselected = filtered.filter(o => !selectedSet.has(o.id)).slice(0, 100);
    return [...selected, ...unselected];
  }, [filtered, selectedSet, options]);

  return (
    <div className="field" ref={containerRef} style={{ position: 'relative', marginBottom: 0 }}>
      <label>{label}</label>
      <div 
        onClick={() => setOpen(!open)}
        style={{ padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', background: 'var(--bg)', minHeight: 34, fontSize: 13 }}
      >
        {selectedSet.size === options.length ? 'All (No scope limit)' : `${selectedSet.size} selected`}
      </div>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', marginTop: 4 }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input 
              type="text" 
              placeholder="Search..." 
              value={search} 
              onChange={e => setSearch(e.target.value)} 
              onClick={e => e.stopPropagation()}
              style={{ width: '100%', marginBottom: 8, fontSize: 13, padding: 6 }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={selectAll} style={{ flex: 1, padding: '4px 0', fontSize: 12, cursor: 'pointer', background: 'var(--hard-bg)', border: '1px solid var(--border)', borderRadius: 4 }}>Select All {search.trim() ? 'Filtered' : ''}</button>
              <button type="button" onClick={clearAll} style={{ flex: 1, padding: '4px 0', fontSize: 12, cursor: 'pointer', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4 }}>Clear {search.trim() ? 'Filtered' : 'All'}</button>
            </div>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto', padding: 8 }}>
            {renderedOptions.map(o => (
              <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 13, fontWeight: 'normal', cursor: 'pointer' }} onClick={e => e.stopPropagation()}>
                <input 
                  type="checkbox" 
                  checked={selectedSet.has(o.id)} 
                  onChange={() => toggle(o.id)} 
                  style={{ margin: 0 }}
                />
                <span className="muted" style={{ display: 'inline-block', width: 40 }}>#{o.id}</span>
                {o.name}
              </label>
            ))}
            {filtered.length > 100 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}>
                Showing top 100 unselected results. Use search to find more.
              </div>
            )}
            {filtered.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No results found.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function RuleEditForm({ 
  rule, 
  ruleType, 
  allReasons,
  allCategories,
  allNewspapers
}: { 
  rule: RuleFormData; 
  ruleType: string; 
  allReasons: {id: number, name: string}[];
  allCategories: {id: number, name: string}[];
  allNewspapers: {id: number, name: string}[];
}) {
  const [form, setForm] = useState(rule);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function update<K extends keyof RuleFormData>(key: K, value: RuleFormData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleReason(id: number) {
    const set = new Set(form.target_ro_reason);
    if (set.has(id)) set.delete(id); else set.add(id);
    update('target_ro_reason', Array.from(set));
  }

  function save() {
    setMsg(null);
    let pattern: object;
    let severity: 'hard' | 'soft';
    let hard_category_scope: number[] | null;
    let hard_np_scope: number[] | null;
    let soft_category_scope: number[] | null;
    let soft_np_scope: number[] | null;
    try {
      pattern = form.pattern.trim() ? JSON.parse(form.pattern) : {};
      severity = form.severity;
      hard_category_scope = form.hard_category_scope.trim() ? JSON.parse(form.hard_category_scope) : null;
      hard_np_scope = form.hard_np_scope.trim() ? JSON.parse(form.hard_np_scope) : null;
      soft_category_scope = form.soft_category_scope.trim() ? JSON.parse(form.soft_category_scope) : null;
      soft_np_scope = form.soft_np_scope.trim() ? JSON.parse(form.soft_np_scope) : null;
    } catch (e) {
      setMsg(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    startTransition(async () => {
      try {
        await updateRule(form.id, {
          name: form.name,
          description: form.description,
          customer_message: form.customer_message,
          pattern,
          severity,
          hard_category_scope,
          hard_np_scope,
          soft_category_scope,
          soft_np_scope,
          target_ro_reason: form.target_ro_reason.length > 0 ? form.target_ro_reason : null,
        });
        setMsg('Saved ✓');
      } catch (e) {
        setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  let parsedPattern: any = null;
  let isLlmSemantic = ruleType === 'llm_semantic';
  if (isLlmSemantic) {
    try {
      parsedPattern = form.pattern.trim() ? JSON.parse(form.pattern) : { check_prompt: '' };
    } catch(e) {
      isLlmSemantic = false; // Fallback to raw json editor if unparseable
    }
  }

  const updateLlmPattern = (key: string, value: any) => {
    if (!parsedPattern) return;
    const next = { ...parsedPattern, [key]: value };
    update('pattern', JSON.stringify(next, null, 2));
  };

  const addExample = () => {
    const examples = Array.isArray(parsedPattern.examples) ? [...parsedPattern.examples] : [];
    examples.push({ text: '', is_violation: false, reasoning: '' });
    updateLlmPattern('examples', examples);
  };

  const updateExample = (index: number, key: string, value: any) => {
    const examples = [...parsedPattern.examples];
    examples[index] = { ...examples[index], [key]: value };
    updateLlmPattern('examples', examples);
  };

  const removeExample = (index: number) => {
    const examples = [...parsedPattern.examples];
    examples.splice(index, 1);
    updateLlmPattern('examples', examples);
  };

  return (
    <div className="card">
      <div className="field">
        <label>Name</label>
        <input value={form.name} onChange={(e) => update('name', e.target.value)} />
      </div>
      <div className="field">
        <label>Description (internal)</label>
        <textarea value={form.description} onChange={(e) => update('description', e.target.value)} />
      </div>
      <div className="field">
        <label>Customer message (shown when this fires)</label>
        <textarea value={form.customer_message} onChange={(e) => update('customer_message', e.target.value)} />
      </div>
      <div className="row">
        <div className="col">
          <div className="field">
            <label>Rule type (immutable)</label>
            <input value={ruleType} disabled />
          </div>
        </div>
        <div className="col">
          <div className="field">
            <label>Global Severity (Default behavior if no scopes apply)</label>
            <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'normal' }}>
                <input type="radio" name="severity" checked={form.severity === 'hard'} onChange={() => update('severity', 'hard')} style={{ margin: 0 }} />
                Hard (Block)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'normal' }}>
                <input type="radio" name="severity" checked={form.severity === 'soft'} onChange={() => update('severity', 'soft')} style={{ margin: 0 }} />
                Soft (Warn)
              </label>
            </div>
          </div>
        </div>
      </div>
      {isLlmSemantic ? (
        <div className="card" style={{ marginBottom: 16, background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 16 }}>AI Semantic Rule Configuration</h3>
          <div className="field">
            <label>AI Check Prompt (Instructions for the LLM)</label>
            <textarea 
              value={parsedPattern.check_prompt || ''} 
              onChange={(e) => updateLlmPattern('check_prompt', e.target.value)} 
              rows={4} 
            />
          </div>
          
          <div className="field" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span>Few-Shot Examples (Teach the AI what to flag)</span>
              <button className="btn" onClick={addExample}>+ Add Example</button>
            </label>
            
            {Array.isArray(parsedPattern.examples) && parsedPattern.examples.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                {parsedPattern.examples.map((ex: any, idx: number) => (
                  <div key={idx} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 4, position: 'relative', background: 'var(--hard-bg)' }}>
                    <button 
                      className="btn" 
                      style={{ position: 'absolute', top: 8, right: 8, color: 'var(--danger)', padding: '2px 8px' }}
                      onClick={() => removeExample(idx)}
                    >
                      Delete
                    </button>
                    <div className="field">
                      <label>Example Ad Text</label>
                      <textarea value={ex.text || ''} onChange={(e) => updateExample(idx, 'text', e.target.value)} rows={2} />
                    </div>
                    <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ margin: 0 }}>Is this a violation? (Should the rule fire?)</label>
                      <input 
                        type="checkbox" 
                        checked={!!ex.is_violation} 
                        onChange={(e) => updateExample(idx, 'is_violation', e.target.checked)} 
                        style={{ margin: 0 }}
                      />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>AI Reasoning (Explain why it is or isn't a violation)</label>
                      <input type="text" value={ex.reasoning || ''} onChange={(e) => updateExample(idx, 'reasoning', e.target.value)} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>No examples added yet. Adding examples drastically improves AI accuracy.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="field">
          <label>Pattern (JSON, schema depends on rule type)</label>
          <textarea value={form.pattern} onChange={(e) => update('pattern', e.target.value)} rows={4} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        </div>
      )}
      <div className="card" style={{ marginBottom: 16, border: '1px solid var(--danger-border)', background: 'var(--hard-bg)' }}>
        <h4 style={{ marginTop: 0 }}>Hard Scope (Block)</h4>
        <div className="row">
          <div className="col">
            <MultiSelectDropdown 
              label="Category scope" 
              valueStr={form.hard_category_scope} 
              onChangeStr={(val) => update('hard_category_scope', val)} 
              options={allCategories} 
            />
          </div>
          <div className="col">
            <MultiSelectDropdown 
              label="Newspaper scope" 
              valueStr={form.hard_np_scope} 
              onChangeStr={(val) => update('hard_np_scope', val)} 
              options={allNewspapers} 
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, border: '1px solid var(--warning-border)', background: 'var(--soft-bg)' }}>
        <h4 style={{ marginTop: 0 }}>Soft Scope (Warn)</h4>
        <div className="row">
          <div className="col">
            <MultiSelectDropdown 
              label="Category scope" 
              valueStr={form.soft_category_scope} 
              onChangeStr={(val) => update('soft_category_scope', val)} 
              options={allCategories} 
            />
          </div>
          <div className="col">
            <MultiSelectDropdown 
              label="Newspaper scope" 
              valueStr={form.soft_np_scope} 
              onChangeStr={(val) => update('soft_np_scope', val)} 
              options={allNewspapers} 
            />
          </div>
        </div>
      </div>
      <div className="field">
        <label>Target RO Reasons (Checked reasons this rule maps to)</label>
        <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', padding: 8, borderRadius: 4, background: 'var(--bg)' }}>
          {allReasons.map((r) => (
            <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 13, fontWeight: 'normal' }}>
              <input 
                type="checkbox" 
                checked={form.target_ro_reason.includes(r.id)} 
                onChange={() => toggleReason(r.id)} 
                style={{ margin: 0 }}
              />
              <span className="muted" style={{ display: 'inline-block', width: 30 }}>#{r.id}</span>
              {r.name}
            </label>
          ))}
          {allReasons.length === 0 && <span className="muted">No reasons found.</span>}
        </div>
      </div>
      <div className="flex">
        <button className="btn btn-primary" onClick={save} disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}
