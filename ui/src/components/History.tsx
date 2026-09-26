import { useState, useEffect, useRef } from 'react';
import { LayoutToggle } from './LayoutToggle';
import type { LayoutMode } from './LayoutToggle';
import type { HistoryEvent } from '../types';
import type { CompressionDataPoint } from '../hooks/useDaemon';

interface Props {
  events: HistoryEvent[];
  compressionHistory?: CompressionDataPoint[];
}


function EmptyIcon() {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="5" width="18" height="24" rx="3"/>
      <path d="M12 5 C12 3.5 13.5 2.5 16 2.5 C18.5 2.5 20 3.5 20 5"/>
      <line x1="11" y1="13" x2="21" y2="13"/>
      <line x1="11" y1="17" x2="18" y2="17"/>
      <line x1="11" y1="21" x2="15" y2="21"/>
    </svg>
  );
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function timeAgo(date: Date, now: number): string {
  const s = Math.floor((now - date.getTime()) / 1000);
  if (s < 5)    return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date): string {
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (isToday) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth();
  if (isYesterday) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'long', day: 'numeric' });
}

function isRecent(date: Date): boolean {
  return Date.now() - date.getTime() < 60_000;
}

function groupByDay(events: HistoryEvent[]): Map<string, HistoryEvent[]> {
  const groups = new Map<string, HistoryEvent[]>();
  for (const ev of events) {
    const key = formatDate(ev.timestamp);
    const existing = groups.get(key) ?? [];
    existing.push(ev);
    groups.set(key, existing);
  }
  return groups;
}

// ── Compression Over Time SVG chart ──────────────────────────────────────────
const CHART_W = 400;
const CHART_H = 72;
const PAD_L   = 38;
const PAD_R   = 8;
const PAD_T   = 8;
const PAD_B   = 20;
const INNER_W  = CHART_W - PAD_L - PAD_R;
const INNER_H  = CHART_H - PAD_T - PAD_B;

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

function CompressionChart({ data }: { data: CompressionDataPoint[] }) {
  const containerRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) {
    return (
      <div className="cmp-timeline-empty">
        Compression data will appear here after processes have been suspended for at least 2 minutes.
      </div>
    );
  }

  const now       = Date.now();
  const windowMs  = 30 * 60 * 1000; // 30 min
  const startTime = now - windowMs;

  // Filter to last 30 minutes and add "now" endpoint
  const pts = data
    .filter(d => d.time >= startTime)
    .concat({ time: now, savings_mb: data[data.length - 1].savings_mb });

  if (pts.length < 2) {
    return (
      <div className="cmp-timeline-empty">
        Not enough data yet — check back after a few minutes.
      </div>
    );
  }

  const maxMb = Math.max(...pts.map(p => p.savings_mb), 1);

  function toX(t: number): number {
    return PAD_L + ((t - startTime) / windowMs) * INNER_W;
  }
  function toY(mb: number): number {
    return PAD_T + INNER_H - (mb / maxMb) * INNER_H;
  }

  // Build SVG path
  const linePoints = pts.map(p => `${toX(p.time).toFixed(1)},${toY(p.savings_mb).toFixed(1)}`).join(' ');
  const areaPath = [
    `M ${toX(pts[0].time).toFixed(1)},${(PAD_T + INNER_H).toFixed(1)}`,
    ...pts.map(p => `L ${toX(p.time).toFixed(1)},${toY(p.savings_mb).toFixed(1)}`),
    `L ${toX(pts[pts.length - 1].time).toFixed(1)},${(PAD_T + INNER_H).toFixed(1)}`,
    'Z',
  ].join(' ');

  // Y-axis labels
  const yTicks = [0, maxMb * 0.5, maxMb].map(v => ({ v, y: toY(v) }));

  // X-axis labels: every 10 minutes
  const xTicks: { label: string; x: number }[] = [];
  for (let i = 0; i <= 3; i++) {
    const t = startTime + (i / 3) * windowMs;
    const minsAgo = Math.round((now - t) / 60_000);
    xTicks.push({ label: minsAgo === 0 ? 'now' : `${minsAgo}m`, x: toX(t) });
  }

  return (
    <svg
      ref={containerRef}
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      height={CHART_H}
      className="cmp-timeline-svg"
      aria-label="Compression over time chart"
    >
      <defs>
        <linearGradient id="cmp-area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="rgba(212,175,55,0.22)" />
          <stop offset="100%" stopColor="rgba(212,175,55,0.01)" />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {yTicks.map(({ v, y }) => (
        <g key={v}>
          <line x1={PAD_L} y1={y} x2={CHART_W - PAD_R} y2={y}
            stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
          <text x={PAD_L - 4} y={y + 3.5} textAnchor="end"
            fontSize="8" fill="rgba(255,255,255,0.25)" fontFamily="var(--font-mono)">
            {fmtMb(v)}
          </text>
        </g>
      ))}

      {/* Area fill */}
      <path d={areaPath} fill="url(#cmp-area-grad)" />

      {/* Line */}
      <polyline points={linePoints}
        fill="none" stroke="rgba(212,175,55,0.85)" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />

      {/* Data points */}
      {pts.map((p, i) => (
        <circle key={i} cx={toX(p.time)} cy={toY(p.savings_mb)} r="2.5"
          fill="var(--gold)" stroke="rgba(0,0,0,0.6)" strokeWidth="1" />
      ))}

      {/* X axis labels */}
      {xTicks.map(({ label, x }) => (
        <text key={label} x={x} y={CHART_H - 4} textAnchor="middle"
          fontSize="8" fill="rgba(255,255,255,0.25)" fontFamily="var(--font-sans)">
          {label}
        </text>
      ))}

      {/* X baseline */}
      <line x1={PAD_L} y1={PAD_T + INNER_H} x2={CHART_W - PAD_R} y2={PAD_T + INNER_H}
        stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
    </svg>
  );
}

