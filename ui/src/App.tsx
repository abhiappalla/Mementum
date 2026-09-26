import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import './App.css';
import { LoadingScreen }   from './components/LoadingScreen';
import { Dashboard }       from './components/Dashboard';
import { ProcessList }     from './components/ProcessList';
import { History }         from './components/History';
import { Models }          from './components/Models';
import { Scene3D }         from './components/Scene3D';
import { CircuitBG }       from './components/CircuitBG';
import { Settings, loadSettings, saveSettings } from './components/Settings';
import type { AppSettings } from './components/Settings';
import { useDaemon }          from './hooks/useDaemon';
import { useScrollVelocity }  from './hooks/useScrollVelocity';
import type { CountOption }   from './components/ProcessList';
import { notify } from './utils/notify';
import { setApiToken, api } from './utils/api';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MagneticButton } from './components/MagneticButton';
import { WifiOff, CheckCircle2, HardDrive } from 'lucide-react';

// ── Error boundary — prevents black screen on unhandled render errors ─────────
interface EBState { hasError: boolean; error: Error | null; }
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, EBState> {
  state: EBState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error): EBState { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[MEMentum] Render error caught by ErrorBoundary:', error);
    console.error('[MEMentum] Component stack:', info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: 'white', padding: 24, background: '#0a0a0a', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>
          <h2 style={{ color: '#D4AF37', marginBottom: 8 }}>MEMentum encountered an error</h2>
          <p style={{ color: '#888', fontSize: 12, marginBottom: 16 }}>{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: '8px 16px', background: '#D4AF37', color: 'black', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
          >
            Recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Theme CSS variable overrides (sets --gold family on :root) ────────────────
const THEMES: Record<AppSettings['theme'], Record<string, string>> = {
  'dark-gold': {
    '--gold':        '#D4AF37',
    '--gold-glow':   '#F6E27A',
    '--gold-dim':    'rgba(212,175,55,0.14)',
    '--gold-ultra':  'rgba(212,175,55,0.05)',
    '--border-gold': 'rgba(212,175,55,0.22)',
    '--card-border': 'rgba(212,175,55,0.08)',
  },
  'dark-silver': {
    '--gold':        '#C0C0C0',
    '--gold-glow':   '#E8E8E8',
    '--gold-dim':    'rgba(192,192,192,0.14)',
    '--gold-ultra':  'rgba(192,192,192,0.05)',
    '--border-gold': 'rgba(192,192,192,0.22)',
    '--card-border': 'rgba(192,192,192,0.08)',
  },
  'dark-blue': {
    '--gold':        '#3B82F6',
    '--gold-glow':   '#93C5FD',
    '--gold-dim':    'rgba(59,130,246,0.14)',
    '--gold-ultra':  'rgba(59,130,246,0.05)',
    '--border-gold': 'rgba(59,130,246,0.22)',
    '--card-border': 'rgba(59,130,246,0.08)',
  },
};

function applyTheme(theme: AppSettings['theme']) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(THEMES[theme])) root.style.setProperty(k, v);
}

function applyDensity(density: AppSettings['layoutDensity']) {
  document.documentElement.classList.remove('density-comfortable', 'density-compact', 'density-dense');
  document.documentElement.classList.add(`density-${density}`);
}

// ── Toast system ──────────────────────────────────────────────────────────────
interface Toast { id: number; msg: string; }

type View = 'overview' | 'processes' | 'models' | 'history' | 'settings';

function DisconnectedView({ startupFailed, daemonError, onRetry }: {
  startupFailed: boolean;
  daemonError: string | null;
  onRetry: () => void;
}) {
  if (startupFailed || daemonError) {
    return (
      <div className="disconnected">
        <div className="disconnected-icon"><WifiOff size={32} strokeWidth={1.5} /></div>
        <div className="disconnected-title">Could not start MEMentum engine</div>
        {daemonError ? (
          <div className="disconnected-code" style={{ fontSize: 11, maxWidth: 340, wordBreak: 'break-word' }}>
            {daemonError}
          </div>
        ) : (
          <div className="disconnected-sub">Try reinstalling MEMentum.</div>
        )}
        <button className="btn-primary" onClick={onRetry} style={{ marginTop: 8 }}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="disconnected">
      <div className="engine-spinner" aria-hidden="true" />
      <div className="disconnected-title">Starting MEMentum engine…</div>
      <div className="disconnected-sub">Warming up — this takes a few seconds</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <div className="disconnected-pulse" />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Auto-connecting</span>
      </div>
    </div>
  );
}

function DisclosureModal({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="disclosure-overlay">
      <div className="disclosure-modal">
        <div className="disclosure-title">About MEMentum</div>
        <p className="disclosure-body">
          MEMentum runs only while this app is open.<br />
          When you quit MEMentum, all paused apps resume immediately and the engine stops completely. Nothing runs in the background.
        </p>
        <button className="btn-primary" onClick={onDismiss}>Got it</button>
      </div>
    </div>
  );
}

function AppInner() {
  const [loaded, setLoaded] = useState(false);
  const handleLoadComplete  = useCallback(() => setLoaded(true), []);
  if (!loaded) return <LoadingScreen onComplete={handleLoadComplete} />;
  return <AppShell />;
}

function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

// ── Sidebar nav items (all from lucide-react) ─────────────────────────────────
import { LayoutDashboard, Cpu, Database, Clock as ClockIcon, Settings2 } from 'lucide-react';

const SidebarIcon = ({ Icon }: { Icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }) =>
  <Icon size={16} strokeWidth={1.5} />;

const SIDEBAR_ITEMS: { key: View; label: string; LIcon: React.ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { key: 'overview',   label: 'Overview',   LIcon: LayoutDashboard },
  { key: 'processes',  label: 'Processes',  LIcon: Cpu             },
  { key: 'models',     label: 'Models',     LIcon: Database        },
  { key: 'history',    label: 'History',    LIcon: ClockIcon       },
  { key: 'settings',   label: 'Settings',   LIcon: Settings2       },
];

function AppShell() {
  const { velocity: scrollVelocity } = useScrollVelocity();

  const [settings,     setSettings]     = useState<AppSettings>(loadSettings);
  const [view,         setView]         = useState<View>(() => {
    const saved = settings.defaultView;
    return (saved && ['overview','processes','history','models'].includes(saved)) ? saved as View : 'overview';
  });
  const [toasts,       setToasts]       = useState<Toast[]>([]);
  const [processLimit, setProcessLimit] = useState<CountOption>(() => {
    try { const v = localStorage.getItem('mementum-proc-count'); return (v ? JSON.parse(v) : 20) as CountOption; }
    catch { return 20; }
  });
  const settingsRef   = useRef(settings);
  settingsRef.current = settings;

  const processLimitNum = processLimit === 'all' ? 0 : processLimit;

  // ── Spawn daemon process on app launch ────────────────────────────────────
  const [daemonError, setDaemonError] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>('start_daemon')
      .then(result => console.log('[daemon]', result))
      .catch(err => {
        console.error('[daemon] start failed:', err);
        setDaemonError(String(err));
      });
  }, []);

  // ── Read API token from ~/.mementum/api_token on startup ─────────────────
  const [tokenReady, setTokenReady] = useState(false);

  useEffect(() => {
    const loadToken = async () => {
      try {
        const home  = await homeDir();
        const token = await readTextFile(`${home}/.mementum/api_token`);
        setApiToken(token.trim());
        console.log('API token loaded: yes');
      } catch (err) {
        console.error('Failed to read API token:', err);
        // No token — allow connection without auth (dev mode / no auth daemon)
      } finally {
        setTokenReady(true);
      }
    };
    loadToken();
  }, []);

  // ── Daemon (refresh rate + process limit controlled by settings) ──────────
  // tokenReady gates polling so no request fires before the token is in place
  const daemon = useDaemon(settings.refreshRate * 1000, processLimitNum, tokenReady);

  // ── Startup timeout — show failure message if not connected after 15s ─────
  const [startupFailed, setStartupFailed] = useState(false);
  useEffect(() => {
    if (daemon.connected) { setStartupFailed(false); return; }
    const t = setTimeout(() => setStartupFailed(true), 15_000);
    return () => clearTimeout(t);
  }, [daemon.connected]);

  // ── Heartbeat every 5s to keep daemon aware the app is alive ─────────────
  useEffect(() => {
    if (!tokenReady) return;
    api.heartbeat();
    const id = setInterval(() => api.heartbeat(), 5_000);
    return () => clearInterval(id);
  }, [tokenReady]);

  // ── Cmd+Q / unload: tell daemon to resume processes, then stop it ─────────
  useEffect(() => {
    const handleBeforeUnload = async () => {
      try { await api.shutdown(); } catch {}
      try { await invoke('stop_daemon'); } catch {}
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [tokenReady]);

  // ── Stable ref so tray event listeners don't need effect restarts ───────
  const daemonRef = useRef(daemon);
  daemonRef.current = daemon;

  // ── Tray: "Quit MEMentum" — send clean shutdown then Rust exits ──────────
  useEffect(() => {
    const p = listen('tray-quit', async () => {
      try { await api.shutdown(); } catch {}
    });
    return () => { p.then(f => f()); };
  }, []);

  // ── Tray: "Optimize Now" ──────────────────────────────────────────────────
  useEffect(() => {
    const p = listen('tray-optimize', () => { daemonRef.current.optimizeNow(); });
    return () => { p.then(f => f()); };
  }, []);

  // ── Window hidden to tray — one-time notification ─────────────────────────
  useEffect(() => {
    const p = listen('window-hidden-to-tray', () => {
      try {
        if (localStorage.getItem('mementum_tray_notice_shown')) return;
        localStorage.setItem('mementum_tray_notice_shown', '1');
        notify(
          'MEMentum is still running',
          'Find it in your menu bar. Use the menu bar or Cmd+Q to quit completely.',
        );
      } catch {}
    });
    return () => { p.then(f => f()); };
  }, []);

  // ── Update tray status label on every daemon poll ─────────────────────────
  useEffect(() => {
    if (!daemon.status) return;
    invoke('update_tray_status', {
      pressure: daemon.status.pressure_percent,
      suspended: daemon.status.suspended_count ?? 0,
    }).catch(() => {});
  }, [daemon.status?.pressure_percent, daemon.status?.suspended_count]);

  // ── First-launch disclosure modal ─────────────────────────────────────────
  const [showDisclosure, setShowDisclosure] = useState(() => {
    try { return !localStorage.getItem('mementum-disclosure-shown'); }
    catch { return false; }
  });
  const dismissDisclosure = useCallback(() => {
    try { localStorage.setItem('mementum-disclosure-shown', '1'); } catch {}
    setShowDisclosure(false);
  }, []);

  const handleLimitChange = useCallback((v: CountOption) => {
    setProcessLimit(v);
    try { localStorage.setItem('mementum-proc-count', JSON.stringify(v)); } catch {}
  }, []);

  // ── Settings change handler ────────────────────────────────────────────────
  const handleSettingsChange = useCallback((patch: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // ── Toast ──────────────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t.slice(-2), { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2000);
  }, []);

  // ── Apply theme on change ──────────────────────────────────────────────────
  useEffect(() => { applyTheme(settings.theme); }, [settings.theme]);

  // ── Apply density on change ────────────────────────────────────────────────
  useEffect(() => { applyDensity(settings.layoutDensity); }, [settings.layoutDensity]);

  // ── Initialise theme + density on mount ───────────────────────────────────
  useEffect(() => {
    applyTheme(settings.theme);
    applyDensity(settings.layoutDensity);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard zoom shortcuts (Cmd+Shift+= / – / 0) ─────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.shiftKey)) return;
      let next: number | null = null;
      const cur = settingsRef.current.uiScale;
      if (e.key === '=' || e.key === '+') next = Math.min(130, Math.round((cur + 10) / 5) * 5);
      if (e.key === '-' || e.key === '_') next = Math.max(80,  Math.round((cur - 10) / 5) * 5);
      if (e.key === '0')                  next = 100;
      if (next === null || next === cur)  return;
      e.preventDefault();
      handleSettingsChange({ uiScale: next });
      showToast(`${next}%`);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Notification: optimization events ────────────────────────────────────
  const notifHistoryLen = useRef(-1);
  useEffect(() => {
    if (!settings.desktopNotifications || !settings.notifyOptimization) return;
    if (notifHistoryLen.current === -1) {
      notifHistoryLen.current = daemon.history.length;
      return;
    }
    if (daemon.history.length <= notifHistoryLen.current) return;
    const newCount = daemon.history.length - notifHistoryLen.current;
    notifHistoryLen.current = daemon.history.length;
    daemon.history
      .slice(0, newCount)
      .filter(ev => Date.now() - ev.timestamp.getTime() < 10_000)
      .filter(ev => ev.type === 'suspend' || ev.type === 'optimize')
      .forEach(ev => notify('MEMentum', ev.message));
  }, [daemon.history, settings.desktopNotifications, settings.notifyOptimization]);

  // ── Notification: memory leak ─────────────────────────────────────────────
  const notifiedLeaks = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!settings.desktopNotifications || !settings.notifyMemoryLeak) return;
    if (!daemon.status) return;
    const now = Date.now();
    daemon.status.processes.forEach(p => {
      if (!p.leak_detected) return;
      const last = notifiedLeaks.current.get(p.name) ?? 0;
      if (now - last < 3_600_000) return;
      notifiedLeaks.current.set(p.name, now);
      const name = p.name.charAt(0).toUpperCase() + p.name.slice(1);
      notify('MEMentum: Memory Leak Detected',
        `Possible memory leak: ${name} has grown 50%+ in 30 minutes`);
    });
  }, [daemon.status, settings.desktopNotifications, settings.notifyMemoryLeak]);

  // ── Global mouse tracking (spotlight + magnetic) ─────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      document.documentElement.style.setProperty('--mouse-x', `${e.clientX}px`);
      document.documentElement.style.setProperty('--mouse-y', `${e.clientY}px`);
    };
    window.addEventListener('mousemove', handler, { passive: true });
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  // ── Pressure CSS variable ─────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.setProperty('--pressure', String(daemon.status?.pressure_percent ?? 0));
  }, [daemon.status?.pressure_percent]);

  // ── Focus session live timer ──────────────────────────────────────────────
  const [focusSecs, setFocusSecs] = useState(0);
  useEffect(() => {
    if (!daemon.status?.focus_active) { setFocusSecs(0); return; }
    const base = daemon.status.focus_duration_secs ?? 0;
    const startMs = Date.now() - base * 1000;
    const id = setInterval(() => setFocusSecs(Math.floor((Date.now() - startMs) / 1000)), 1000);
    return () => clearInterval(id);
  }, [daemon.status?.focus_active]);

  // ── Global card tilt handler ───────────────────────────────────────────────
  useEffect(() => {
    let activeCard: HTMLElement | null = null;
    const resetCard = (el: HTMLElement) => {
      el.style.transition    = 'transform 320ms cubic-bezier(0.2,0,0,1), box-shadow 320ms ease-out';
      el.style.transform     = 'perspective(800px) rotateX(0deg) rotateY(0deg)';
      el.style.backgroundImage = '';
      el.style.boxShadow     = '';
    };
    const handleMove = (e: MouseEvent) => {
      const el = (e.target as Element).closest('.tilt-card') as HTMLElement | null;
      if (activeCard && activeCard !== el) resetCard(activeCard);
      activeCard = el;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / rect.width;
      const cy = (e.clientY - rect.top)  / rect.height;
      const rx = +((cy - 0.5) * -6).toFixed(2);
      const ry = +((cx - 0.5) *  6).toFixed(2);
      el.style.transition       = 'transform 100ms ease-out, box-shadow 100ms ease-out';
      el.style.transform        = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      el.style.setProperty('--card-mouse-x', `${(cx*100).toFixed(0)}%`);
      el.style.setProperty('--card-mouse-y', `${(cy*100).toFixed(0)}%`);
      const sx = +((cx - 0.5) * -12).toFixed(0);
      const sy = +(4 + cy * 10).toFixed(0);
      el.style.boxShadow        = `${sx}px ${sy}px 30px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.04)`;
    };
    window.addEventListener('mousemove', handleMove, { passive: true });
    return () => window.removeEventListener('mousemove', handleMove);
  }, []);

  // ── Sidebar indicator position ────────────────────────────────────────────
  const navRefs  = useRef<(HTMLButtonElement | null)[]>([]);
  const sidebarNavRef = useRef<HTMLElement | null>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);

  useEffect(() => {
    const activeIdx = SIDEBAR_ITEMS.findIndex(i => i.key === view);
    const btn = navRefs.current[activeIdx];
    if (!btn || !sidebarNavRef.current) return;
    const navRect = sidebarNavRef.current.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    setIndicatorTop(btnRect.top - navRect.top + btnRect.height / 2 - 10);
  }, [view]);

  // ── Suspendable process count (for smart Optimize button) ────────────────
  const suspendableCount = useMemo(() =>
    daemon.status?.processes.filter(p => p.classification === 'EVICTABLE' && p.status === 'IDLE').length ?? 0,
    [daemon.status?.processes]
  );
  const optimizePulse = suspendableCount > 0 && (daemon.status?.pressure_percent ?? 0) > 70;

  // ── Context window fill ───────────────────────────────────────────────────
  const ctxFill  = daemon.status?.context_fill_percent ?? 0;
  const ctxMins  = daemon.status?.context_minutes_remaining;
  const ctxLevel = ctxFill >= 90 ? 'critical' : ctxFill >= 75 ? 'high' : 'medium';

  // ── Focus timer display ───────────────────────────────────────────────────
  const focusTimerStr = `${String(Math.floor(focusSecs / 60)).padStart(2, '0')}:${String(focusSecs % 60).padStart(2, '0')}`;

  const handleSidebarNav = (key: View) => { setView(key); };

  return (
    <div className="app">
      {/* Context window fill bar — fixed top, only when fill ≥ 50% */}
      {ctxFill >= 50 && (
        <div
          className={`ctx-topbar ctx-topbar--${ctxLevel}`}
          style={{ width: `${Math.min(ctxFill, 100)}%` }}
          title={`Context window ${ctxFill.toFixed(0)}% full${ctxMins ? ` — ${ctxMins.toFixed(0)} minutes until overflow` : ''}`}
          aria-label={`Context window ${ctxFill.toFixed(0)}% full`}
        />
      )}

      {/* Scan line sweep */}
      <div className="scan-line" aria-hidden="true" />

      {/* Animated circuit traces */}
      <CircuitBG enabled={settings.showAnimations} />

      {/* Gold particle field */}
      <Scene3D enabled={settings.showAnimations} />

      {/* Left sidebar — fixed 220px panel, never overlaps content */}
      <aside className="sidebar">
        {/* Logo / wordmark */}
        <div className="sidebar-logo" aria-label="MEMentum">
          <span className="sidebar-wordmark-text">MEMentum</span>
        </div>

        {/* Focus session timer — shown when focus is active */}
        {daemon.status?.focus_active && (
          <button
            className="sidebar-focus-timer"
            onClick={daemon.endFocus}
            title="Click to end focus session"
          >
            <span className="sidebar-focus-dot" />
            <span className="sidebar-focus-label">Focus</span>
            <span className="sidebar-focus-time">{focusTimerStr}</span>
          </button>
        )}

        {/* Navigation */}
        <nav className="sidebar-nav" aria-label="Main navigation" ref={sidebarNavRef}>
          {indicatorTop !== null && (
            <div className="sidebar-indicator" style={{ top: indicatorTop }} aria-hidden="true" />
          )}
          {SIDEBAR_ITEMS.map(({ key, label, LIcon }, idx) => (
            <button
              key={key}
              ref={el => { navRefs.current[idx] = el; }}
              className={`sidebar-item${view === key ? ' active' : ''}`}
              onClick={() => handleSidebarNav(key)}
              aria-current={view === key ? 'page' : undefined}
            >
              <SidebarIcon Icon={LIcon} />
              {label}
            </button>
          ))}
        </nav>

        {/* Footer: connection status + version */}
        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
            <div
              className="sidebar-status-dot"
              role="status"
              aria-label={daemon.connected ? 'Connected' : 'Disconnected'}
              style={{ background: daemon.connected ? 'var(--gold)' : '#2a2a2a', flexShrink: 0 }}
            />
            <span className="sidebar-status-label">
              {daemon.connected ? 'Connected' : 'Disconnected'}
            </span>
            <span className="sidebar-version">v1.0</span>
          </div>
          {daemon.connected && (
            <div className="sidebar-engine-note">
              Engine active — quit from menu bar or Cmd+Q to stop
            </div>
          )}
        </div>
      </aside>

      {/* Main content area — starts exactly 220px from left */}
      <div className="app-body">
        {!daemon.connected ? (
          <DisconnectedView startupFailed={startupFailed} daemonError={daemonError} onRetry={daemon.retry} />
        ) : (
          <div
            key={view}
            className="tab-content"
            style={{ zoom: `${settings.uiScale}%` }}
          >
            {view === 'overview' && (
              <Dashboard daemon={daemon} batterySpeed={settings.batterySpeed} scrollVelocity={scrollVelocity} onNavigate={v => setView(v as View)} />
            )}
            {view === 'processes' && (
              <ProcessList
                daemon={daemon}
                processLimit={processLimit}
                onLimitChange={handleLimitChange}
                showSystemProcesses={settings.showSystemProcesses}
                groupChildProcesses={settings.groupChildProcesses}
              />
            )}
            {view === 'history'  && <History events={daemon.history} compressionHistory={daemon.compressionHistory} />}
            {view === 'models'   && daemon.models && (
              <Models models={daemon.models} status={daemon.status} onOptimize={daemon.optimizeNow} onToast={showToast} />
            )}
            {view === 'models' && !daemon.models && (
              <div className="view">
                <div className="models-empty">
                  <div className="models-empty-icon"><HardDrive size={28} strokeWidth={1.25} /></div>
                  <div className="models-empty-title">Loading model data…</div>
                  <div className="models-empty-sub">Fetching available models from daemon</div>
                </div>
              </div>
            )}
            {view === 'settings' && (
              <Settings
                open={true}
                pageMode={true}
                onClose={() => setView('overview')}
                settings={settings}
                onChange={handleSettingsChange}
                daemon={daemon}
                onToast={showToast}
                processLimit={processLimit}
                onLimitChange={handleLimitChange}
              />
            )}
          </div>
        )}

        {/* Bottom bar */}
        <div className="bottom-bar">
          <span className="bottom-bar-wordmark">MEMentum</span>
          <div className="bottom-bar-center">
            {suspendableCount > 0 ? (
              <MagneticButton
                className={`bottom-optimize-btn${optimizePulse ? ' bottom-optimize-pulse' : ''}`}
                onClick={daemon.optimizeNow}
              >
                Optimize Now
              </MagneticButton>
            ) : (
              <span className="bottom-optimized-label"><CheckCircle2 size={13} strokeWidth={1.5} /> System Optimized</span>
            )}
          </div>
          <div className="bottom-bar-right">
            {daemon.status && (
              <button
                className={`bottom-auto-btn${daemon.status.auto_optimize ? ' active' : ''}`}
                onClick={daemon.toggleAuto}
                aria-label={`Auto-optimize ${daemon.status.auto_optimize ? 'on' : 'off'}`}
              >
                {daemon.status.auto_optimize
                  ? <><span className="auto-dot" />Auto On</>
                  : 'Auto Off'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Toast stack */}
      <div className="toast-container" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="app-toast">{t.msg}</div>
        ))}
      </div>

      {/* First-launch disclosure */}
      {showDisclosure && <DisclosureModal onDismiss={dismissDisclosure} />}
    </div>
  );
}

export default App;
