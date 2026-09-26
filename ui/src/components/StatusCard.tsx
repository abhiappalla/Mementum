import type { DaemonStatus } from '../types';

interface Props {
  status: DaemonStatus;
  className?: string;
}

function getStatusMessage(status: DaemonStatus): string {
  if (status.pressure_label === 'NORMAL')   return 'Everything is optimized';
  if (status.pressure_label === 'MODERATE') return 'Protecting your workload';
  if (status.suspended_count > 0)           return 'Freeing memory now';
  return 'Optimizing memory...';
}

function getStatusSub(status: DaemonStatus): string {
  const autoStr = `auto-optimize ${status.auto_optimize ? 'on' : 'off'}`;
  if (status.pressure_label === 'NORMAL') {
    const focus = status.foreground_app ? `${status.foreground_app} is in focus · ` : '';
    return `${focus}${autoStr}`;
  }
  if (status.pressure_label === 'MODERATE') {
    return `${status.pressure_percent.toFixed(0)}% pressure · scanning for idle processes · ${autoStr}`;
  }
  return `${status.suspended_count} process${status.suspended_count !== 1 ? 'es' : ''} paused · reclaiming memory`;
}

const PRESSURE_COLOR: Record<string, string> = {
  NORMAL:   '#4ade80',
  MODERATE: '#f97316',
  CRITICAL: '#ef4444',
};

export function StatusCard({ status, className }: Props) {
  const accentColor = PRESSURE_COLOR[status.pressure_label] ?? '#C0C0C0';
  const cls = ['status-card', className].filter(Boolean).join(' ');

  return (
    <div className={cls} data-pressure={status.pressure_label}>
      {/* Thin colored top border accent */}
      <div style={{
        position: 'absolute',
        top: 0, left: 24, right: 24,
        height: 1,
        background: `linear-gradient(90deg, transparent, ${accentColor}55, transparent)`,
        borderRadius: 1,
      }} />

      <div className="status-label">System Status</div>

      <div className="status-message">{getStatusMessage(status)}</div>

      <div className="status-sub">
        <span className="status-dot" data-pressure={status.pressure_label} />
        <span style={{ color: 'var(--text-secondary)' }}>{getStatusSub(status)}</span>
      </div>
    </div>
  );
}
