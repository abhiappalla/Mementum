import { useState, useCallback, useEffect, useRef } from 'react';
import { ProcessGroupCard } from './ProcessGroupCard';
import { AppIcon } from './AppIcon';
import { LayoutToggle, LayoutMode, getLayoutPref, setLayoutPref } from './LayoutToggle';
import { groupProcesses } from '../utils/groupProcesses';
import type { DaemonHook } from '../hooks/useDaemon';
import type { Classification } from '../types';
import type { ProcessGroup } from '../utils/groupProcesses';

export const COUNT_OPTIONS = [10, 20, 30, 50, 'all'] as const;
export type CountOption = typeof COUNT_OPTIONS[number];

interface Props {
  daemon: DaemonHook;
  processLimit: CountOption;
  onLimitChange: (v: CountOption) => void;
  showSystemProcesses?: boolean;
  groupChildProcesses?: boolean;
}

type Filter = 'ALL' | Classification;

const FILTER_LABELS: { key: Filter; label: string }[] = [
  { key: 'ALL',       label: 'All' },
  { key: 'PROTECTED', label: 'Protected' },
  { key: 'NEUTRAL',   label: 'Neutral' },
  { key: 'EVICTABLE', label: 'Evictable' },
];

function fmtMb(mb: number) { return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`; }

const CLS_ORDER: Classification[] = ['PROTECTED', 'NEUTRAL', 'EVICTABLE'];
const CLS_LABEL: Record<Classification, string> = {
  PROTECTED: 'Protected', NEUTRAL: 'Neutral', EVICTABLE: 'Evictable',
};
const CLS_PILL: Record<Classification, string> = {
  PROTECTED: 'pill-protected', NEUTRAL: 'pill-neutral', EVICTABLE: 'pill-evictable',
};
const STATUS_LABEL: Record<string, string> = {
  SUSPENDED: 'Suspended', FOCUSED: 'Focused', ACTIVE: 'Active', IDLE: 'Idle',
};

function ProcessListRow({ group, onReclassify, justSuspended }: {
  group: ProcessGroup;
  onReclassify: (cls: string) => void;
  justSuspended?: boolean;
}) {
  const cls = group.classification;
  const sus = group.groupStatus === 'SUSPENDED';
  const focused = group.groupStatus === 'FOCUSED';

  const cycleClass = () => {
    const next = CLS_ORDER[(CLS_ORDER.indexOf(cls) + 1) % CLS_ORDER.length];
    onReclassify(next.toLowerCase());
  };

  return (
    <div className={`proc-list-row${sus ? ' proc-row-suspended' : ''}${focused ? ' proc-row-focused' : ''}${justSuspended ? ' proc-row-freeze' : ''}`}>
      <div className="proc-list-icon">
        <AppIcon name={group.baseName} status={group.groupStatus} classification={cls} />
      </div>
      <div className="proc-list-name">
        <span className="proc-list-title">{group.baseName.charAt(0).toUpperCase() + group.baseName.slice(1)}</span>
        {group.processes.length > 1 && (
          <span className="proc-list-sub">{group.processes.length} processes</span>
        )}
      </div>
      <div className="proc-list-mem">{fmtMb(group.totalMemoryMb)}</div>
      <div className="proc-list-cpu">{group.totalCpu > 0 ? `${group.totalCpu.toFixed(1)}%` : '—'}</div>
      <div className="proc-list-cls">
        <button className={`proc-cls-pill ${CLS_PILL[cls]}`} onClick={cycleClass} title="Click to cycle classification">
          {CLS_LABEL[cls]}
        </button>
      </div>
      <div className="proc-list-status">
        <span className={`proc-status-dot proc-status-${group.groupStatus.toLowerCase()}`} />
        {STATUS_LABEL[group.groupStatus] ?? group.groupStatus}
      </div>
    </div>
  );
}

export function ProcessList({
  daemon, processLimit, onLimitChange,
  showSystemProcesses = false, groupChildProcesses = true,
}: Props) {
  const { status, setOverride, setBudget, getSuspensionAge } = daemon;
  const [filter,  setFilter]        = useState<Filter>('ALL');
  const [layout,  setLayout]        = useState<LayoutMode>(() => getLayoutPref('processes', 'grid'));
  const [budgets, setBudgets]       = useState<Record<string, number>>({});
  const [justSuspended, setJustSus] = useState<Set<string>>(new Set());
  const prevStatuses = useRef<Map<string, string>>(new Map());

  // ── Optimistic classification overrides ──────────────────────────────────
  // Keys are baseName.toLowerCase(), values are Classification strings.
  // These take precedence over daemon state for 5s to avoid race conditions.
  const [localCls, setLocalCls] = useState<Record<string, Classification>>({});
  const clearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleReclassify = useCallback((baseName: string, nextCls: Classification, processNames: string[]) => {
    // Immediately apply optimistic update
    const key = baseName.toLowerCase();
    setLocalCls(prev => ({ ...prev, [key]: nextCls }));

    // Cancel any pending clear for this key
    const existing = clearTimers.current.get(key);
    if (existing) clearTimeout(existing);

    // Send to daemon for each process in the group
    Promise.all(processNames.map(n => setOverride(n, nextCls.toLowerCase())))
      .catch(() => {
        // Revert on error
        setLocalCls(prev => { const n = { ...prev }; delete n[key]; return n; });
      });

    // Clear optimistic override after 5s (daemon will have updated by then)
    const t = setTimeout(() => {
      setLocalCls(prev => { const n = { ...prev }; delete n[key]; return n; });
      clearTimers.current.delete(key);
    }, 5000);
    clearTimers.current.set(key, t);
  }, [setOverride]);

  const handleSetBudget = useCallback((baseName: string, limitMb: number) => {
    setBudgets(b => ({ ...b, [baseName]: limitMb }));
    setBudget(baseName, limitMb);
  }, [setBudget]);

  const handleLayout   = (m: LayoutMode) => { setLayout(m); setLayoutPref('processes', m); };
  const handleLimit    = (c: CountOption) => {
    onLimitChange(c);
    // Immediately fetch with new limit
    setTimeout(() => daemon.pollNow(), 0);
  };

  // Detect newly suspended processes to trigger freeze-wave animation
  useEffect(() => {
    if (!status) return;
    const groups = groupProcesses(status.processes, { groupChildren: groupChildProcesses, hideSystemProcesses: !showSystemProcesses });
    const newlySus: string[] = [];
    groups.forEach(g => {
      const prev = prevStatuses.current.get(g.baseName);
      if (prev && prev !== 'SUSPENDED' && g.groupStatus === 'SUSPENDED') newlySus.push(g.baseName);
      prevStatuses.current.set(g.baseName, g.groupStatus);
    });
    if (newlySus.length === 0) return;
    setJustSus(prev => { const s = new Set(prev); newlySus.forEach(n => s.add(n)); return s; });
    const t = setTimeout(() => {
      setJustSus(prev => { const s = new Set(prev); newlySus.forEach(n => s.delete(n)); return s; });
    }, 700);
    return () => clearTimeout(t);
  }, [status, groupChildProcesses, showSystemProcesses]);

  if (!status) return null;

  const rawGroups  = groupProcesses(status.processes, {
    groupChildren: groupChildProcesses,
    hideSystemProcesses: !showSystemProcesses,
  });
  // Apply optimistic local overrides so UI reflects clicks immediately
  const allGroups  = rawGroups.map(g => {
    const key = g.baseName.toLowerCase();
    return key in localCls ? { ...g, classification: localCls[key] } : g;
  });
  const filtered   = filter === 'ALL' ? allGroups : allGroups.filter(g => g.classification === filter);
  const totalCount = status.total_process_count ?? status.processes.length;

  return (
    <div className="view">
      {/* ── Top bar ── */}
      <div className="proc-toolbar">
        <span className="section-title">
          {allGroups.length} {allGroups.length === 1 ? 'App' : 'Apps'}
          <span style={{ color: 'var(--text-muted)', fontWeight: 400, letterSpacing: 0 }}>
            {' '}·{' '}
            {processLimit === 'all'
              ? `${totalCount} processes`
              : `${status.processes.length} of ${totalCount}`}
          </span>
        </span>

        <div className="proc-toolbar-right">
          <div className="proc-count-wrap">
            <span className="proc-count-label">Show</span>
            <select className="proc-count-select" value={String(processLimit)}
              onChange={e => handleLimit(e.target.value === 'all' ? 'all' : +e.target.value as CountOption)}>
              {COUNT_OPTIONS.map(o => (
                <option key={String(o)} value={String(o)}>
                  {o === 'all' ? 'All' : o}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 3 }}>
            {FILTER_LABELS.map(({ key, label }) => (
              <button key={key}
                className={`nav-tab${filter === key ? ' active' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>

          <LayoutToggle value={layout} onChange={handleLayout} />
        </div>
      </div>

      {/* ── Content ── */}
      {filtered.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
          No apps in this category
        </div>
      ) : layout === 'list' ? (
        <div className="proc-list-view">
          <div className="proc-list-header">
            <span className="proc-list-h-icon" />
            <span className="proc-list-h-name">App</span>
            <span className="proc-list-h-mem">Memory</span>
            <span className="proc-list-h-cpu">CPU</span>
            <span className="proc-list-h-cls">Class</span>
            <span className="proc-list-h-status">Status</span>
          </div>
          {filtered.map(group => (
            <ProcessListRow key={group.baseName} group={group}
              onReclassify={cls => handleReclassify(group.baseName, cls as Classification, group.processes.map(p => p.name))}
              justSuspended={justSuspended.has(group.baseName)} />
          ))}
        </div>
      ) : (
        <div className={`process-grid${layout === 'compact' ? ' compact-grid' : ''}`}>
          {filtered.map((group, idx) => (
            <ProcessGroupCard
              key={group.baseName}
              group={group}
              onReclassify={cls => handleReclassify(group.baseName, cls as Classification, group.processes.map(p => p.name))}
              budget={budgets[group.baseName] ?? null}
              onSetBudget={limitMb => handleSetBudget(group.baseName, limitMb)}
              compact={layout === 'compact'}
              getSuspensionAge={getSuspensionAge}
              cardIndex={idx}
            />
          ))}
        </div>
      )}

      {/* ── Footer ── */}
      {status.processes.length > 0 && (
        <div className="proc-footer-line">
          Showing {status.processes.length} of {totalCount} processes
          {status.app_mb != null && Number.isFinite(status.app_mb) && status.app_mb > 0
            ? ` · ${fmtMb(status.app_mb)} total across all processes`
            : ''}
        </div>
      )}
    </div>
  );
}
