import type { DaemonStatus, DailyDigest, CompressionSnapshot, ModelsResponse, BrowserWindowsResponse } from '../types';

const BASE = 'http://127.0.0.1:7779';

let apiToken = '';

export function setApiToken(token: string) {
  apiToken = token;
}

async function post<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiToken) headers['X-MEMentum-Token'] = apiToken;
  const res = await fetch(BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as T;
}

export const api = {
  getStatus:  (limit = 0) => post<DaemonStatus>({ action: 'get_status', ...(limit > 0 ? { limit } : {}) }),
  setOverride: (process: string, cls: string) =>
    post({ action: 'set_override', process, ['class']: cls }),
  optimizeNow: () => post({ action: 'optimize_now' }),
  toggleAuto:  () => post({ action: 'toggle_auto' }),
  startFocus:  (process: string, aggressive = false) =>
    post({ action: 'start_focus', process, ...(aggressive ? { aggressive: true } : {}) }),
  endFocus:    () => post({ action: 'end_focus' }),
  setBudget:   (process: string, limit_mb: number) =>
    post({ action: 'set_budget', process, limit_mb }),
  getDigest:   () => post<DailyDigest>({ action: 'get_digest' }),
  setConfig:    (config: Record<string, unknown>) =>
    post({ action: 'set_config', ...config }).catch(() => null),
  setConfigKey: (key: string, value: unknown) =>
    post({ action: 'set_config', key, value }).catch(() => null),
  getConfig:    () => post<Record<string, unknown>>({ action: 'get_config' }).catch(() => null),
  getCompressionSnapshot: (seconds: number) =>
    post<CompressionSnapshot>({ action: 'get_compression_snapshot', seconds }).catch(() => null),
  getModels: () =>
    post<ModelsResponse>({ action: 'get_models' }).catch(() => null),
  shutdown: () =>
    post({ action: 'shutdown' }).catch(() => null),
  heartbeat: () =>
    post({ action: 'heartbeat' }).catch(() => null),
  getBrowserWindows: () =>
    post<BrowserWindowsResponse>({ action: 'get_browser_windows' }).catch(() => null),
  setWindowProtected: (browser: string, title: string, isProtected: boolean) =>
    post({ action: 'set_window_protected', browser, title, protected: isProtected }).catch(() => null),
};