// ── Main History view ─────────────────────────────────────────────────────────
export function History({ events, compressionHistory = [] }: Props) {
  const now = useNow(1000);
  const [layout, setLayout] = useState<LayoutMode>(
    () => (localStorage.getItem('mementum-layout-history') as LayoutMode) || 'grid'
  );
  const handleLayout = (m: LayoutMode) => {
    setLayout(m);
    try { localStorage.setItem('mementum-layout-history', m); } catch {}
  };

  if (events.length === 0) {
    return (
      <div className="view">
        <div className="history-empty">
          <div className="history-empty-icon"><EmptyIcon /></div>
          <div className="history-empty-title">No history yet</div>
          <div className="history-empty-sub">
            MEMentum will record memory events here as it protects your system.
          </div>
        </div>
      </div>
    );
  }

  const groups = groupByDay(events);

  return (
    <div className="view">
      {/* ── Compression Over Time chart ── */}
      {compressionHistory.length > 0 && (
        <div className="cmp-timeline-card tilt-card">
          <div className="section-header" style={{ marginBottom: 12 }}>
            <span className="section-title">Compression Over Time</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>last 30 min</span>
          </div>
          <CompressionChart data={compressionHistory} />
        </div>
      )}

      <div className="section-header" style={{ marginBottom: 16 }}>
        <span className="section-title">Activity Log</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {events.length} event{events.length !== 1 ? 's' : ''}
          </span>
          <LayoutToggle value={layout} onChange={handleLayout} />
        </div>
      </div>

      <div className="history-timeline">
        {Array.from(groups.entries()).map(([day, dayEvents]) => (
          <div key={day} className="history-day">
            <div className="history-day-sep">
              <div className="history-day-line" />
              <div className="history-day-label">{day}</div>
              <div className="history-day-line" />
            </div>
            {dayEvents.map(ev => (
              <div key={ev.id} className={`history-tl-row${isRecent(ev.timestamp) ? ' history-tl-row--fresh' : ''}`}>
                <div className="history-tl-left">
                  <div className="history-tl-line" />
                  <div className={`history-tl-dot history-tl-dot--${ev.type}`} aria-hidden="true" />
                </div>
                <div className="history-tl-body">
                  <span className="history-tl-message">{ev.message}</span>
                  <span className="history-tl-time">{timeAgo(ev.timestamp, now)} · {formatTime(ev.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
