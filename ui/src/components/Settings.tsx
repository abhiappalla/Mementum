import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Settings2, Zap, Palette, LayoutDashboard, Bell,
  Shield, Target, Lock, Terminal, Info, X, Plus, Trash2,
} from 'lucide-react';
import { api } from '../utils/api';
import { requestNotificationPermission, checkNotificationPermission } from '../utils/notify';
import type { DaemonHook, FocusSession } from '../hooks/useDaemon';
import type { CountOption } from './ProcessList';
import { COUNT_OPTIONS } from './ProcessList';

// ── Settings shape ────────────────────────────────────────────────────────────
export interface AppSettings {
  pressureThreshold:    number;
  resumeThreshold:      number;
  refreshRate:          1 | 2 | 3 | 5;
  uiScale:              number;
  layoutDensity:        'comfortable' | 'compact' | 'dense';
  showAnimations:       boolean;
  batterySpeed:         'calm' | 'normal' | 'intense';
  theme:                'dark-gold' | 'dark-silver' | 'dark-blue';
  desktopNotifications: boolean;
  notifyOptimization:   boolean;
  notifyMemoryLeak:     boolean;
  idleTimeout:          10 | 30 | 60 | 120 | 300;
  maxProcesses:         number | 'all';
  enableDevAPI:         boolean;
  // Dashboard
  defaultView:          'dashboard' | 'processes' | 'history';
  defaultLayout:        'grid' | 'list' | 'compact';
  showSystemProcesses:  boolean;
  groupChildProcesses:  boolean;
  showSparklines:       boolean;
  // Focus
  focusDuration:        15 | 25 | 30 | 45 | 60;
  focusAutoEnd:         boolean;
  focusAggressive:      boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  pressureThreshold:    75,
  resumeThreshold:      60,
  refreshRate:          1,
  uiScale:              100,
  layoutDensity:        'comfortable',
  showAnimations:       true,
  batterySpeed:         'normal',
  theme:                'dark-gold',
  desktopNotifications: false,
  notifyOptimization:   true,
  notifyMemoryLeak:     true,
  idleTimeout:          30,
  maxProcesses:         20,
  enableDevAPI:         false,
  defaultView:          'dashboard',
  defaultLayout:        'grid',
  showSystemProcesses:  false,
  groupChildProcesses:  true,
  showSparklines:       false,
  focusDuration:        25,
  focusAutoEnd:         true,
  focusAggressive:      false,
};

const LS_KEY = 'mementum-settings';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s: AppSettings) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

const API_DOCS = `POST http://127.0.0.1:7779

{"action":"get_status","limit":20}
{"action":"optimize_now"}
{"action":"toggle_auto"}
{"action":"set_config","key":"pressure_threshold","value":75.0}
{"action":"set_config","key":"resume_threshold","value":60.0}
{"action":"set_config","key":"idle_timeout_secs","value":30}
{"action":"set_config","key":"auto_optimize","value":true}
{"action":"set_override","process":"chrome","class":"protected"}
{"action":"set_budget","process":"chrome","limit_mb":1024}
{"action":"start_focus","process":"chrome","aggressive":true}
{"action":"end_focus"}
{"action":"get_digest"}
{"action":"get_config"}`;

// ── Category types ────────────────────────────────────────────────────────────
type Category = 'general' | 'optimization' | 'appearance' | 'dashboard' |
  'notifications' | 'protection' | 'focus' | 'privacy' | 'advanced' | 'about';

type LucideIcon = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const CATEGORIES: { key: Category; label: string; Icon: LucideIcon }[] = [
  { key: 'general',       label: 'General',          Icon: Settings2       },
  { key: 'optimization',  label: 'Optimization',     Icon: Zap             },
  { key: 'appearance',    label: 'Appearance',       Icon: Palette         },
  { key: 'dashboard',     label: 'Dashboard',        Icon: LayoutDashboard },
  { key: 'notifications', label: 'Notifications',    Icon: Bell            },
  { key: 'protection',    label: 'Protection Rules', Icon: Shield          },
  { key: 'focus',         label: 'Focus Sessions',   Icon: Target          },
  { key: 'privacy',       label: 'Data & Privacy',   Icon: Lock            },
  { key: 'advanced',      label: 'Advanced',         Icon: Terminal        },
  { key: 'about',         label: 'About',            Icon: Info            },
];

