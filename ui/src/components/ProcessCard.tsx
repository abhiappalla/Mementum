import React, { useState } from 'react';
import { Shield, PauseCircle, Minus } from 'lucide-react';
import type { Process, Classification } from '../types';
import { AppIcon } from './AppIcon';
import { useParallax } from '../hooks/useParallax';

interface Props {
  process: Process;
  onReclassify: (name: string, cls: string) => void;
  budget: number | null;
  onSetBudget: (name: string, limitMb: number) => void;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const STATUS_LABEL: Record<string, string> = {
  SUSPENDED: 'Paused',
  FOCUSED:   'In Focus',
  ACTIVE:    'Active',
  IDLE:      'Idle',
};

const SEG_CLASSES: Record<Classification, string> = {
  PROTECTED: 'active-protected',
  NEUTRAL:   'active-neutral',
  EVICTABLE: 'active-evictable',
};

const SEG_ICON_EL: Record<Classification, React.ReactElement> = {
  PROTECTED: <Shield    size={11} strokeWidth={1.5} />,
  NEUTRAL:   <Minus     size={11} strokeWidth={1.5} />,
  EVICTABLE: <PauseCircle size={11} strokeWidth={1.5} />,
};

export function ProcessCard({ process, onReclassify, budget, onSetBudget }: Props) {
  const { ref, onMouseMove, onMouseLeave } = useParallax(2.8);
  const [showBudgetInput, setShowBudgetInput] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');

  const statusClass  = process.status.toLowerCase();
  const isSuspended  = process.status === 'SUSPENDED';
  const isFocused    = process.status === 'FOCUSED';

  const c0 = process.name.charCodeAt(0) ?? 65;
  const c1 = process.name.charCodeAt(1) ?? 82;
  const floatDelay    = `${(c0 % 6) * 0.65}s`;
  const floatDuration = `${3.8 + (c1 % 4) * 0.55}s`;

  // Budget bar state
  const budgetPct  = budget ? Math.min(100, (process.memory_mb / budget) * 100) : 0;
  const budgetLevel = budgetPct > 90 ? 'critical' : budgetPct > 70 ? 'warning' : 'ok';

  function submitBudget() {
    const mb = parseInt(budgetInput, 10);
    if (!isNaN(mb) && mb > 0) {
      onSetBudget(process.name, mb);
      setShowBudgetInput(false);
      setBudgetInput('');
    }
  }

  return (
    <div
      ref={ref}
      onMouseMove={isSuspended ? undefined : onMouseMove}
      onMouseLeave={isSuspended ? undefined : onMouseLeave}
      className={[
        'process-card',
        isSuspended ? 'suspended' : '',
        isFocused   ? 'focused'   : '',
      ].join(' ').trim()}
      style={{
        '--float-delay': floatDelay,
        '--float-dur':   floatDuration,
      } as React.CSSProperties}
    >
      <div className="process-header">
        <div className="process-icon-wrap">
          <AppIcon
            name={process.name}
            status={process.status}
            classification={process.classification}
          />
        </div>

        <div className="process-name-wrap">
          <div className="process-name-row">
            <div className="process-name">
              {process.name.charAt(0).toUpperCase() + process.name.slice(1)}
            </div>
            {process.leak_detected && (
              <div
                className="leak-dot"
                title="Possible memory leak — this process has grown 50%+ in 30 minutes"
                aria-label="Memory leak detected"
                role="img"
              />
            )}
          </div>
          <div className={`process-status-text ${statusClass}`}>
            {STATUS_LABEL[process.status] ?? process.status}
          </div>
        </div>

        <div>
          <div className="process-memory">{fmtMb(process.memory_mb)}</div>
          <div className="process-memory-label">{process.cpu_percent.toFixed(1)}% cpu</div>
        </div>
      </div>

      {/* Budget progress bar */}
      {budget !== null && (
        <div className="budget-bar-wrap" title={`${fmtMb(process.memory_mb)} of ${fmtMb(budget)} budget`}>
          <div
            className={`budget-bar budget-bar--${budgetLevel}`}
            style={{ width: `${budgetPct}%` }}
          />
        </div>
      )}

      <div className="seg-control">
        {(['PROTECTED', 'NEUTRAL', 'EVICTABLE'] as Classification[]).map(cls => (
          <button
            key={cls}
            className={`seg-btn${process.classification === cls ? ` ${SEG_CLASSES[cls]}` : ''}`}
            onClick={() => process.classification !== cls && onReclassify(process.name, cls)}
          >
            {SEG_ICON_EL[cls]}
            {cls.charAt(0) + cls.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {/* Budget section */}
      {showBudgetInput ? (
        <div className="budget-input-row">
          <input
            className="budget-input"
            type="number"
            min="1"
            placeholder="MB limit"
            value={budgetInput}
            onChange={e => setBudgetInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitBudget(); if (e.key === 'Escape') setShowBudgetInput(false); }}
            autoFocus
          />
          <button className="btn-budget-set" onClick={submitBudget}>Set</button>
          <button className="btn-budget-cancel" onClick={() => { setShowBudgetInput(false); setBudgetInput(''); }}>✕</button>
        </div>
      ) : (
        <div className="budget-footer">
          {budget !== null && (
            <span className="budget-usage-text">
              {fmtMb(process.memory_mb)} / {fmtMb(budget)}
            </span>
          )}
          <button
            className="btn-set-budget"
            onClick={() => { setShowBudgetInput(true); setBudgetInput(budget ? String(budget) : ''); }}
          >
            {budget !== null ? 'Edit Budget' : 'Set Budget'}
          </button>
        </div>
      )}
    </div>
  );
}
