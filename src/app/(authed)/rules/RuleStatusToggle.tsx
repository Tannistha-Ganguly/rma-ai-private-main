'use client';

import { useTransition } from 'react';
import { setRuleStatus } from '../actions';

export function RuleStatusToggle({
  ruleId,
  currentStatus,
}: {
  ruleId: number;
  currentStatus: 'active' | 'disabled' | 'proposed';
}) {
  const [pending, startTransition] = useTransition();
  const isOn = currentStatus === 'active';

  function flip() {
    const next: 'active' | 'disabled' = isOn ? 'disabled' : 'active';
    startTransition(async () => {
      try {
        await setRuleStatus(ruleId, next);
      } catch (e) {
        alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: pending ? 'wait' : 'pointer',
        opacity: pending ? 0.6 : 1,
      }}
      title={isOn ? 'Disable this rule' : 'Enable this rule'}
    >
      <span
        style={{
          position: 'relative',
          width: 32,
          height: 18,
          background: isOn ? 'var(--success)' : '#d1d5db',
          borderRadius: 999,
          transition: 'background 0.15s',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: isOn ? 16 : 2,
            width: 14,
            height: 14,
            background: 'white',
            borderRadius: '50%',
            transition: 'left 0.15s',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }}
        />
      </span>
      <input
        type="checkbox"
        checked={isOn}
        disabled={pending}
        onChange={flip}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
      />
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        {isOn ? 'Enabled' : currentStatus === 'proposed' ? 'Proposed' : 'Disabled'}
      </span>
    </label>
  );
}
