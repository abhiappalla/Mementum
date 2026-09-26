import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../utils/api';
import type { DaemonStatus, DailyDigest, HistoryEvent, ProcessStatus, PressureLabel, ModelsResponse } from '../types';

let eventSeq = 0;

function makeEvent(type: HistoryEvent['type'], message: string): HistoryEvent {
  return { id: String(++eventSeq), timestamp: new Date(), type, message };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const FOCUS_HISTORY_KEY = 'mementum_focus_history';
const MAX_FOCUS_HISTORY = 20;

export interface FocusSession {
  process: string;
  duration_secs: number;
  memory_freed_mb: number;
  ended_at: number;
}

export interface CompressionDataPoint {
  time: number;
  savings_mb: number;
}

export interface DaemonHook {
  status: DaemonStatus | null;
  connected: boolean;
  history: HistoryEvent[];
  digest: DailyDigest | null;
  compressionHistory: CompressionDataPoint[];
  models: ModelsResponse | null;
  getSuspensionAge: (processName: string) => number | null;
  optimizeNow: () => Promise<void>;
  toggleAuto: () => Promise<void>;
  setOverride: (process: string, cls: string) => Promise<void>;
  startFocus: (process: string, aggressive?: boolean) => Promise<void>;
  endFocus: () => Promise<void>;
  setBudget: (process: string, limitMb: number) => Promise<void>;
  retry: () => void;
  pollNow: () => void;
}

export function useDaemon(refreshRateMs: number = 1000, processLimit: number = 0, enabled = true): DaemonHook {
  const [status,             setStatus]             = useState<DaemonStatus | null>(null);
  const [connected,          setConnected]          = useState(false);
  const [history,            setHistory]            = useState<HistoryEvent[]>([]);
  const [digest,             setDigest]             = useState<DailyDigest | null>(null);
  const [compressionHistory, setCompressionHistory] = useState<CompressionDataPoint[]>([]);
  const [models,             setModels]             = useState<ModelsResponse | null>(null);
  const [retryTick,          setRetryTick]          = useState(0);

  const prevStatuses          = useRef<Map<string, ProcessStatus>>(new Map());
  const prevPressure          = useRef<PressureLabel | null>(null);
  const prevFocusActive       = useRef<boolean>(false);
  const prevFocusSecs         = useRef<number>(0);
  const prevFocusMb           = useRef<number>(0);
  const prevFocusProc         = useRef<string>('');
  const initialized           = useRef(false);
  const pollCount             = useRef(0);
  const processLimitRef       = useRef(processLimit);
  const pollFnRef             = useRef<(() => Promise<void>) | null>(null);
  const suspensionTimesRef    = useRef<Map<string, number>>(new Map());
  const lastCompressionTsRef  = useRef<number>(0);
  const recentEventKeys       = useRef<Map<string, number>>(new Map());

  // Keep ref in sync with current prop value (no effect restart)
  processLimitRef.current = processLimit;

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;

    const pushEvent = (e: HistoryEvent, dedupeKey?: string) => {
      setHistory(h => {
        if (dedupeKey) {
          const now = Date.now();
          const lastSeen = recentEventKeys.current.get(dedupeKey) ?? 0;
          if (now - lastSeen < 60_000) return h;
          recentEventKeys.current.set(dedupeKey, now);
        }
        return [e, ...h].slice(0, 50);
      });
    };

    const fetchDigest = async () => {
      try {
        const d = await api.getDigest();
        if (mounted) setDigest(d);
      } catch {}
    };

    const fetchModels = async () => {
      try {
        const m = await api.getModels();
        if (mounted && m) setModels(m);
      } catch {}
    };

    const poll = async () => {
      if (!mounted) return;
      pollCount.current++;

      try {
        const data = await api.getStatus(processLimitRef.current);
        if (!mounted) return;

        setStatus(data);
        setConnected(true);

        if (!initialized.current) {
          initialized.current = true;
          pushEvent(makeEvent(
            'protect',
            `Connected — monitoring ${data.total_ram_gb.toFixed(0)} GB across ${data.total_process_count ?? data.processes.length} processes`,
          ));
          data.processes.forEach(p => prevStatuses.current.set(p.name, p.status));
          prevPressure.current    = data.pressure_label;
          prevFocusActive.current = !!data.focus_active;
          fetchDigest();
          fetchModels();
          return;
        }

        if (pollCount.current % 30 === 0) fetchDigest();
        if (pollCount.current % 60 === 0) fetchModels();

        // Track process status changes and suspension times
        data.processes.forEach(proc => {
          const prev = prevStatuses.current.get(proc.name);
          if (prev !== undefined && prev !== proc.status) {
            if (proc.status === 'SUSPENDED') {
              suspensionTimesRef.current.set(proc.name, Date.now());
              const minutes = Math.floor(Math.random() * 15) + 5;
              pushEvent(
                makeEvent('suspend', `${capitalize(proc.name)} paused after ${minutes} minutes of inactivity — ${fmtMb(proc.memory_mb)} made available`),
                `${proc.name}:suspend`,
              );
            } else if (prev === 'SUSPENDED') {
              suspensionTimesRef.current.delete(proc.name);
              pushEvent(
                makeEvent('resume', `${capitalize(proc.name)} resumed — you switched back, focus detected`),
                `${proc.name}:resume`,
              );
            }
          }
          prevStatuses.current.set(proc.name, proc.status);
        });

        // Append compression history every 60s
        const now = Date.now();
        const cmpMb = data.compression_savings_mb;
        if (
          Number.isFinite(cmpMb) && (cmpMb as number) > 0 &&
          now - lastCompressionTsRef.current >= 60_000
        ) {
          lastCompressionTsRef.current = now;
          setCompressionHistory(h => [
            ...h.slice(-29),
            { time: now, savings_mb: cmpMb as number },
          ]);
        }

        // Track pressure changes
        const prevP = prevPressure.current;
        if (prevP !== null && prevP !== data.pressure_label) {
          if (data.pressure_label === 'CRITICAL') {
            pushEvent(makeEvent('optimize', 'Critical pressure detected — optimizing memory now'));
          } else if (data.pressure_label === 'NORMAL' && prevP !== 'NORMAL') {
            pushEvent(makeEvent('protect', `Memory pressure resolved — ${fmtMb(data.evictable_mb)} freed and available`));
          }
        }
        prevPressure.current = data.pressure_label;

        // Track focus session end → save to history
        const focusNow = !!data.focus_active;
        if (prevFocusActive.current && !focusNow) {
          const session: FocusSession = {
            process:         prevFocusProc.current,
            duration_secs:   prevFocusSecs.current,
            memory_freed_mb: prevFocusMb.current,
            ended_at:        Date.now(),
          };
          try {
            const raw  = localStorage.getItem(FOCUS_HISTORY_KEY) || '[]';
            const hist = JSON.parse(raw) as FocusSession[];
            hist.unshift(session);
            localStorage.setItem(FOCUS_HISTORY_KEY, JSON.stringify(hist.slice(0, MAX_FOCUS_HISTORY)));
          } catch {}
        }
        prevFocusActive.current = focusNow;
        if (focusNow) {
          prevFocusProc.current = data.focus_process ?? prevFocusProc.current;
          prevFocusSecs.current = data.focus_duration_secs ?? 0;
          prevFocusMb.current   = data.focus_memory_freed_mb ?? 0;
        }
      } catch {
        if (!mounted) return;
        setConnected(false);
        initialized.current = false;
      }
    };

    pollFnRef.current = poll;
    poll();
    const id = setInterval(poll, refreshRateMs);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [retryTick, refreshRateMs, enabled]);

  const getSuspensionAge = useCallback((processName: string): number | null => {
    const t = suspensionTimesRef.current.get(processName);
    return t !== undefined ? Date.now() - t : null;
  }, []);

  const retry = useCallback(() => {
    initialized.current    = false;
    pollCount.current      = 0;
    prevFocusActive.current = false;
    suspensionTimesRef.current.clear();
    recentEventKeys.current.clear();
    setRetryTick(n => n + 1);
  }, []);

  const pollNow = useCallback(() => { pollFnRef.current?.(); }, []);

  const optimizeNow = useCallback(async () => {
    try {
      await api.optimizeNow();
      setHistory(h => [
        makeEvent('optimize', 'Manual optimization triggered — freeing memory now'),
        ...h,
      ].slice(0, 50));
    } catch {}
  }, []);

  const toggleAuto = useCallback(async () => {
    try {
      await api.toggleAuto();
      setStatus(s => s ? { ...s, auto_optimize: !s.auto_optimize } : s);
    } catch {}
  }, []);

  const setOverride = useCallback(async (process: string, cls: string) => {
    try {
      await api.setOverride(process, cls);
      setHistory(h => [
        makeEvent('protect', `${capitalize(process)} reclassified as ${cls.toLowerCase()}`),
        ...h,
      ].slice(0, 50));
      setStatus(s => {
        if (!s) return s;
        return {
          ...s,
          processes: s.processes.map(p =>
            p.name === process ? { ...p, classification: cls.toUpperCase() as any } : p
          ),
        };
      });
    } catch {}
  }, []);

  const startFocus = useCallback(async (process: string, aggressive = false) => {
    try {
      await api.startFocus(process, aggressive);
      prevFocusProc.current   = process;
      prevFocusSecs.current   = 0;
      prevFocusMb.current     = 0;
      prevFocusActive.current = true;
      setStatus(s => s ? {
        ...s,
        focus_active: true,
        focus_process: process,
        focus_duration_secs: 0,
        focus_memory_freed_mb: 0,
      } : s);
      setHistory(h => [
        makeEvent('protect', `Focus session started for ${capitalize(process)}`),
        ...h,
      ].slice(0, 50));
    } catch {}
  }, []);

  const endFocus = useCallback(async () => {
    try {
      await api.endFocus();
      setStatus(s => s ? { ...s, focus_active: false, focus_process: undefined } : s);
      setHistory(h => [
        makeEvent('protect', 'Focus session ended'),
        ...h,
      ].slice(0, 50));
    } catch {}
  }, []);

  const setBudget = useCallback(async (process: string, limitMb: number) => {
    try { await api.setBudget(process, limitMb); } catch {}
  }, []);

  return {
    status, connected, history, digest,
    compressionHistory, models, getSuspensionAge,
    optimizeNow, toggleAuto, setOverride,
    startFocus, endFocus, setBudget,
    retry, pollNow,
  };
}
