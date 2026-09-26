import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ProcessStatus, Classification } from '../types';

// ── Module-level icon cache (persists across re-renders, cleared on page reload) ──
const iconCache = new Map<string, string | null>();

// ── Process name → favicon domain fallback map ───────────────────────────────
const FAVICON_MAP: [string[], string][] = [
  [['chrome'],              'google.com'],
  [['firefox'],             'mozilla.org'],
  [['safari'],              'apple.com'],
  [['arc'],                 'arc.net'],
  [['whatsapp'],            'whatsapp.com'],
  [['slack'],               'slack.com'],
  [['discord'],             'discord.com'],
  [['telegram'],            'telegram.org'],
  [['zoom'],                'zoom.us'],
  [['spotify', 'music'],    'spotify.com'],
  [['figma'],               'figma.com'],
  [['notion'],              'notion.so'],
  [['linear'],              'linear.app'],
  [['obsidian'],            'obsidian.md'],
  [['ollama'],              'ollama.com'],
  [['claude'],              'claude.ai'],
  [['docker'],              'docker.com'],
  [['node', 'nodejs'],      'nodejs.org'],
  [['python'],              'python.org'],
  [['xcode'],               'developer.apple.com'],
  [['vscode'],              'code.visualstudio.com'],
  [['cursor'],              'cursor.sh'],
  [['warp'],                'warp.dev'],
  [['iterm'],               'iterm2.com'],
  [['ghostty'],             'ghostty.org'],
  [['nova'],                'nova.app'],
  [['tower'],               'git-tower.com'],
  [['tableplus'],           'tableplus.com'],
  [['sequel pro', 'sequel'],'sequelpro.com'],
  [['proxyman'],            'proxyman.io'],
  [['ray'],                 'myray.app'],
  [['tinkerwell'],          'tinkerwell.app'],
];

function getFaviconUrl(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [keys, domain] of FAVICON_MAP) {
    if (keys.some(k => lower.includes(k))) {
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    }
  }
  return null;
}

// ── DefaultIcon: gold initial letter on subtle dark background ───────────────
function DefaultIcon({ name }: { name: string }) {
  const initial = (name[0] ?? '?').toUpperCase();
  return (
    <div style={{
      width: 24, height: 24,
      borderRadius: 6,
      background: 'rgba(212,175,55,0.1)',
      border: '1px solid rgba(212,175,55,0.15)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <span style={{
        color: '#D4AF37',
        fontWeight: 600,
        fontSize: 11,
        lineHeight: 1,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
        userSelect: 'none',
      }}>
        {initial}
      </span>
    </div>
  );
}

// ── Icon content with async resolution ───────────────────────────────────────
function IconContent({ name, dimmed }: { name: string; dimmed: boolean }) {
  const [src, setSrc] = useState<string | null>(() => iconCache.get(name) ?? null);
  const [resolved, setResolved] = useState(() => iconCache.has(name));

  useEffect(() => {
    if (iconCache.has(name)) {
      setSrc(iconCache.get(name) ?? null);
      setResolved(true);
      return;
    }

    let cancelled = false;

    async function resolve() {
      // Step 1: Native macOS icon via Tauri
      try {
        const dataUrl = await invoke<string | null>('get_app_icon', { appName: name });
        if (!cancelled && dataUrl) {
          iconCache.set(name, dataUrl);
          setSrc(dataUrl);
          setResolved(true);
          return;
        }
      } catch {
        // Not in Tauri context or icon not found — fall through
      }

      if (cancelled) return;

      // Step 2: Google favicon service
      const faviconUrl = getFaviconUrl(name);
      if (faviconUrl) {
        const img = new Image();
        img.onload = () => {
          if (!cancelled) {
            iconCache.set(name, faviconUrl);
            setSrc(faviconUrl);
            setResolved(true);
          }
        };
        img.onerror = () => {
          if (!cancelled) {
            iconCache.set(name, null);
            setSrc(null);
            setResolved(true);
          }
        };
        img.src = faviconUrl;
        return;
      }

      // Step 3: DefaultIcon (handled by null src)
      iconCache.set(name, null);
      setSrc(null);
      setResolved(true);
    }

    resolve();
    return () => { cancelled = true; };
  }, [name]);

  return (
    <div className={`app-icon-inner${dimmed ? ' app-icon-dimmed' : ''}`}>
      {resolved && src ? (
        <img
          src={src}
          alt={name}
          width="28"
          height="28"
          style={{
            borderRadius: 6,
            display: 'block',
            objectFit: 'cover',
            width: 28,
            height: 28,
          }}
        />
      ) : (
        <DefaultIcon name={name} />
      )}
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────
interface Props {
  name: string;
  status: ProcessStatus;
  classification: Classification;
}

export function AppIcon({ name, status, classification }: Props) {
  const isSuspended = status === 'SUSPENDED';
  const isFocused   = status === 'FOCUSED';
  const isProtected = classification === 'PROTECTED';

  return (
    <div className={`app-icon-outer${isFocused ? ' focused-ring' : ''}`}>
      <IconContent name={name} dimmed={isSuspended} />

      {isProtected && !isSuspended && (
        <div className="app-icon-shield" title="Protected">
          <svg viewBox="0 0 10 11" width="10" height="11" aria-hidden="true">
            <path d="M5 0.5 L9.5 2 L9.5 5.5 C9.5 8.2 5 10.5 5 10.5 C5 10.5 0.5 8.2 0.5 5.5 L0.5 2 Z" fill="#D4AF37"/>
          </svg>
        </div>
      )}

      {isSuspended && (
        <div className="app-icon-pause" title="Suspended">
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <rect x="1.5" y="1.5" width="3.5" height="9" rx="1.2" fill="#D4AF37"/>
            <rect x="7"   y="1.5" width="3.5" height="9" rx="1.2" fill="#D4AF37"/>
          </svg>
        </div>
      )}
    </div>
  );
}
