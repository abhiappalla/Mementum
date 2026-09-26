import type { Process, Classification, ProcessStatus } from '../types';

export interface ProcessGroup {
  baseName: string;
  displayName: string;
  processes: Process[];
  totalMemoryMb: number;
  totalCpu: number;
  classification: Classification;
  groupStatus: ProcessStatus;
  suspendedCount: number;
  hasLeak: boolean;
}

export interface GroupOptions {
  groupChildren?: boolean;
  hideSystemProcesses?: boolean;
}

// macOS system processes to hide when showSystemProcesses is false
const SYSTEM_NAMES = new Set([
  'windowserver', 'kernel_task', 'launchd', 'mdworker', 'mds', 'mds_stores',
  'cfprefsd', 'opendirectoryd', 'configd', 'usereventsagent', 'coreaudiod',
  'bluetoothd', 'locationd', 'securityd', 'trustd', 'logd', 'syslogd',
  'notifyd', 'powerd', 'diskarbitrationd', 'diskimagesiod', 'syspolicyd',
  'watchdogd', 'loginwindow', 'coreduetd', 'ctkd', 'secd', 'akd',
  'mobileassetd', 'nsurlsessiond', 'rapportd', 'sharingd', 'mediaremoted',
  'tccd', 'parentalcontrolsd', 'coreservicesuiagent', 'distnoted',
  'xpcproxy', 'keybagd', 'apsd', 'apfsd', 'aslmanager', 'spindump',
]);

function isSystemProcess(name: string): boolean {
  const lower = name.toLowerCase();
  if (SYSTEM_NAMES.has(lower)) return true;
  if (lower.startsWith('com.apple.')) return true;
  if (lower.startsWith('coreaudio')) return true;
  return false;
}

function stripHelperSuffixes(name: string): string {
  const result = name
    .replace(/\s+Helper(\s*\([^)]*\))?/gi, '')
    .replace(/\s+\([^)]*\)\s*$/g, '')
    .trim();
  return result || name;
}

export function groupProcesses(processes: Process[], options: GroupOptions = {}): ProcessGroup[] {
  const { groupChildren = true, hideSystemProcesses = false } = options;

  let procs = processes;
  if (hideSystemProcesses) {
    procs = procs.filter(p => !isSystemProcess(p.name));
  }

  if (!groupChildren) {
    // Each process is its own card
    return procs.map(p => ({
      baseName: p.name,
      displayName: p.name.charAt(0).toUpperCase() + p.name.slice(1),
      processes: [p],
      totalMemoryMb: p.memory_mb,
      totalCpu: p.cpu_percent,
      classification: p.classification,
      groupStatus: p.status,
      suspendedCount: p.status === 'SUSPENDED' ? 1 : 0,
      hasLeak: !!p.leak_detected,
    })).sort((a, b) => b.totalMemoryMb - a.totalMemoryMb);
  }

  const map = new Map<string, Process[]>();
  for (const proc of procs) {
    const key = stripHelperSuffixes(proc.name).toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(proc);
  }

  const groups: ProcessGroup[] = [];
  for (const [key, groupProcs] of map.entries()) {
    const totalMemoryMb  = groupProcs.reduce((s, p) => s + p.memory_mb, 0);
    const totalCpu       = groupProcs.reduce((s, p) => s + p.cpu_percent, 0);
    const suspendedCount = groupProcs.filter(p => p.status === 'SUSPENDED').length;
    const hasLeak        = groupProcs.some(p => p.leak_detected === true);

    const rep =
      groupProcs.find(p => p.name.toLowerCase() === key) ??
      groupProcs.reduce((best, p) => p.memory_mb > best.memory_mb ? p : best, groupProcs[0]);

    const baseName    = stripHelperSuffixes(rep.name);
    const displayName = baseName.charAt(0).toUpperCase() + baseName.slice(1);

    const groupStatus: ProcessStatus =
      groupProcs.some(p => p.status === 'FOCUSED')    ? 'FOCUSED'   :
      groupProcs.some(p => p.status === 'ACTIVE')     ? 'ACTIVE'    :
      groupProcs.every(p => p.status === 'SUSPENDED') ? 'SUSPENDED' :
      'IDLE';

    groups.push({
      baseName, displayName, processes: groupProcs,
      totalMemoryMb, totalCpu, classification: rep.classification,
      groupStatus, suspendedCount, hasLeak,
    });
  }

  return groups.sort((a, b) => b.totalMemoryMb - a.totalMemoryMb);
}
