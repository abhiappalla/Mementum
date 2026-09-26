export type PressureLabel = 'NORMAL' | 'MODERATE' | 'CRITICAL';
export type ProcessStatus = 'SUSPENDED' | 'FOCUSED' | 'ACTIVE' | 'IDLE';
export type Classification = 'PROTECTED' | 'NEUTRAL' | 'EVICTABLE';

export interface Process {
  name: string;
  pid: number;
  memory_mb: number;
  cpu_percent: number;
  classification: Classification;
  status: ProcessStatus;
  leak_detected?: boolean;
  compression_savings_mb?: number;
}

export interface CompressionInterval {
  interval_secs: number;
  savings_mb: number;
}

export interface CompressionSnapshot {
  seconds: number;
  savings_mb: number;
  frozen_mb: number;
  pct: number;
}

export interface DaemonStatus {
  total_ram_gb: number;
  used_ram_gb: number;
  pressure_percent: number;
  pressure_label: PressureLabel;
  suspended_count: number;
  foreground_app: string;
  processes: Process[];
  total_process_count?: number;
  protected_mb: number;
  evictable_mb: number;
  auto_optimize: boolean;
  cpu_temperature?: number;
  focus_active?: boolean;
  focus_process?: string;
  focus_duration_secs?: number;
  focus_memory_freed_mb?: number;
  compression_savings_mb?: number;
  compression_timeline?: CompressionInterval[];
  electron_suspended_count?: number;
  ai_inference_active?: boolean;
  ai_tool?: string;
  ai_preemptive_clear_mb?: number;
  dependency_checks_skipped?: number;
  model_load_prepared?: boolean;
  model_prep_freed_mb?: number;
  // Context window tracking (when Ollama/LLM is active)
  context_fill_percent?: number;
  context_growth_rate?: number;
  context_warning_level?: number;
  context_minutes_remaining?: number;
  // Memory breakdown (from vm_stat)
  wired_mb?: number;
  compressed_mb?: number;
  cached_mb?: number;
  app_mb?: number;
  untracked_mb?: number;
}

export interface DailyDigest {
  total_mb_freed_today: number;
  total_suspensions_today: number;
  total_resumes_today: number;
  longest_protected_session_min: number;
  keepalive_events_today?: number;
  dependency_checks_skipped?: number;
}

export interface LocalModel {
  name: string;
  file_size_gb: number;
  can_fit: boolean;
  quantization?: string;
  parameter_count?: string;
  context_length?: number;
  last_used?: string;
  estimated_ram_mb?: number;
  estimated_kv_cache_mb?: number;
  total_required_mb?: number;
  mb_to_free?: number;
}

export interface ModelsResponse {
  models: LocalModel[];
  total_available_mb: number;
  model_load_prepared?: boolean;
  model_prep_freed_mb?: number;
}

export interface BrowserWindow {
  browser: string;
  title: string;
  protected: boolean;
}

export interface BrowserWindowsResponse {
  windows: BrowserWindow[];
}

export interface HistoryEvent {
  id: string;
  timestamp: Date;
  message: string;
  type: 'suspend' | 'resume' | 'optimize' | 'protect';
}
