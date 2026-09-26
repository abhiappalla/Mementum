import React, { useState, useRef, useEffect } from 'react';
import { Battery2DCanvas }   from './Battery2D';
import { MagneticButton }    from './MagneticButton';
import { Zap, Target, StopCircle, Trash2, HardDrive, Clock } from 'lucide-react';
import type { DaemonHook }   from '../hooks/useDaemon';
import type { Process, CompressionInterval, CompressionSnapshot, DaemonStatus } from '../types';
import { api } from '../utils/api';
import { groupProcesses } from '../utils/groupProcesses';
import { AppIcon } from './AppIcon';

function useTypewriter(text: string, speed = 18): string {
  const [displayed, setDisplayed] = useState(text);
  useEffect(() => {
    setDisplayed('');
    let i = 0;
    const timer = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) clearInterval(timer);
    }, speed);
    return () => clearInterval(timer);
  }, [text, speed]);
  return displayed;
}

interface Props {
  daemon:           DaemonHook;
  batterySpeed?:    'calm' | 'normal' | 'intense';
  scrollVelocity?:  number;
  onNavigate?:      (view: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// Safe formatter for compression_savings_mb — guards against undefined/null/NaN/0
function formatCompression(mb?: number | null): string {
  if (mb === undefined || mb === null || !Number.isFinite(mb) || mb <= 0) return '0 MB';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 5)    return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}


function formatFocusDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  return m > 0 ? `${m} min` : `${secs}s`;
}

// ── Animated counter ──────────────────────────────────────────────────────────
// Coerce any non-finite value to 0 so NaN never enters animated state
function safeNum(n: number): number { return Number.isFinite(n) ? n : 0; }

