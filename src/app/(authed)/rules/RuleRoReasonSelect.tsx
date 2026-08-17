'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { updateRule } from '../actions';

export function RuleRoReasonSelect({
  ruleId,
  currentReasons,
  allReasons,
}: {
  ruleId: number;
  currentReasons: number[];
  allReasons: { id: number; name: string }[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpwards, setOpenUpwards] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number[]>(currentReasons);
  const [pending, startTransition] = useTransition();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setOpenUpwards(rect.bottom > window.innerHeight - 350);
      }
    } else {
      setSearch(''); // clear search when closing
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  function toggle(id: number) {
    const set = new Set(selected);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const newSelected = Array.from(set).sort((a, b) => a - b);
    setSelected(newSelected);
    
    startTransition(async () => {
      try {
        await updateRule(ruleId, { target_ro_reason: newSelected.length > 0 ? newSelected : null });
      } catch (e) {
        alert('Failed to update RO reasons');
        setSelected(currentReasons); // revert on error
      }
    });
  }

  const label = selected.length === 0 ? '—' : selected.join(', ');

  return (
    <div style={{ position: 'relative', display: 'inline-block' }} ref={dropdownRef}>
      <button 
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)} 
        disabled={pending}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '2px 6px',
          fontSize: 12,
          cursor: pending ? 'wait' : 'pointer',
          minWidth: 60,
          textAlign: 'left'
        }}
      >
        {label} {isOpen ? '▲' : '▼'}
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute',
          ...(openUpwards 
              ? { bottom: '100%', marginBottom: 4 } 
              : { top: '100%', marginTop: 4 }),
          right: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          zIndex: 100,
          maxHeight: 300,
          display: 'flex',
          flexDirection: 'column',
          width: 280,
          textAlign: 'left'
        }}>
          <div style={{ padding: '0 8px 8px 8px', position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1, borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
            <input 
              type="text" 
              placeholder="Search reasons..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', padding: '4px 8px', fontSize: 12 }}
            />
          </div>
          <div style={{ overflowY: 'auto', padding: '0 8px', flex: 1 }}>
            {allReasons
              .filter(r => r.name.toLowerCase().includes(search.toLowerCase()) || r.id.toString().includes(search))
              .map((r) => (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 6, marginBottom: 6, fontSize: 12, cursor: 'pointer' }}>
                  <input 
                    type="checkbox" 
                    checked={selected.includes(r.id)}
                    onChange={() => toggle(r.id)}
                    style={{ margin: 0, flexShrink: 0 }}
                    disabled={pending}
                  />
                  <div style={{ flex: 1, lineHeight: '1.3', paddingBottom: 2 }}>
                    <span className="muted" style={{ display: 'inline-block', width: 35 }}>#{r.id}</span>
                    {r.name}
                  </div>
                </label>
              ))}
            {allReasons.filter(r => r.name.toLowerCase().includes(search.toLowerCase()) || r.id.toString().includes(search)).length === 0 && (
              <span className="muted" style={{ padding: '0 8px' }}>No reasons match "{search}".</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
