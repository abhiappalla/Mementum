import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Shield, PauseCircle, Minus, Globe } from 'lucide-react';
import type { Classification, ProcessStatus, BrowserWindow } from '../types';
import type { ProcessGroup } from '../utils/groupProcesses';
import { AppIcon } from './AppIcon';
import { useParallax } from '../hooks/useParallax';
import { api } from '../utils/api';

const BROWSER_CANONICAL: Record<string, string> = {
  'google chrome': 'Google Chrome',
  'chrome':        'Google Chrome',
  'firefox':       'Firefox',
  'safari':        'Safari',
  'arc':           'Arc',
  'brave browser': 'Brave Browser',
  'brave':         'Brave Browser',
  'microsoft edge':'Microsoft Edge',
};

interface Props {
  group: ProcessGroup;
  onReclassify: (cls: string) => void;
  budget: number | null;
  onSetBudget: (limitMb: number) => void;
  compact?: boolean;
  getSuspensionAge?: (name: string) => number | null;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

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

const CHILD_STATUS_LABEL: Record<ProcessStatus, string> = {
  SUSPENDED: 'Paused',
  FOCUSED:   'Focus',
  ACTIVE:    'Active',
  IDLE:      'Idle',
};

const CHILD_STATUS_COLOR: Record<ProcessStatus, string> = {
  SUSPENDED: 'var(--gold)',
  FOCUSED:   'var(--pressure-low)',
  ACTIVE:    'var(--silver)',
  IDLE:      'var(--text-muted)',
};

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      {open
        ? <path d="M1 7 L5 3 L9 7"/>
        : <path d="M1 3 L5 7 L9 3"/>
      }
    </svg>
  );
}