function useAnimated(target: number, ms = 400): number {
  const safe  = safeNum(target);
  const [val, setVal]   = React.useState(safe);
  const fromRef = useRef(safe);
  const rafRef  = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (Math.abs(safe - from) < 0.005) return;
    cancelAnimationFrame(rafRef.current);
    const t0 = performance.now();
    const tick = (now: number) => {
      const p    = Math.min((now - t0) / ms, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setVal(from + (safe - from) * ease);
      if (p < 1) { rafRef.current = requestAnimationFrame(tick); }
      else        { fromRef.current = safe; setVal(safe); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [safe, ms]);

  return val;
}

// Flash briefly when a value changes
function useFlash(target: number): boolean {
  const safe = safeNum(target);
  const [flashing, setFlashing] = React.useState(false);
  const prevRef  = useRef(safe);
  const timerRef = useRef(0);
  useEffect(() => {
    if (Math.abs(safe - prevRef.current) < 0.01) return;
    prevRef.current = safe;
    setFlashing(true);
    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setFlashing(false), 350);
    return () => clearTimeout(timerRef.current);
  }, [safe]);
  return flashing;
}

// ── Focus banner ──────────────────────────────────────────────────────────────
function FocusBanner({ processName, durationSecs, freedMb, onEnd }: {
  processName: string; durationSecs: number; freedMb: number; onEnd: () => void;
}) {
  const name = processName.charAt(0).toUpperCase() + processName.slice(1);
  return (
    <div className="focus-banner">
      <div className="focus-banner-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="6.5"/>
          <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>
          <line x1="8" y1="1" x2="8" y2="3.2"/><line x1="8" y1="12.8" x2="8" y2="15"/>
          <line x1="1" y1="8" x2="3.2" y2="8"/><line x1="12.8" y1="8" x2="15" y2="8"/>
        </svg>
      </div>
      <div className="focus-banner-text">
        <div className="focus-banner-name">Focus: {name}</div>
        <div className="focus-banner-meta">
          {formatFocusDuration(durationSecs)}
          {freedMb > 0 && <> &middot; {fmtMb(freedMb)} freed</>}
        </div>
      </div>
      <button className="focus-end-btn" onClick={onEnd}>End Session</button>
    </div>
  );
}

// ── Focus picker ──────────────────────────────────────────────────────────────
function FocusPicker({ processes, onSelect, onClose }: {
  processes: Process[]; onSelect: (n: string) => void; onClose: () => void;
}) {
  const ref    = useRef<HTMLDivElement>(null);
  const groups = groupProcesses(processes, { groupChildren: true, hideSystemProcesses: true });

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  function classPill(cls: string) {
    const map: Record<string, string> = {
      PROTECTED: 'focus-picker-pill--protected',
      EVICTABLE: 'focus-picker-pill--evictable',
      NEUTRAL:   'focus-picker-pill--neutral',
    };
    const label = cls.charAt(0) + cls.slice(1).toLowerCase();
    return <span className={`focus-picker-pill ${map[cls] ?? ''}`}>{label}</span>;
  }

  return (
    <div className="focus-picker" ref={ref} role="listbox" aria-label="Choose app to protect">
      <div className="focus-picker-header">Choose an app to protect</div>
      {groups.length === 0 ? (
        <div className="focus-picker-empty">No processes running</div>
      ) : (
        groups.map(g => (
          <button key={g.baseName} className="focus-picker-item" role="option"
            onClick={() => { onSelect(g.processes[0].name); onClose(); }}>
            <span className="focus-picker-icon-wrap">
              <AppIcon name={g.baseName} status={g.groupStatus} classification={g.classification} />
            </span>
            <span className="focus-picker-name">{g.displayName}</span>
            <span className="focus-picker-mem">{fmtMb(g.totalMemoryMb)}</span>
            {classPill(g.classification)}
          </button>
        ))
      )}
    </div>
  );
}


// ── Compression Analytics ─────────────────────────────────────────────────────
const BAR_COLORS: Record<number, string> = {
  1:   'rgba(192,192,192,0.80)',
  5:   'rgba(212,175,55,0.55)',
  10:  'rgba(212,175,55,0.65)',
  15:  'rgba(212,175,55,0.78)',
  30:  'rgba(212,175,55,1.00)',
  60:  'rgba(246,226,122,0.90)',
  120: 'rgba(246,226,122,1.00)',
  300: '#ffffff',
};

function barColor(intervalSecs: number): string {
  return BAR_COLORS[intervalSecs] ?? 'rgba(212,175,55,0.70)';
}

function fmtInterval(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${secs / 60}m`;
}

interface StoredSnapshot { seconds: number; savings_mb: number; frozen_mb: number; pct: number; }

function CompressionBar({ bar, maxMb, visible }: {
  bar: CompressionInterval; maxMb: number; visible: boolean;
}) {
  const heightPct = maxMb > 0 ? (bar.savings_mb / maxMb) * 100 : 0;
  const isMeasuring = bar.savings_mb === 0 && bar.interval_secs >= 60;
  const color = barColor(bar.interval_secs);

  return (
    <div className="cmp-bar-col">
      <div className="cmp-bar-val" style={{ color: bar.savings_mb > 0 ? color : 'var(--text-faint)' }}>
        {isMeasuring ? '…' : bar.savings_mb > 0 ? fmtMb(bar.savings_mb) : '—'}
      </div>
      <div className="cmp-bar-track">
        <div
          className={`cmp-bar-fill${isMeasuring ? ' measuring' : ''}`}
          style={{
            height: visible ? `${Math.max(heightPct, bar.savings_mb > 0 ? 4 : 0)}%` : '0%',
            background: color,
            transitionDelay: visible ? '50ms' : '0ms',
          }}
        />
      </div>
      <div className="cmp-bar-label">{fmtInterval(bar.interval_secs)}</div>
    </div>
  );
}

function CompressionAnalytics({ timeline, suspendedCount, compressionTotal }: {
  timeline: CompressionInterval[];
  suspendedCount: number;
  compressionTotal: number;
}) {
  const [snapshotSecs, setSnapshotSecs] = useState(45);
  const [snapLoading,  setSnapLoading]  = useState(false);
  const [snapResult,   setSnapResult]   = useState<CompressionSnapshot | null>(null);
  const [snapHistory,  setSnapHistory]  = useState<StoredSnapshot[]>([]);
  const [tooltipOpen,  setTooltipOpen]  = useState(false);
  const [visible,      setVisible]      = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Animate bars in on mount / when data changes
  useEffect(() => {
    setVisible(false);
    const id = setTimeout(() => setVisible(true), 40);
    return () => clearTimeout(id);
  }, [timeline.length]);

  useEffect(() => {
    if (!tooltipOpen) return;
    const h = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) setTooltipOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [tooltipOpen]);

  const handleSnapshot = async () => {
    if (snapLoading) return;
    setSnapLoading(true);
    const result = await api.getCompressionSnapshot(snapshotSecs);
    setSnapLoading(false);
    if (!result) return;
    setSnapResult(result);
    setSnapHistory(h => [result as StoredSnapshot, ...h].slice(0, 5));
  };

  if (suspendedCount === 0) return null;

  const maxMb = timeline.length ? Math.max(...timeline.map(b => b.savings_mb), 1) : 1;
  const suspendedProcessCount = suspendedCount;

  return (
    <div className="compression-card tilt-card">
      {/* Header */}
      <div className="cmp-header">
        <span className="section-title">Memory Compression Timeline</span>
        <div className="cmp-info-wrap" ref={tooltipRef}>
          <button className="cmp-info-btn" onClick={() => setTooltipOpen(o => !o)} aria-label="About compression">
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="6"/>
              <line x1="7" y1="6.5" x2="7" y2="10"/>
              <circle cx="7" cy="4.5" r="0.7" fill="currentColor" stroke="none"/>
            </svg>
          </button>
          {tooltipOpen && (
            <div className="cmp-tooltip">
              After MEMentum freezes idle apps, macOS compresses their memory pages automatically. This chart shows how much memory macOS has compressed at different time intervals after suspension.
            </div>
          )}
        </div>
      </div>

      {/* Bar chart */}
      {timeline.length === 0 ? (
        <div className="cmp-empty">Waiting for compression data from daemon…</div>
      ) : (
        <div className="cmp-chart">
          {timeline.map(bar => (
            <CompressionBar
              key={bar.interval_secs}
              bar={bar}
              maxMb={maxMb}
              visible={visible}
            />
          ))}
        </div>
      )}

      {/* Summary */}
      <div className="cmp-summary">
        <span className="cmp-summary-val">{formatCompression(compressionTotal)}</span>
        <span className="cmp-summary-label"> total compressed across </span>
        <span className="cmp-summary-val">{suspendedProcessCount}</span>
        <span className="cmp-summary-label"> {suspendedProcessCount === 1 ? 'process' : 'processes'}</span>
      </div>

      <div className="cmp-divider" />

      {/* Custom snapshot */}
      <div className="cmp-custom">
        <span className="cmp-custom-label">Custom snapshot at</span>
        <input
          type="number" min="1" max="300"
          className="cmp-custom-input"
          value={snapshotSecs}
          onChange={e => setSnapshotSecs(Math.max(1, Math.min(300, Number(e.target.value))))}
          onKeyDown={e => e.key === 'Enter' && handleSnapshot()}
        />
        <span className="cmp-custom-unit">s</span>
        <button
          className={`cmp-check-btn${snapLoading ? ' loading' : ''}`}
          onClick={handleSnapshot}
          disabled={snapLoading}
        >
          {snapLoading ? '…' : 'Check'}
        </button>
      </div>

      {/* Latest snapshot result */}
      {snapResult && (
        <div className="cmp-snap-result">
          At {snapResult.seconds}s: <span className="cmp-snap-val">{formatCompression(snapResult.savings_mb)} compressed</span>
          {snapResult.frozen_mb > 0 && (
            <span className="cmp-snap-pct"> ({snapResult.pct.toFixed(0)}% of frozen memory)</span>
          )}
        </div>
      )}

      {/* Snapshot history */}
      {snapHistory.length > 1 && (
        <div className="cmp-snap-history">
          {snapHistory.slice(1).map((s, i) => (
            <div key={i} className="cmp-snap-hist-item">
              <span className="cmp-snap-hist-label">At {s.seconds}s: {fmtMb(s.savings_mb)} ({s.pct.toFixed(0)}%)</span>
              <div className="cmp-snap-hist-bar-track">
                <div className="cmp-snap-hist-bar" style={{ width: `${Math.min(s.pct, 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Memory Breakdown ─────────────────────────────────────────────────────────

const BREAKDOWN_ROWS: {
  key: 'app_mb' | 'compressed_mb' | 'wired_mb' | 'cached_mb';
  label: string;
  color: string;
  tip: string;
}[] = [
  {
    key: 'app_mb',
    label: 'Apps',
    color: '#D4AF37',
    tip: "Memory used by your running applications. This is what MEMentum can free.",
  },
  {
    key: 'compressed_mb',
    label: 'Compressed',
    color: '#8A6D1F',
    tip: "Memory macOS has compressed to save space. Mostly from apps MEMentum paused.",
  },
  {
    key: 'wired_mb',
    label: 'System',
    color: '#555555',
    tip: "Kernel and driver memory. Cannot be freed by any software.",
  },
  {
    key: 'cached_mb',
    label: 'Cache',
    color: '#3a3a3a',
    tip: "Recently used files kept in memory for speed. macOS frees this instantly when needed — it’s effectively available.",
  },
];

function safeVal(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return fmtMb(n);
}

function MemoryBreakdown({ status }: { status: DaemonStatus }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('mem-breakdown-open') === 'true'; } catch { return false; }
  });
  const [hovered, setHovered] = useState<string | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem('mem-breakdown-open', String(next)); } catch {}
  };

  const totalMb = (status.total_ram_gb ?? 0) * 1024;

  const pct = (n?: number): number => {
    if (n == null || !Number.isFinite(n) || totalMb === 0) return 0;
    return Math.max(0, Math.min(100, (n / totalMb) * 100));
  };

  return (
    <div className="mem-breakdown">
      <button className="mem-breakdown-toggle" onClick={toggle} aria-expanded={open}>
        <span>Memory breakdown</span>
        <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"
          style={{ transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'none' }}>
          <path d="M1 3 L5 7 L9 3"/>
        </svg>
      </button>

      {open && (
        <div className="mem-breakdown-body">
          {/* Stacked bar */}
          <div className="mem-bar" role="img" aria-label="Memory breakdown bar">
            {BREAKDOWN_ROWS.map(r => (
              <div
                key={r.key}
                className="mem-bar-seg"
                style={{ width: `${pct(status[r.key])}%`, background: r.color }}
              />
            ))}
          </div>

          {/* Rows */}
          {BREAKDOWN_ROWS.map(r => (
            <div
              key={r.key}
              className="mem-row"
              onMouseEnter={() => setHovered(r.key)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className="mem-dot" style={{ background: r.color }} />
              <span className="mem-label">{r.label}</span>
              <span className="mem-value">{safeVal(status[r.key])}</span>
              {hovered === r.key && (
                <div className="mem-tip" role="tooltip">{r.tip}</div>
              )}
            </div>
          ))}

          {/* Summary line */}
          {(status.cached_mb ?? 0) > 500 && (
            <p className="mem-summary-line">
              {safeVal(status.cached_mb)} of this is cache and is available on demand.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Status message ────────────────────────────────────────────────────────────
function statusMessage(pressure: string, aiActive: boolean): string {
  if (aiActive) return 'Protecting your AI workload';
  if (pressure === 'CRITICAL') return 'Optimizing memory now';
  if (pressure === 'MODERATE') return 'Protecting your workload';
  return 'Everything is optimized';
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export function Dashboard({ daemon, batterySpeed, scrollVelocity = 0, onNavigate }: Props) {
  const { status, history, digest, startFocus, endFocus, optimizeNow } = daemon;
  const [focusPickerOpen, setFocusPickerOpen] = useState<'header' | 'quick' | false>(false);
  const statusMsg   = statusMessage(status?.pressure_label ?? 'NORMAL', !!status?.ai_inference_active);
  const typedStatus = useTypewriter(statusMsg);

  if (!status) return null;

  const suspendedProcs     = status.processes.filter(p => p.status === 'SUSPENDED');
  const freedMb            = suspendedProcs.reduce((s, p) => s + p.memory_mb, 0);
  const protectedCount     = status.processes.filter(p => p.classification === 'PROTECTED').length;
  const recentEvents       = history.slice(0, 20);
  const compressionTotal   = safeNum(status.compression_savings_mb ?? 0);

  // Animated numbers + flash
  const animFreedMb    = useAnimated(freedMb);
  const animSuspended  = useAnimated(status.suspended_count);
  const animProtected  = useAnimated(protectedCount);
  const animPressure   = useAnimated(status.pressure_percent, 800);
  const flashFreed     = useFlash(freedMb);
  const flashSuspended = useFlash(status.suspended_count);
  const flashProtected = useFlash(protectedCount);
  const flashPressure  = useFlash(status.pressure_percent);

  const displayFreed = animFreedMb >= 1024
    ? `${(animFreedMb / 1024).toFixed(1)} GB`
    : `${Math.round(animFreedMb)} MB`;

  const pressureColor = status.pressure_label === 'CRITICAL'
    ? '#ef4444' : status.pressure_label === 'MODERATE' ? '#f97316' : '#4ade80';

  const suspendableProcs = status.processes.filter(p => p.classification === 'EVICTABLE' && p.status === 'IDLE');
  const idleEvictable    = suspendableProcs.length > 0;
  const compressionFmt   = compressionTotal >= 1024
    ? `${(compressionTotal / 1024).toFixed(1)} GB`
    : `${Math.round(compressionTotal)} MB`;

  return (
    <div className="view overview-view">

      {/* ── TOP ROW: status message + action buttons ── */}
      <div className="ov-top-row">
        <div className="ov-top-left">
          {status.focus_active && status.focus_process && (
            <FocusBanner
              processName={status.focus_process}
              durationSecs={status.focus_duration_secs ?? 0}
              freedMb={status.focus_memory_freed_mb ?? 0}
              onEnd={endFocus}
            />
          )}
          <div className="ov-status-headline">
            {typedStatus}<span className="status-cursor" aria-hidden="true" />
          </div>
          <div className="ov-status-sub">
            {status.pressure_label} pressure · Auto-optimize {status.auto_optimize ? 'on' : 'off'} · {status.suspended_count} suspended
          </div>
        </div>
        <div className="ov-top-right">
          {suspendableProcs.length > 0 && (
            <MagneticButton
              className={`ov-action-btn ov-action-btn--primary${status.pressure_percent > 70 ? ' ov-action-btn--pulse' : ''}`}
              onClick={optimizeNow}
            >
              <Zap size={14} strokeWidth={1.5} /> Optimize Now
            </MagneticButton>
          )}
          {!status.focus_active && status.processes.length > 0 && (
            <div className="focus-picker-wrap" style={{ position: 'relative' }}>
              <MagneticButton
                className="ov-action-btn"
                onClick={() => setFocusPickerOpen(o => o === 'header' ? false : 'header')}
                aria-label="Toggle focus mode"
              >
                <Target size={14} strokeWidth={1.5} /> Focus Mode
              </MagneticButton>
              {focusPickerOpen === 'header' && (
                <FocusPicker
                  processes={status.processes}
                  onSelect={name => { startFocus(name); setFocusPickerOpen(false); }}
                  onClose={() => setFocusPickerOpen(false)}
                />
              )}
            </div>
          )}
          {status.focus_active && (
            <MagneticButton className="ov-action-btn ov-action-btn--warn" onClick={endFocus}>
              <StopCircle size={14} strokeWidth={1.5} /> End Focus
            </MagneticButton>
          )}
        </div>
      </div>

      {/* ── MIDDLE ROW: battery left, stats right ── */}
      <div className="overview-cols">
        <div className="overview-left">
          <Battery2DCanvas
            pressure={status.pressure_percent}
            usedGb={status.used_ram_gb}
            totalGb={status.total_ram_gb}
            animSpeed={batterySpeed}
            scrollVelocity={scrollVelocity}
          />
          <div className="battery-usage-label">
            {status.used_ram_gb.toFixed(1)} GB of {status.total_ram_gb.toFixed(0)} GB
          </div>
          <div className={`battery-pressure-label ${status.pressure_label}`}>
            {status.pressure_label}
          </div>
          <MemoryBreakdown status={status} />
        </div>

        <div className="overview-right">
          {status.ai_inference_active && status.ai_tool && (
            <div className="ai-banner-wrapper">
              <div style={{ flex: 1 }}>
                <div className="ai-banner-wrapper-text">
                  {status.ai_tool.charAt(0).toUpperCase() + status.ai_tool.slice(1)} active — memory protected
                </div>
                {status.ai_preemptive_clear_mb && status.ai_preemptive_clear_mb > 0 && (
                  <div className="ai-banner-wrapper-meta">
                    {Math.round(status.ai_preemptive_clear_mb)} MB cleared preemptively
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="overview-stat-grid">
            <div className="overview-stat-card tilt-card">
              <div className={`overview-stat-num gold${flashFreed ? ' stat-flash' : ''}`}>{displayFreed}</div>
              <div className="overview-stat-label">Available Again</div>
            </div>
            <div className="overview-stat-card tilt-card">
              <div className={`overview-stat-num white${flashSuspended ? ' stat-flash' : ''}`}>{Math.round(animSuspended)}</div>
              <div className="overview-stat-label">Suspended</div>
            </div>
            <div className="overview-stat-card tilt-card">
              <div className={`overview-stat-num white${flashProtected ? ' stat-flash' : ''}`}>{Math.round(animProtected)}</div>
              <div className="overview-stat-label">Protected</div>
            </div>
            <div className="overview-stat-card tilt-card">
              <div className={`overview-stat-num${flashPressure ? ' stat-flash' : ''}`} style={{ color: pressureColor }}>
                {animPressure.toFixed(0)}%
              </div>
              <div className="overview-stat-label">Pressure</div>
            </div>
            {compressionTotal > 0 && (
              <div className="overview-stat-card tilt-card" style={{ gridColumn: 'span 2' }}>
                <div className="overview-stat-num gold">{compressionFmt}</div>
                <div className="overview-stat-label">Compression Savings</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── QUICK ACTIONS ── */}
      <div className="quick-actions-section">
        <div className="section-header" style={{ marginBottom: 10 }}>
          <span className="section-title">Quick Actions</span>
        </div>
        <div className="quick-actions-row">
          {suspendableProcs.length > 0 && (
            <button className={`qa-btn${status.pressure_percent > 70 ? ' qa-btn--gold' : ''}`} onClick={optimizeNow}>
              <Zap size={13} strokeWidth={1.5} /> Optimize Now
            </button>
          )}
          {!status.focus_active && status.ai_inference_active && status.ai_tool && (
            <button className="qa-btn" onClick={() => startFocus(status.ai_tool!)}>
              <Target size={13} strokeWidth={1.5} /> Focus: {status.ai_tool.charAt(0).toUpperCase() + status.ai_tool.slice(1)}
            </button>
          )}
          {!status.focus_active && !status.ai_inference_active && (
            <div style={{ position: 'relative' }}>
              <button className="qa-btn" onClick={() => setFocusPickerOpen(o => o === 'quick' ? false : 'quick')}>
                <Target size={13} strokeWidth={1.5} /> Start Focus Session
              </button>
              {focusPickerOpen === 'quick' && (
                <FocusPicker
                  processes={status.processes}
                  onSelect={name => { startFocus(name); setFocusPickerOpen(false); }}
                  onClose={() => setFocusPickerOpen(false)}
                />
              )}
            </div>
          )}
          {status.focus_active && (
            <button className="qa-btn qa-btn--warn" onClick={endFocus}>
              <StopCircle size={13} strokeWidth={1.5} /> End Focus Session
            </button>
          )}
          {idleEvictable && (
            <button className="qa-btn" onClick={optimizeNow}>
              <Trash2 size={13} strokeWidth={1.5} /> Clear {suspendableProcs.length} Idle Process{suspendableProcs.length !== 1 ? 'es' : ''}
            </button>
          )}
          <button className="qa-btn" onClick={() => onNavigate?.('models')}>
            <HardDrive size={13} strokeWidth={1.5} /> Check Models
          </button>
          <button className="qa-btn" onClick={() => onNavigate?.('history')}>
            <Clock size={13} strokeWidth={1.5} /> View History
          </button>
        </div>
      </div>

      {/* ── TODAY'S ACTIVITY ── */}
      {digest && (
        <div className="digest-card tilt-card">
          <div className="section-header" style={{ marginBottom: 0 }}>
            <span className="section-title">Today's Activity</span>
          </div>
          <div className="digest-row">
            <div className="digest-row-stat">
              <div className="digest-row-value">
                {digest.total_mb_freed_today >= 1024
                  ? `${(digest.total_mb_freed_today / 1024).toFixed(1)}G`
                  : `${Math.round(digest.total_mb_freed_today)}M`}
              </div>
              <div className="digest-row-label">Freed</div>
            </div>
            <div className="digest-row-divider" />
            <div className="digest-row-stat">
              <div className="digest-row-value">{digest.total_suspensions_today}</div>
              <div className="digest-row-label">Suspensions</div>
            </div>
            <div className="digest-row-divider" />
            <div className="digest-row-stat">
              <div className="digest-row-value">{digest.total_resumes_today}</div>
              <div className="digest-row-label">Resumes</div>
            </div>
            <div className="digest-row-divider" />
            <div className="digest-row-stat">
              <div className="digest-row-value">{digest.longest_protected_session_min}m</div>
              <div className="digest-row-label">Longest Session</div>
            </div>
          </div>
        </div>
      )}

      {/* ── COMPRESSION ANALYTICS ── */}
      <CompressionAnalytics
        timeline={status.compression_timeline ?? []}
        suspendedCount={status.suspended_count}
        compressionTotal={compressionTotal}
      />

      {/* ── RECENT ACTIONS ── */}
      <div className="recent-actions tilt-card">
        <div className="section-header">
          <span className="section-title">Recent Actions</span>
        </div>
        {recentEvents.length === 0 ? (
          <div style={{ padding: '16px 4px', color: 'var(--text-muted)', fontSize: 13 }}>
            No actions yet — MEMentum is watching
          </div>
        ) : (
          <div className="action-list-clean">
            {recentEvents.slice(0, 15).map(ev => (
              <div key={ev.id} className="action-row-clean">
                <div className={`action-dot ${ev.type}`} />
                <div className="action-row-clean-text">{ev.message}</div>
                <div className="action-row-clean-time">{timeAgo(ev.timestamp)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
