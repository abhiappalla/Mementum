import React from 'react';

export type LayoutMode = 'grid' | 'list' | 'compact';

// ── Persistent preference per page ────────────────────────────────────────────
const key = (page: string) => `mementum-layout-${page}`;
export function getLayoutPref(page: string, def: LayoutMode = 'grid'): LayoutMode {
  try { return (localStorage.getItem(key(page)) as LayoutMode) || def; }
  catch { return def; }
}
export function setLayoutPref(page: string, mode: LayoutMode) {
  try { localStorage.setItem(key(page), mode); } catch {}
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────
function GridIcon() {
  return (
    <svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor" aria-hidden="true">
      <rect x="0" y="0" width="6" height="6" rx="1"/><rect x="8" y="0" width="6" height="6" rx="1"/>
      <rect x="0" y="8" width="6" height="6" rx="1"/><rect x="8" y="8" width="6" height="6" rx="1"/>
    </svg>
  );
}
function ListIcon() {
  return (
    <svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor" aria-hidden="true">
      <rect x="0" y="1"    width="14" height="2.5" rx="1"/>
      <rect x="0" y="5.75" width="14" height="2.5" rx="1"/>
      <rect x="0" y="10.5" width="14" height="2.5" rx="1"/>
    </svg>
  );
}
function CompactIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
      <rect x="0" y="0" width="4.5" height="4.5" rx="0.8"/>
      <rect x="5.75" y="0" width="4.5" height="4.5" rx="0.8"/>
      <rect x="11.5" y="0" width="4.5" height="4.5" rx="0.8"/>
      <rect x="0" y="5.75" width="4.5" height="4.5" rx="0.8"/>
      <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.8"/>
      <rect x="11.5" y="5.75" width="4.5" height="4.5" rx="0.8"/>
      <rect x="0" y="11.5" width="4.5" height="4.5" rx="0.8"/>
      <rect x="5.75" y="11.5" width="4.5" height="4.5" rx="0.8"/>
      <rect x="11.5" y="11.5" width="4.5" height="4.5" rx="0.8"/>
    </svg>
  );
}

const MODES: { mode: LayoutMode; Icon: () => React.ReactElement; title: string }[] = [
  { mode: 'grid',    Icon: GridIcon,    title: 'Grid view'    },
  { mode: 'list',    Icon: ListIcon,    title: 'List view'    },
  { mode: 'compact', Icon: CompactIcon, title: 'Compact view' },
];

interface Props { value: LayoutMode; onChange: (m: LayoutMode) => void; }

export function LayoutToggle({ value, onChange }: Props) {
  return (
    <div className="layout-toggle">
      {MODES.map(({ mode, Icon, title }) => (
        <button
          key={mode}
          className={`layout-btn${value === mode ? ' active' : ''}`}
          onClick={() => onChange(mode)}
          title={title}
          aria-pressed={value === mode}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