// ── Shared sub-components ─────────────────────────────────────────────────────
function SC({ children }: { children: React.ReactNode }) {
  return <div className="sc-card">{children}</div>;
}

function Row({ label, sub, children, last }: {
  label: string; sub?: string; children: React.ReactNode; last?: boolean;
}) {
  return (
    <div className={`sc-row${last ? ' last' : ''}`}>
      <div className="sc-row-label">
        <div className="sc-row-title">{label}</div>
        {sub && <div className="sc-row-sub">{sub}</div>}
      </div>
      <div className="sc-row-control">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="sc-section-title">{children}</div>;
}

function Toggle({ value, onChange, disabled }: {
  value: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button
      className={`settings-toggle${value ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => !disabled && onChange(!value)}
      aria-pressed={value}
      disabled={disabled}
    >
      <span className="settings-toggle-thumb" />
    </button>
  );
}

function Slider({ value, min, max, step = 1, onChange, format = (v: number) => String(v) }: {
  value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="settings-slider-wrap">
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="settings-slider"
        style={{ '--slider-pct': `${pct}%` } as React.CSSProperties}
      />
      <span className="settings-slider-val">{format(value)}</span>
    </div>
  );
}

function Seg<T extends string | number>({ options, value, onChange, format }: {
  options: readonly T[]; value: T; onChange: (v: T) => void; format?: (v: T) => string;
}) {
  return (
    <div className="settings-seg">
      {options.map(o => (
        <button key={String(o)}
          className={`settings-seg-btn${value === o ? ' active' : ''}`}
          onClick={() => onChange(o)}>
          {format ? format(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

// ── General panel ─────────────────────────────────────────────────────────────
function GeneralPanel({ settings, onChange, daemon, onToast, pt, rt, idle }: {
  settings: AppSettings; onChange: (p: Partial<AppSettings>) => void;
  daemon: DaemonHook; onToast: (m: string) => void;
  pt: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
  rt: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
  idle: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
}) {
  const set = (p: Partial<AppSettings>) => { onChange(p); onToast('Saved'); };

  const handlePT = (v: number) => {
    onChange({ pressureThreshold: v });
    clearTimeout(pt.current);
    pt.current = setTimeout(() => api.setConfigKey('pressure_threshold', v).then(() => onToast('Saved')), 500);
  };
  const handleRT = (v: number) => {
    onChange({ resumeThreshold: v });
    clearTimeout(rt.current);
    rt.current = setTimeout(() => api.setConfigKey('resume_threshold', v).then(() => onToast('Saved')), 500);
  };
  const handleIdle = (v: AppSettings['idleTimeout']) => {
    onChange({ idleTimeout: v });
    clearTimeout(idle.current);
    idle.current = setTimeout(() => api.setConfigKey('idle_timeout_secs', v).then(() => onToast('Saved')), 300);
  };

  return (
    <>
      <SectionTitle>Daemon</SectionTitle>
      <SC>
        <Row label="Auto-Optimize" sub="Suspend idle processes under pressure">
          <Toggle value={daemon.status?.auto_optimize ?? false}
            onChange={() => { daemon.toggleAuto(); onToast('Toggled'); }} />
        </Row>
        <Row label="Refresh Rate" last>
          <Seg options={[1, 2, 3, 5] as const} value={settings.refreshRate}
            onChange={v => set({ refreshRate: v })} format={v => `${v}s`} />
        </Row>
      </SC>
      <SectionTitle>Thresholds</SectionTitle>
      <SC>
        <Row label="Suspend above">
          <Slider value={settings.pressureThreshold} min={50} max={95} step={5}
            onChange={handlePT} format={v => `${v}%`} />
        </Row>
        <Row label="Resume below" last>
          <Slider value={settings.resumeThreshold} min={40}
            max={settings.pressureThreshold - 5} step={5}
            onChange={handleRT} format={v => `${v}%`} />
        </Row>
      </SC>
      <SectionTitle>Idle Timeout</SectionTitle>
      <SC>
        <Row label="Before suspension" last>
          <Seg options={[10, 30, 60, 120, 300] as const} value={settings.idleTimeout}
            onChange={handleIdle} format={v => v >= 60 ? `${v / 60}m` : `${v}s`} />
        </Row>
      </SC>
    </>
  );
}

// ── Optimization panel ────────────────────────────────────────────────────────
function OptimizationPanel({ onToast, processLimit, onLimitChange }: {
  onToast: (m: string) => void;
  processLimit: CountOption; onLimitChange: (v: CountOption) => void;
}) {
  return (
    <>
      <SectionTitle>Process Display</SectionTitle>
      <SC>
        <Row label="Max shown" last>
          <Seg options={COUNT_OPTIONS} value={processLimit}
            onChange={v => { onLimitChange(v); onToast('Saved'); }}
            format={v => v === 'all' ? 'All' : String(v)} />
        </Row>
      </SC>
    </>
  );
}

// ── Appearance panel ──────────────────────────────────────────────────────────
function AppearancePanel({ settings, onChange, onToast }: {
  settings: AppSettings; onChange: (p: Partial<AppSettings>) => void; onToast: (m: string) => void;
}) {
  const set = (p: Partial<AppSettings>) => { onChange(p); onToast('Saved'); };
  return (
    <>
      <SectionTitle>Color</SectionTitle>
      <SC>
        <Row label="Theme" last>
          <Seg options={['dark-gold', 'dark-silver', 'dark-blue'] as const} value={settings.theme}
            onChange={v => set({ theme: v })}
            format={v => ({ 'dark-gold': 'Gold', 'dark-silver': 'Silver', 'dark-blue': 'Blue' }[v]!)} />
        </Row>
      </SC>
      <SectionTitle>Layout</SectionTitle>
      <SC>
        <Row label="Density">
          <Seg options={['comfortable', 'compact', 'dense'] as const} value={settings.layoutDensity}
            onChange={v => set({ layoutDensity: v })}
            format={v => v.charAt(0).toUpperCase() + v.slice(1)} />
        </Row>
        <Row label="Scale" sub="Cmd+Shift+= / –" last>
          <Slider value={settings.uiScale} min={80} max={130} step={5}
            onChange={v => set({ uiScale: v })} format={v => `${v}%`} />
        </Row>
      </SC>
      <SectionTitle>Animation</SectionTitle>
      <SC>
        <Row label="Background">
          <Toggle value={settings.showAnimations} onChange={v => set({ showAnimations: v })} />
        </Row>
        <Row label="Battery speed" last>
          <Seg options={['calm', 'normal', 'intense'] as const} value={settings.batterySpeed}
            onChange={v => set({ batterySpeed: v })}
            format={v => v.charAt(0).toUpperCase() + v.slice(1)} />
        </Row>
      </SC>
    </>
  );
}

// ── Dashboard panel ───────────────────────────────────────────────────────────
function DashboardPanel({ settings, onChange, onToast, processLimit, onLimitChange }: {
  settings: AppSettings; onChange: (p: Partial<AppSettings>) => void;
  onToast: (m: string) => void;
  processLimit: CountOption; onLimitChange: (v: CountOption) => void;
}) {
  const set = (p: Partial<AppSettings>) => { onChange(p); onToast('Saved'); };
  return (
    <>
      <SectionTitle>Navigation</SectionTitle>
      <SC>
        <Row label="Default view" sub="Tab shown on launch" last>
          <Seg options={['dashboard', 'processes', 'history'] as const}
            value={settings.defaultView}
            onChange={v => set({ defaultView: v })}
            format={v => ({ dashboard: 'Overview', processes: 'Processes', history: 'History' }[v]!)} />
        </Row>
      </SC>
      <SectionTitle>Processes</SectionTitle>
      <SC>
        <Row label="Processes per page">
          <Seg options={COUNT_OPTIONS} value={processLimit}
            onChange={v => { onLimitChange(v); onToast('Saved'); }}
            format={v => v === 'all' ? 'All' : String(v)} />
        </Row>
        <Row label="Default layout">
          <Seg options={['grid', 'list', 'compact'] as const}
            value={settings.defaultLayout}
            onChange={v => {
              set({ defaultLayout: v });
              try { localStorage.setItem('mementum-layout-processes', v); } catch {}
            }}
            format={v => v.charAt(0).toUpperCase() + v.slice(1)} />
        </Row>
        <Row label="Show system processes" sub="windowserver, kernel_task, etc.">
          <Toggle value={settings.showSystemProcesses} onChange={v => set({ showSystemProcesses: v })} />
        </Row>
        <Row label="Group child processes" sub="Collapse Chrome helpers under Chrome">
          <Toggle value={settings.groupChildProcesses} onChange={v => set({ groupChildProcesses: v })} />
        </Row>
        <Row label="Memory trend sparklines" sub="Coming soon" last>
          <Toggle value={settings.showSparklines} onChange={v => set({ showSparklines: v })} />
        </Row>
      </SC>
    </>
  );
}

// ── Notifications panel ───────────────────────────────────────────────────────
function NotificationsPanel({ settings, onChange, onToast, notifGranted, setNotifGranted }: {
  settings: AppSettings; onChange: (p: Partial<AppSettings>) => void;
  onToast: (m: string) => void;
  notifGranted: boolean; setNotifGranted: (v: boolean) => void;
}) {
  const set = (p: Partial<AppSettings>) => { onChange(p); onToast('Saved'); };
  const handleEnable = async (v: boolean) => {
    if (v && !notifGranted) {
      const granted = await requestNotificationPermission();
      if (!granted) { onToast('Permission denied'); return; }
      setNotifGranted(true);
    }
    set({ desktopNotifications: v });
  };
  const notifActive = settings.desktopNotifications && notifGranted;
  return (
    <>
      <SectionTitle>Desktop</SectionTitle>
      <SC>
        <Row label="Enable" sub="Native macOS notifications" last>
          <Toggle value={settings.desktopNotifications} onChange={handleEnable} />
        </Row>
      </SC>
      <SectionTitle>Events</SectionTitle>
      <SC>
        <Row label="Optimization events">
          <Toggle value={settings.notifyOptimization}
            onChange={v => set({ notifyOptimization: v })} disabled={!notifActive} />
        </Row>
        <Row label="Memory leak alert" last>
          <Toggle value={settings.notifyMemoryLeak}
            onChange={v => set({ notifyMemoryLeak: v })} disabled={!notifActive} />
        </Row>
      </SC>
    </>
  );
}

// ── Protection Rules panel ────────────────────────────────────────────────────
function ProtectionPanel({ onToast }: { onToast: (m: string) => void }) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [budgets,   setBudgets]   = useState<Record<string, number>>({});
  const [loading,   setLoading]   = useState(true);
  const [addOpen,   setAddOpen]   = useState(false);
  const [addName,   setAddName]   = useState('');
  const [addCls,    setAddCls]    = useState<'protected' | 'evictable'>('protected');
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoading(true);
    api.getConfig().then(cfg => {
      if (!cfg) return;
      if (cfg.overrides && typeof cfg.overrides === 'object')
        setOverrides(cfg.overrides as Record<string, string>);
      if (cfg.budgets && typeof cfg.budgets === 'object')
        setBudgets(cfg.budgets as Record<string, number>);
    }).finally(() => setLoading(false));
  }, []);

  const removeOverride = async (name: string) => {
    await api.setOverride(name, 'neutral').catch(() => null);
    setOverrides(o => { const n = { ...o }; delete n[name]; return n; });
    onToast(`Removed override for ${name}`);
  };

  const addRule = async () => {
    const name = addName.trim().toLowerCase();
    if (!name) return;
    await api.setOverride(name, addCls).catch(() => null);
    setOverrides(o => ({ ...o, [name]: addCls }));
    setAddName(''); setAddOpen(false);
    onToast(`${name} → ${addCls}`);
  };

  const updateBudget = async (name: string) => {
    const val = parseInt(budgetEdits[name] ?? '', 10);
    if (isNaN(val) || val <= 0) return;
    await api.setBudget(name, val).catch(() => null);
    setBudgets(b => ({ ...b, [name]: val }));
    onToast(`Budget set: ${name} → ${val} MB`);
  };

  const removeBudget = async (name: string) => {
    await api.setBudget(name, 999999).catch(() => null);
    setBudgets(b => { const n = { ...b }; delete n[name]; return n; });
    onToast(`Budget removed for ${name}`);
  };

  const protected_ = Object.entries(overrides).filter(([,v]) => v === 'protected');
  const evictable_ = Object.entries(overrides).filter(([,v]) => v === 'evictable');

  if (loading) return <div className="sc-coming-soon"><div className="sc-coming-soon-label">Loading…</div></div>;

  return (
    <>
      <SectionTitle>Always Protect</SectionTitle>
      <SC>
        {protected_.length === 0 ? (
          <div className="sc-row last"><span className="sc-row-title" style={{ color: 'var(--text-faint)' }}>None</span></div>
        ) : protected_.map(([name], i) => (
          <div key={name} className={`sc-row${i === protected_.length - 1 ? ' last' : ''}`}>
            <div className="sc-row-label"><div className="sc-row-title">{name}</div></div>
            <button className="sc-chip-remove" onClick={() => removeOverride(name)} title="Remove">
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
      </SC>

      <SectionTitle>Always Evict</SectionTitle>
      <SC>
        {evictable_.length === 0 ? (
          <div className="sc-row last"><span className="sc-row-title" style={{ color: 'var(--text-faint)' }}>None</span></div>
        ) : evictable_.map(([name], i) => (
          <div key={name} className={`sc-row${i === evictable_.length - 1 ? ' last' : ''}`}>
            <div className="sc-row-label"><div className="sc-row-title">{name}</div></div>
            <button className="sc-chip-remove" onClick={() => removeOverride(name)} title="Remove">
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
      </SC>

      {addOpen ? (
        <div className="sc-add-form">
          <input
            className="sc-add-input" placeholder="process name"
            value={addName} onChange={e => setAddName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addRule(); if (e.key === 'Escape') setAddOpen(false); }}
            autoFocus
          />
          <div className="sc-add-row">
            <Seg options={['protected', 'evictable'] as const} value={addCls} onChange={setAddCls}
              format={v => v.charAt(0).toUpperCase() + v.slice(1)} />
            <button className="settings-action-btn" onClick={addRule}>Add</button>
          </div>
        </div>
      ) : (
        <button className="sc-add-btn" onClick={() => setAddOpen(true)}>
          <Plus size={13} strokeWidth={2} /> Add rule
        </button>
      )}

      {Object.keys(budgets).length > 0 && (
        <>
          <SectionTitle>Memory Budgets</SectionTitle>
          <SC>
            {Object.entries(budgets).map(([name, mb], i, arr) => (
              <div key={name} className={`sc-row${i === arr.length - 1 ? ' last' : ''}`}>
                <div className="sc-row-label"><div className="sc-row-title">{name}</div></div>
                <div className="sc-budget-row">
                  <input type="number" className="sc-budget-input"
                    value={budgetEdits[name] ?? String(mb)}
                    onChange={e => setBudgetEdits(b => ({ ...b, [name]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') updateBudget(name); }}
                    onBlur={() => updateBudget(name)}
                  />
                  <span className="sc-row-sub">MB</span>
                  <button className="sc-chip-remove" onClick={() => removeBudget(name)} title="Remove budget">
                    <Trash2 size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>
            ))}
          </SC>
        </>
      )}
    </>
  );
}

// ── Focus Sessions panel ──────────────────────────────────────────────────────
function FocusPanel({ settings, onChange, onToast, daemon }: {
  settings: AppSettings; onChange: (p: Partial<AppSettings>) => void;
  onToast: (m: string) => void; daemon: DaemonHook;
}) {
  const set = (p: Partial<AppSettings>) => { onChange(p); onToast('Saved'); };
  const [history, setHistory] = useState<FocusSession[]>(() => {
    try { return JSON.parse(localStorage.getItem('mementum_focus_history') || '[]'); }
    catch { return []; }
  });

  function relTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000)   return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function fmtDur(secs: number): string {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60), s = secs % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  return (
    <>
      <SectionTitle>Defaults</SectionTitle>
      <SC>
        <Row label="Duration">
          <Seg options={[15, 25, 30, 45, 60] as const} value={settings.focusDuration}
            onChange={v => set({ focusDuration: v })} format={v => `${v}m`} />
        </Row>
        <Row label="Auto-end when app closes" sub="Requires daemon support">
          <Toggle value={settings.focusAutoEnd} onChange={v => set({ focusAutoEnd: v })} />
        </Row>
        <Row label="Aggressive mode" sub="Suspend more processes during focus" last>
          <Toggle value={settings.focusAggressive} onChange={v => set({ focusAggressive: v })} />
        </Row>
      </SC>

      {daemon.status?.focus_active && (
        <>
          <SectionTitle>Active Session</SectionTitle>
          <SC>
            <Row label={daemon.status.focus_process ?? 'Active'} last>
              <button className="settings-action-btn danger" onClick={() => { daemon.endFocus(); onToast('Focus ended'); }}>
                End
              </button>
            </Row>
          </SC>
        </>
      )}

      {history.length > 0 && (
        <>
          <SectionTitle>Session History</SectionTitle>
          <SC>
            {history.map((s, i) => (
              <div key={s.ended_at} className={`sc-row${i === history.length - 1 ? ' last' : ''}`}>
                <div className="sc-row-label">
                  <div className="sc-row-title">{s.process.charAt(0).toUpperCase() + s.process.slice(1)}</div>
                  <div className="sc-row-sub">{fmtDur(s.duration_secs)} · {s.memory_freed_mb > 0 ? `${Math.round(s.memory_freed_mb)} MB freed` : ''} · {relTime(s.ended_at)}</div>
                </div>
              </div>
            ))}
          </SC>
          <button className="sc-add-btn" style={{ color: '#f87171' }}
            onClick={() => { localStorage.removeItem('mementum_focus_history'); setHistory([]); onToast('History cleared'); }}>
            Clear history
          </button>
        </>
      )}
    </>
  );
}

// ── Privacy panel ─────────────────────────────────────────────────────────────
function PrivacyPanel({ onToast, settings }: { onToast: (m: string) => void; settings: AppSettings }) {
  const exportConfig = async () => {
    let daemonCfg: Record<string, unknown> = {};
    try { daemonCfg = (await api.getConfig()) ?? {}; } catch {}
    const blob = new Blob([JSON.stringify({ ui: settings, daemon: daemonCfg }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mementum-config.json'; a.click();
    URL.revokeObjectURL(url);
    onToast('Exported');
  };
  return (
    <>
      <SectionTitle>Configuration</SectionTitle>
      <SC><Row label="Export settings" last>
        <button className="settings-action-btn" onClick={exportConfig}>Export</button>
      </Row></SC>
    </>
  );
}

// ── Compression interval constants ────────────────────────────────────────────
const ALL_COMPRESSION_INTERVALS = [1, 5, 10, 15, 30, 60, 120, 300] as const;
const DEFAULT_COMPRESSION_INTERVALS = [5, 15, 30];
const COMPRESSION_LS_KEY = 'mementum_compression_intervals';

function loadCompressionIntervals(): number[] {
  try { return JSON.parse(localStorage.getItem(COMPRESSION_LS_KEY) || 'null') ?? DEFAULT_COMPRESSION_INTERVALS; }
  catch { return DEFAULT_COMPRESSION_INTERVALS; }
}

function fmtIntervalLabel(s: number): string {
  return s < 60 ? `${s}s` : `${s / 60}m`;
}

// ── Advanced panel ────────────────────────────────────────────────────────────
function AdvancedPanel({ settings, onChange, onToast }: {
  settings: AppSettings; onChange: (p: Partial<AppSettings>) => void; onToast: (m: string) => void;
}) {
  const set = (p: Partial<AppSettings>) => { onChange(p); onToast('Saved'); };
  const [compressionIntervals, setCompressionIntervals] = useState<number[]>(loadCompressionIntervals);

  const toggleInterval = (secs: number) => {
    setCompressionIntervals(prev => {
      const next = prev.includes(secs) ? prev.filter(v => v !== secs) : [...prev, secs].sort((a, b) => a - b);
      const toSave = next.length > 0 ? next : DEFAULT_COMPRESSION_INTERVALS;
      try { localStorage.setItem(COMPRESSION_LS_KEY, JSON.stringify(toSave)); } catch {}
      api.setConfigKey('compression_intervals', toSave).catch(() => null);
      return toSave;
    });
    onToast('Saved');
  };

  const copyApiDocs = async () => {
    try { await navigator.clipboard.writeText(API_DOCS); onToast('Copied'); }
    catch { onToast('Copy failed'); }
  };
  const handleReset = async () => {
    if (!window.confirm('Reset all settings to defaults?')) return;
    try { localStorage.clear(); } catch {}
    await Promise.all([
      api.setConfigKey('pressure_threshold', 75.0),
      api.setConfigKey('resume_threshold', 60.0),
      api.setConfigKey('auto_optimize', true),
      api.setConfigKey('idle_timeout_secs', 30),
    ]);
    window.location.reload();
  };
  return (
    <>
      <SectionTitle>Compression Intervals</SectionTitle>
      <div className="sc-card">
        <div className="sc-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
          <div className="sc-row-title" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Measure compression at
          </div>
          <div className="cmp-intervals-grid">
            {ALL_COMPRESSION_INTERVALS.map(secs => (
              <label key={secs} className="cmp-interval-item">
                <input
                  type="checkbox"
                  className="cmp-interval-check"
                  checked={compressionIntervals.includes(secs)}
                  onChange={() => toggleInterval(secs)}
                />
                <span className="cmp-interval-label">{fmtIntervalLabel(secs)}</span>
              </label>
            ))}
          </div>
          <div className="sc-row-sub last" style={{ paddingBottom: 2 }}>
            {compressionIntervals.length === 0 ? 'Select at least one interval' : `${compressionIntervals.length} interval${compressionIntervals.length !== 1 ? 's' : ''} selected`}
          </div>
        </div>
      </div>

      <SectionTitle>Developer</SectionTitle>
      <SC><Row label="Show API" last>
        <Toggle value={settings.enableDevAPI} onChange={v => set({ enableDevAPI: v })} />
      </Row></SC>
      {settings.enableDevAPI && (
        <div className="sc-dev-panel">
          <code className="sc-dev-url">http://127.0.0.1:7779</code>
          <button className="settings-action-btn" onClick={copyApiDocs}>Copy docs</button>
        </div>
      )}
      <SectionTitle>Reset</SectionTitle>
      <SC><Row label="Restore defaults" last>
        <button className="settings-action-btn danger" onClick={handleReset}>Reset</button>
      </Row></SC>
    </>
  );
}

// ── About panel ───────────────────────────────────────────────────────────────
function AboutPanel({ daemon, onToast }: { daemon: DaemonHook; onToast: (m: string) => void }) {
  const handleReconnect = () => {
    daemon.retry();
    onToast('Reconnecting…');
  };
  return (
    <>
      <div className="sc-about">
        <div className="sc-about-logo">M</div>
        <div className="sc-about-name">MEMentum</div>
        <div className="sc-about-version">v0.1.0</div>
        <div className="sc-about-desc">Intelligent memory management for macOS</div>
      </div>
      <SC>
        <Row label="Daemon">
          <span className={`sc-status-badge${daemon.connected ? ' connected' : ''}`}>
            {daemon.connected ? 'Connected' : 'Disconnected'}
          </span>
        </Row>
        <Row label="Reconnect" last>
          <button className="settings-action-btn" onClick={handleReconnect}>Reconnect</button>
        </Row>
      </SC>
    </>
  );
}

// ── Main Settings slide panel ─────────────────────────────────────────────────
interface Props {
  open:       boolean;
  onClose:    () => void;
  settings:   AppSettings;
  onChange:   (patch: Partial<AppSettings>) => void;
  daemon:     DaemonHook;
  onToast:    (msg: string) => void;
  processLimit: CountOption;
  onLimitChange: (v: CountOption) => void;
  pageMode?:  boolean;
}

export function Settings({ open, onClose, settings, onChange, daemon, onToast, processLimit, onLimitChange, pageMode = false }: Props) {
  const [category,     setCategory]     = useState<Category>('general');
  const [notifGranted, setNotifGranted] = useState(false);
  const configFetched = useRef(false);
  const ptRef   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rtRef   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contentKey = useRef(0);

  useEffect(() => { checkNotificationPermission().then(setNotifGranted); }, []);

  useEffect(() => {
    if (!open) { configFetched.current = false; return; }
    if (configFetched.current) return;
    configFetched.current = true;
    api.getConfig().then(cfg => {
      if (!cfg || typeof cfg !== 'object') return;
      const patch: Partial<AppSettings> = {};
      if (typeof cfg.pressure_threshold === 'number') patch.pressureThreshold = cfg.pressure_threshold;
      if (typeof cfg.resume_threshold   === 'number') patch.resumeThreshold   = cfg.resume_threshold;
      if (typeof cfg.idle_timeout_secs  === 'number') {
        const s = cfg.idle_timeout_secs;
        if ([10, 30, 60, 120, 300].includes(s)) patch.idleTimeout = s as AppSettings['idleTimeout'];
      }
      if (Object.keys(patch).length) onChange(patch);
    }).catch(() => null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const switchCategory = (cat: Category) => { contentKey.current += 1; setCategory(cat); };

  const renderContent = useCallback(() => {
    switch (category) {
      case 'general':       return <GeneralPanel settings={settings} onChange={onChange}
                              daemon={daemon} onToast={onToast}
                              pt={ptRef} rt={rtRef} idle={idleRef} />;
      case 'optimization':  return <OptimizationPanel onToast={onToast}
                              processLimit={processLimit} onLimitChange={onLimitChange} />;
      case 'appearance':    return <AppearancePanel settings={settings} onChange={onChange} onToast={onToast} />;
      case 'dashboard':     return <DashboardPanel settings={settings} onChange={onChange}
                              onToast={onToast} processLimit={processLimit} onLimitChange={onLimitChange} />;
      case 'notifications': return <NotificationsPanel settings={settings} onChange={onChange} onToast={onToast}
                              notifGranted={notifGranted} setNotifGranted={setNotifGranted} />;
      case 'protection':    return <ProtectionPanel onToast={onToast} />;
      case 'focus':         return <FocusPanel settings={settings} onChange={onChange}
                              onToast={onToast} daemon={daemon} />;
      case 'privacy':       return <PrivacyPanel onToast={onToast} settings={settings} />;
      case 'advanced':      return <AdvancedPanel settings={settings} onChange={onChange} onToast={onToast} />;
      case 'about':         return <AboutPanel daemon={daemon} onToast={onToast} />;
    }
  }, [category, settings, onChange, daemon, onToast, notifGranted, processLimit, onLimitChange]);

  if (pageMode) {
    return (
      <div className="settings-page" role="main" aria-label="Settings">
        <nav className="settings-page-nav" aria-label="Settings categories">
          <div className="settings-page-nav-title">Settings</div>
          {CATEGORIES.map(({ key, label, Icon }) => (
            <button key={key}
              className={`settings-cat-item${category === key ? ' active' : ''}`}
              onClick={() => switchCategory(key)}>
              <Icon size={15} strokeWidth={1.75} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-page-content" key={contentKey.current}>
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className={`settings-panel${open ? ' open' : ''}`} role="dialog" aria-label="Settings">
      <div className="settings-panel-header">
        <span className="settings-panel-title">Settings</span>
        <button className="settings-close" onClick={onClose} aria-label="Close">
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <nav className="settings-cat-list" aria-label="Settings categories">
        {CATEGORIES.map(({ key, label, Icon }) => (
          <button key={key}
            className={`settings-cat-item${category === key ? ' active' : ''}`}
            onClick={() => switchCategory(key)}>
            <Icon size={15} strokeWidth={1.75} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="settings-cat-divider" />

      <div className="settings-content-scroll" key={contentKey.current}>
        {renderContent()}
      </div>
    </div>
  );
}