export const ProcessGroupCard = memo(function ProcessGroupCard({ group, onReclassify, budget, onSetBudget, compact = false, getSuspensionAge, cardIndex = 0 }: Props & { cardIndex?: number }) {
  const { ref, onMouseMove, onMouseLeave } = useParallax(2.8);
  const [expanded,       setExpanded]       = useState(false);
  const [showBudgetInput, setShowBudgetInput] = useState(false);
  const [cardRevealed, setCardRevealed] = useState(false);
  const revealedRef = useRef(false);

  // ── Browser window picker ──────────────────────────────────────────────────
  const browserCanonical = BROWSER_CANONICAL[group.baseName.toLowerCase()];
  const isBrowser = !!browserCanonical;
  const [showWindows,     setShowWindows]     = useState(false);
  const [browserWindows,  setBrowserWindows]  = useState<BrowserWindow[] | null>(null);
  const [loadingWindows,  setLoadingWindows]  = useState(false);
  const [windowProtected, setWindowProtected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!showWindows || !isBrowser) return;
    setLoadingWindows(true);
    setBrowserWindows(null);
    api.getBrowserWindows().then(res => {
      if (!res) { setLoadingWindows(false); return; }
      const filtered = res.windows.filter(w => w.browser === browserCanonical);
      setBrowserWindows(filtered);
      const protMap: Record<string, boolean> = {};
      filtered.forEach(w => { protMap[w.title] = w.protected; });
      setWindowProtected(protMap);
    }).catch(() => setBrowserWindows([])).finally(() => setLoadingWindows(false));
  }, [showWindows, browserCanonical, isBrowser]);

  const toggleWindowProtected = useCallback((title: string, nowProtected: boolean) => {
    setWindowProtected(prev => ({ ...prev, [title]: nowProtected }));
    api.setWindowProtected(browserCanonical!, title, nowProtected);
  }, [browserCanonical]);

  const protectedWindowCount = Object.values(windowProtected).filter(Boolean).length;
  const totalWindowCount     = browserWindows?.length ?? 0;
  const windowCountLabel     = browserWindows !== null && totalWindowCount > 0
    ? `${protectedWindowCount} of ${totalWindowCount} protected`
    : 'Windows';

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest('.tab-content') as Element | null;
    const obs  = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !revealedRef.current) {
          revealedRef.current = true;
          setCardRevealed(true);
          obs.disconnect();
        }
      },
      { root, threshold: 0.05, rootMargin: '0px 0px -4% 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref]);
  const [budgetInput,     setBudgetInput]     = useState('');

  const isFullySuspended = group.groupStatus === 'SUSPENDED';
  const isFocused        = group.groupStatus === 'FOCUSED';
  const hasSomePaused    = group.suspendedCount > 0 && !isFullySuspended;
  const isMulti          = group.processes.length > 1;

  const c0 = group.baseName.charCodeAt(0) || 65;
  const c1 = group.baseName.charCodeAt(1) || 82;
  const floatDelay    = `${(c0 % 6) * 0.65}s`;
  const floatDuration = `${3.8 + (c1 % 4) * 0.55}s`;

  const budgetPct   = budget ? Math.min(100, (group.totalMemoryMb / budget) * 100) : 0;
  const budgetLevel = budgetPct > 90 ? 'critical' : budgetPct > 70 ? 'warning' : 'ok';

  function submitBudget() {
    const mb = parseInt(budgetInput, 10);
    if (!isNaN(mb) && mb > 0) {
      onSetBudget(mb);
      setShowBudgetInput(false);
      setBudgetInput('');
    }
  }

  // Status line text
  function statusLine(): string {
    if (isFullySuspended)  return 'All paused';
    if (isFocused)         return 'In Focus';
    const base = group.groupStatus === 'ACTIVE' ? 'Active' : 'Idle';
    if (hasSomePaused)     return `${base} · ${group.suspendedCount} of ${group.processes.length} paused`;
    return base;
  }

  const statusClass = isFullySuspended
    ? 'suspended'
    : isFocused
    ? 'focused'
    : group.groupStatus.toLowerCase();

  return (
    <div
      ref={ref}
      onMouseMove={isFullySuspended ? undefined : onMouseMove}
      onMouseLeave={isFullySuspended ? undefined : onMouseLeave}
      className={[
        'process-card tilt-card',
        cardRevealed     ? 'card-revealed'   : 'card-entering',
        isFullySuspended ? 'suspended' : '',
        isFocused        ? 'focused'   : '',
        compact          ? 'compact'   : '',
      ].join(' ').trim()}
      style={{
        '--float-delay':   floatDelay,
        '--float-dur':     floatDuration,
        '--card-delay':    `${Math.min(cardIndex * 35, 220)}ms`,
      } as React.CSSProperties}
    >
      {/* ── Header ── */}
      <div className="process-header">
        <div className="process-icon-wrap">
          <AppIcon
            name={group.baseName}
            status={isFullySuspended ? 'SUSPENDED' : isFocused ? 'FOCUSED' : 'IDLE'}
            classification={group.classification}
          />
        </div>

        <div className="process-name-wrap">
          <div className="process-name-row">
            <div className="process-name">{group.displayName}</div>
            {group.hasLeak && (
              <div
                className="leak-dot"
                title="Possible memory leak — one or more processes in this group have grown 50%+ in 30 minutes"
                aria-label="Memory leak detected"
                role="img"
              />
            )}
          </div>
          <div className={`process-status-text ${statusClass}`}>{statusLine()}</div>
        </div>

        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="process-memory">{fmtMb(group.totalMemoryMb)}</div>
          <div className="process-memory-label">
            {isMulti
              ? `${group.processes.length} proc · ${group.totalCpu.toFixed(0)}% cpu`
              : `${group.totalCpu.toFixed(1)}% cpu`}
          </div>
          {isFullySuspended && (() => {
            const compressionMb = group.processes.reduce((s, p) => {
              const v = p.compression_savings_mb;
              return s + (Number.isFinite(v) ? (v as number) : 0);
            }, 0);
            const ageMs = getSuspensionAge ? group.processes.reduce<number | null>((min, p) => {
              const a = getSuspensionAge(p.name);
              if (a === null) return min;
              return min === null ? a : Math.max(min, a);
            }, null) : null;
            const isCompressing = compressionMb === 0 && ageMs !== null && ageMs < 10_000;
            if (isCompressing) {
              return <div className="proc-cmp-row proc-cmp-compressing">Compressing…</div>;
            }
            if (compressionMb > 0) {
              return (
                <div className="proc-cmp-row proc-cmp-saved">
                  −{fmtMb(compressionMb)} compressed
                </div>
              );
            }
            return <div className="proc-cmp-row proc-cmp-minimal">Minimal compression</div>;
          })()}
        </div>
      </div>

      {/* ── Budget progress bar ── */}
      {budget !== null && (
        <div className="budget-bar-wrap" title={`${fmtMb(group.totalMemoryMb)} of ${fmtMb(budget)} budget`}>
          <div
            className={`budget-bar budget-bar--${budgetLevel}`}
            style={{ width: `${budgetPct}%` }}
          />
        </div>
      )}

      {/* ── Segmented control ── */}
      <div className="seg-control">
        {(['PROTECTED', 'NEUTRAL', 'EVICTABLE'] as Classification[]).map(cls => (
          <button
            key={cls}
            className={`seg-btn${group.classification === cls ? ` ${SEG_CLASSES[cls]}` : ''}`}
            onClick={() => group.classification !== cls && onReclassify(cls)}
          >
            {SEG_ICON_EL[cls]}{cls.charAt(0) + cls.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {/* ── Browser window picker ── */}
      {isBrowser && showWindows && (
        <div className="bw-section">
          <p className="bw-hint">Protected windows keep this browser from being paused while they're in focus.</p>
          {loadingWindows ? (
            <div className="bw-empty">Loading windows…</div>
          ) : !browserWindows || browserWindows.length === 0 ? (
            <div className="bw-empty">No open windows found</div>
          ) : (
            browserWindows.map(w => {
              const checked = !!windowProtected[w.title];
              return (
                <div
                  key={w.title}
                  className={`bw-row${checked ? ' bw-row-checked' : ''}`}
                  onClick={() => toggleWindowProtected(w.title, !checked)}
                >
                  <span className={`bw-cb${checked ? ' bw-cb-checked' : ''}`}>
                    {checked && (
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                        <path d="M1 4L3.5 6.5L7 1.5" stroke="#D4AF37" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </span>
                  <span className="bw-title" title={w.title}>
                    {w.title.length > 40 ? w.title.slice(0, 40) + '…' : w.title}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Budget + expand footer ── */}
      <div className="process-card-footer">
        {/* Budget */}
        {showBudgetInput ? (
          <div className="budget-input-row" style={{ flex: 1 }}>
            <input
              className="budget-input"
              type="number"
              min="1"
              placeholder="MB limit"
              value={budgetInput}
              onChange={e => setBudgetInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter')  submitBudget();
                if (e.key === 'Escape') { setShowBudgetInput(false); setBudgetInput(''); }
              }}
              autoFocus
            />
            <button className="btn-budget-set"    onClick={submitBudget}>Set</button>
            <button className="btn-budget-cancel" onClick={() => { setShowBudgetInput(false); setBudgetInput(''); }}>✕</button>
          </div>
        ) : (
          <div className="budget-footer" style={{ flex: 1 }}>
            {budget !== null && (
              <span className="budget-usage-text">{fmtMb(group.totalMemoryMb)} / {fmtMb(budget)}</span>
            )}
            <button
              className="btn-set-budget"
              onClick={() => { setShowBudgetInput(true); setBudgetInput(budget ? String(budget) : ''); }}
            >
              {budget !== null ? 'Edit Budget' : 'Set Budget'}
            </button>
          </div>
        )}

        {/* Browser window picker toggle */}
        {isBrowser && (
          <button
            className={`bw-toggle${showWindows ? ' bw-toggle-active' : ''}`}
            onClick={() => setShowWindows(v => !v)}
            title="Protected browser windows"
          >
            <Globe size={10} strokeWidth={1.5} />
            <span>{windowCountLabel}</span>
            <ChevronIcon open={showWindows} />
          </button>
        )}

        {/* Expand toggle (only for multi-process groups) */}
        {isMulti && (
          <button
            className="expand-toggle"
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse process list' : 'Expand process list'}
          >
            <ChevronIcon open={expanded} />
            <span>{expanded ? 'Hide' : `${group.processes.length}`}</span>
          </button>
        )}
      </div>

      {/* ── Expanded child process list ── */}
      {expanded && (
        <div className="process-children">
          {[...group.processes]
            .sort((a, b) => b.memory_mb - a.memory_mb)
            .map(p => (
              <div key={p.name + p.pid} className="process-child-row">
                <div className="process-child-name" title={p.name}>
                  {p.name.length > 32 ? p.name.slice(0, 30) + '…' : p.name}
                </div>
                <div className="process-child-right">
                  {p.leak_detected && <span className="leak-dot leak-dot--sm" title="Possible memory leak" />}
                  <span className="process-child-mem">{fmtMb(p.memory_mb)}</span>
                  <span
                    className="process-child-status"
                    style={{ color: CHILD_STATUS_COLOR[p.status] }}
                  >
                    {CHILD_STATUS_LABEL[p.status]}
                  </span>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
});
