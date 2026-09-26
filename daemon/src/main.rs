mod classifier;
mod config;
mod dependency;
mod model_inspector;
mod monitor;
mod platform;
mod port_monitor;
mod socket;

use classifier::{classify, is_electron_app, is_main_browser_process, is_never_suspend, ActivityTracker, Classification};
use dependency::DependencyMap;
use port_monitor::PortMonitor;
use config::{Config, DailyDigest};
use platform::get_platform;
use platform::{MemoryBreakdown, PlatformMemory};
use socket::{SocketServer, DaemonStatus, ProcessInfo, SHUTDOWN_REQUESTED};
use sysinfo::System;
use std::thread;
use std::time::{Duration, Instant};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::collections::{HashMap, HashSet, VecDeque};

fn main() {
    println!("=== MEMentum Daemon v0.1 ===");
    println!("Loading config...");

    let mut config = Config::load();
    let platform = get_platform();

    println!("Auto-optimize: {}", config.auto_optimize);
    println!("Pressure threshold: {}%", config.pressure_threshold);
    println!("Resume threshold: {}%", config.resume_threshold);
    println!("User overrides: {}", config.overrides.len());
    println!();

    recover_suspended_pids();

    let daemon_start = Instant::now();

    let server = SocketServer::new();
    let last_heartbeat = server.last_heartbeat();
    server.start();
    println!("Socket server started on 127.0.0.1:7779");
    eprintln!("[startup] MEMentum daemon started — waiting for UI heartbeat (30s grace period)");

    let mut sys = System::new_all();
    let mut tracker = ActivityTracker::new(config.idle_timeout_secs);

    // Maps PID -> (process name, time suspended)
    let suspended_pids: Arc<Mutex<HashMap<u32, (String, Instant)>>> = Arc::new(Mutex::new(HashMap::new()));
    let running = Arc::new(AtomicBool::new(true));

    let suspended_clone = Arc::clone(&suspended_pids);
    let running_clone = Arc::clone(&running);

    ctrlc::set_handler(move || {
        println!("\n⚠️  MEMentum shutting down — resuming all suspended processes...");
        let pids = suspended_clone.lock().unwrap();
        for (pid, _) in pids.iter() {
            unsafe {
                if libc::kill(*pid as i32, libc::SIGCONT) == 0 {
                    println!("  ▶  Resumed PID {}", pid);
                }
            }
        }
        let _ = std::fs::remove_file(recovery_path());
        println!("MEMentum: all processes resumed. Goodbye.");
        running_clone.store(false, Ordering::SeqCst);
        std::process::exit(0);
    }).expect("Error setting Ctrl+C handler");

    let mut cycle: u32 = 0;
    let mut foreground_cache = String::new();
    let mut frontmost_window_title_cache = String::new();
    let mut cpu_temp_cache: f64 = 0.0;

    // Maps PID -> original nice value (before we lowered it at MODERATE pressure)
    let mut nicened_pids: HashMap<u32, i32> = HashMap::new();
    // Maps PID -> rolling window of (timestamp, memory_bytes) samples for leak detection
    let mut memory_history: HashMap<u32, VecDeque<(Instant, u64)>> = HashMap::new();
    // Anti-thrash cooldowns: track when each PID was last suspended / resumed
    let mut last_suspended_at: HashMap<u32, Instant> = HashMap::new();
    let mut last_resumed_at:   HashMap<u32, Instant> = HashMap::new();
    // Smart eviction: resume frequency by process name, resets at midnight
    let mut resume_frequency_today: HashMap<String, u32> = HashMap::new();
    // Smart eviction: last time each PID had CPU activity
    let mut last_active_at: HashMap<u32, Instant> = HashMap::new();
    // Adaptive threshold: pressure readings recorded at foreground app switches
    let mut pressure_at_user_activity: Vec<f64> = Vec::new();
    // Adaptive threshold: previous foreground app for change detection
    let mut prev_foreground = String::new();
    // Log deduplication: suppress repeated same-action messages for a PID within 5 min
    let mut last_logged: HashMap<u32, (String, Instant)> = HashMap::new();
    // RSS at time of suspension, used to measure how much macOS naturally compressed each PID
    let mut initial_rss_at_suspension: HashMap<u32, u64> = HashMap::new();
    // Track which suspended PIDs have already had their 10-second compression check logged
    let mut compression_logged: HashSet<u32> = HashSet::new();
    // Thrash guard: how many times each PID has been suspended this calendar day
    let mut suspension_counts: HashMap<u32, u32> = HashMap::new();
    // Count of suspension attempts blocked by dependency checks (tracked via [dep-check] logs)
    let dep_skipped_today: u32 = 0;

    // AI inference detection
    let mut port_monitor = PortMonitor::new();
    let mut ai_inference_active = false;
    let mut ai_tool = String::from("none");
    let mut ai_preemptive_clear_mb: u64 = 0;

    // Model metadata cache — scanned every 60s unconditionally
    let mut detected_models: Vec<model_inspector::ModelInfo> = Vec::new();
    let mut last_model_scan: Option<std::time::Instant> = None;
    let mut model_load_prepared = false;
    let mut model_prep_freed_mb: u64 = 0;

    // Context window tracking — poll timer; state lives on port_monitor
    let mut last_ollama_poll: Option<std::time::Instant> = None;

    // Memory breakdown cache — refreshed every 5 cycles via vm_stat
    let mut memory_breakdown_cache = MemoryBreakdown::default();

    // Electron keepalive layer — keeps Electron app timers alive during suspension
    struct ElectronSuspendInfo {
        suspended_at: Instant,
        last_keepalive: Instant,
        process_name: String,
    }
    let electron_pids: Arc<Mutex<HashMap<u32, ElectronSuspendInfo>>> = Arc::new(Mutex::new(HashMap::new()));
    let keepalive_count_today: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

    // Spawn the keepalive thread — fires every 5s, pulses electron PIDs every 30s
    {
        let el_pids = Arc::clone(&electron_pids);
        let kl_count = Arc::clone(&keepalive_count_today);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(5));

                let map_len = el_pids.lock().unwrap().len();
                eprintln!("[keepalive-thread] alive, checking {} electron pids", map_len);

                // Collect PIDs due for a heartbeat (>30s since last keepalive)
                let to_pulse: Vec<(u32, String, u64)> = {
                    let map = el_pids.lock().unwrap();
                    map.iter()
                        .filter(|(_, info)| info.last_keepalive.elapsed().as_secs() >= 30)
                        .map(|(&pid, info)| (pid, info.process_name.clone(), info.suspended_at.elapsed().as_secs()))
                        .collect()
                }; // lock released

                for (pid, name, elapsed_secs) in to_pulse {
                    // Safety check: main loop may have resumed this PID already
                    if !el_pids.lock().unwrap().contains_key(&pid) { continue; }

                    unsafe { libc::kill(pid as i32, libc::SIGCONT); }
                    std::thread::sleep(Duration::from_millis(200));

                    // Re-check before re-suspending
                    if !el_pids.lock().unwrap().contains_key(&pid) { continue; }

                    unsafe { libc::kill(pid as i32, libc::SIGSTOP); }
                    eprintln!("[keepalive] PID {} ({}) — heartbeat at {}s suspended", pid, name, elapsed_secs);
                    kl_count.fetch_add(1, Ordering::Relaxed);

                    if let Some(info) = el_pids.lock().unwrap().get_mut(&pid) {
                        info.last_keepalive = Instant::now();
                    }
                }
            }
        });
    }

    // Feature 4: daily digest — cumulative stats that reset at midnight
    let mut digest = DailyDigest { date: today_date(), ..Default::default() };
    let mut last_date = today_date();

    // Feature 5: focus session state
    struct FocusSession {
        process: String,
        started_at: Instant,
        memory_freed_mb: u64,
    }
    let mut focus_session: Option<FocusSession> = None;

    while running.load(Ordering::SeqCst) {
        cycle = cycle.wrapping_add(1);
        sys.refresh_all();

        // Feature 4: midnight reset — write yesterday's digest and start fresh
        let current_date = today_date();
        if current_date != last_date {
            digest.date = last_date.clone();
            digest.save();
            digest = DailyDigest { date: current_date.clone(), ..Default::default() };
            keepalive_count_today.store(0, Ordering::Relaxed);
            suspension_counts.clear();
            resume_frequency_today.clear();
            last_date = current_date;
        }

        let total_ram = sys.total_memory();
        let used_ram = sys.used_memory();
        let used_percent = platform.memory_pressure();

        // osascript is expensive — only query the foreground app every 3rd cycle
        if cycle % 3 == 1 {
            foreground_cache = platform.get_foreground_app()
                .unwrap_or_default()
                .to_lowercase();
            // If a browser is in the foreground, get its frontmost window title so we can
            // apply window-level protection rules during classification
            frontmost_window_title_cache = if is_main_browser_process(&foreground_cache) {
                get_frontmost_browser_window(&foreground_cache).unwrap_or_default()
            } else {
                String::new()
            };
        }
        let foreground = foreground_cache.clone();

        // Adaptive threshold: record pressure each time the user switches apps.
        // After 100 data points, lower the threshold by 2% if the 25th-percentile pressure
        // at switch time is below the current threshold (i.e. the user is switching even when
        // memory is low, so the threshold can be tightened safely).
        if !foreground.is_empty() && foreground != prev_foreground {
            pressure_at_user_activity.push(used_percent);
            if pressure_at_user_activity.len() >= 100 {
                let mut sorted = pressure_at_user_activity.clone();
                sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let p25 = sorted[sorted.len() / 4];
                if p25 < config.pressure_threshold {
                    config.pressure_threshold = (config.pressure_threshold - 2.0).max(60.0);
                    config.save();
                    eprintln!("[adaptive-threshold] Lowered pressure_threshold to {:.1}% (p25={:.1}%)",
                        config.pressure_threshold, p25);
                }
                if pressure_at_user_activity.len() > 200 {
                    pressure_at_user_activity.drain(..100);
                }
            }
        }
        prev_foreground = foreground.clone();

        // Memory breakdown via vm_stat — every 5 cycles (~5s)
        if cycle % 5 == 1 {
            memory_breakdown_cache = platform.get_memory_breakdown();
        }

        // Temperature query every 10 cycles (~10s) — returns None as user agent (no root)
        if cycle % 10 == 1 {
            if let Some(t) = platform.get_cpu_temperature() {
                cpu_temp_cache = t;
            }
        }
        let cpu_temp = cpu_temp_cache;
        let effective_pressure_threshold = if cpu_temp > 85.0 {
            65.0_f64 // suspend sooner when CPU is very hot
        } else {
            config.pressure_threshold
        };

        print!("\x1B[2J\x1B[1;1H");

        let suspended_count = suspended_pids.lock().unwrap().len();

        println!("=== MEMentum Daemon ===");
        println!("Total RAM:     {:.2} GB", bytes_to_gb(total_ram));
        println!("Used RAM:      {:.2} GB ({:.1}%)", bytes_to_gb(used_ram), used_percent);
        println!("Pressure:      {}", pressure_label(used_percent));
        println!("Suspended:     {} processes", suspended_count);
        println!("Foreground:    {}", if foreground.is_empty() { "unknown" } else { &foreground });
        println!("Socket:        127.0.0.1:7779");
        println!("Ctrl+C to stop");
        println!();

        let mut processes: Vec<_> = sys.processes().values().collect();
        processes.sort_by(|a, b| b.memory().cmp(&a.memory()));

        // Build once per cycle — stores only u32 PIDs, so no sys lifetime issues
        let dep_map = DependencyMap::build(&sys);

        let mut protected_mb: u64 = 0;
        let mut evictable_mb: u64 = 0;
        let mut app_mb: u64 = 0;
        // Bug 1 fix: collect evictable candidates from ALL processes, not just top 20
        let mut evictable_pids_list: Vec<(u32, String)> = Vec::new();
        let mut all_pids: Vec<u32> = Vec::new();

        // First pass: classify and track ALL processes
        for process in processes.iter() {
            let name = process.name().to_string();
            let mem_mb = process.memory() / 1024 / 1024;
            let pid = process.pid().as_u32();
            let cpu = process.cpu_usage();

            app_mb += mem_mb;
            all_pids.push(pid);
            tracker.update(pid, cpu);
            if !tracker.is_idle(pid) {
                last_active_at.insert(pid, Instant::now());
            }

            // Feature 2: record memory sample, prune entries older than 30 minutes
            let history = memory_history.entry(pid).or_insert_with(VecDeque::new);
            history.push_back((Instant::now(), process.memory()));
            while history.front().map(|(t, _)| t.elapsed().as_secs() > 1800).unwrap_or(false) {
                history.pop_front();
            }

            let classification = match config.overrides.get(&name.to_lowercase()) {
                Some(o) if o == "protected" => Classification::Protected,
                Some(o) if o == "evictable" => Classification::Evictable,
                Some(o) if o == "neutral"   => Classification::Neutral,
                _ => classify(&name),
            };

            let name_lower = name.to_lowercase();
            let is_foreground = is_app_family(&name_lower, &foreground);
            let is_idle = tracker.is_idle(pid);

            match &classification {
                Classification::Protected => protected_mb += mem_mb,
                Classification::Evictable => {
                    evictable_mb += mem_mb;
                    if is_idle && !is_foreground
                        && !is_main_browser_process(&name)
                        && !is_never_suspend(&name)
                    {
                        evictable_pids_list.push((pid, name.clone()));
                    }
                }
                Classification::Neutral => {}
            }
        }

        tracker.cleanup(&all_pids);
        memory_history.retain(|pid, _| all_pids.contains(pid));
        // Keep cooldown entries for 30 min; entries older than that can't affect decisions
        last_suspended_at.retain(|_, t| t.elapsed().as_secs() < 1800);
        last_resumed_at.retain(|_, t| t.elapsed().as_secs() < 1800);
        last_logged.retain(|_, (_, t)| t.elapsed().as_secs() < 600);
        {
            let pids = suspended_pids.lock().unwrap();
            initial_rss_at_suspension.retain(|pid, _| pids.contains_key(pid));
            compression_logged.retain(|pid| pids.contains_key(pid));
        }
        last_active_at.retain(|pid, _| all_pids.contains(pid));

        // Sort evictable candidates by eviction score (descending — highest score suspended first).
        // score = (memory_mb * 0.4) + (idle_secs * 0.4) - (resume_freq_today * 50)
        // Large idle processes score high; frequently-resumed processes score low.
        {
            let now = Instant::now();
            evictable_pids_list.sort_by(|(pid_a, name_a), (pid_b, name_b)| {
                let eviction_score = |pid: u32, name: &str| -> f64 {
                    let mem_mb = sys.process(sysinfo::Pid::from_u32(pid))
                        .map(|p| p.memory() / 1024 / 1024).unwrap_or(0) as f64;
                    let idle_secs = last_active_at.get(&pid)
                        .map(|t| now.duration_since(*t).as_secs_f64())
                        .unwrap_or(3600.0);
                    let freq = *resume_frequency_today.get(name).unwrap_or(&0) as f64;
                    mem_mb * 0.4 + idle_secs * 0.4 - freq * 50.0
                };
                let sa = eviction_score(*pid_a, name_a);
                let sb = eviction_score(*pid_b, name_b);
                sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        // Feature 2: flag processes whose memory grew >50% over the last 30 minutes
        // while the user wasn't interacting with them (not foreground, no CPU activity).
        let mut leak_pids: HashSet<u32> = HashSet::new();
        for (&pid, history) in &memory_history {
            if history.len() < 2 { continue; }
            let (oldest_t, oldest_mem) = history.front().unwrap();
            let (_, newest_mem) = history.back().unwrap();
            let window_secs = oldest_t.elapsed().as_secs();
            // Require at least 5 minutes of history to avoid startup false positives
            if window_secs < 300 { continue; }
            if *oldest_mem < 50 * 1024 * 1024 { continue; } // ignore tiny processes
            if *newest_mem > oldest_mem + oldest_mem / 2 {
                let name_lower = if let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) {
                    p.name().to_string().to_lowercase()
                } else { continue };
                let is_fg = is_app_family(&name_lower, &foreground);
                if !is_fg && tracker.is_idle(pid) {
                    leak_pids.insert(pid);
                }
            }
        }

        // Second pass: display only top 20
        println!("{:<40} {:>6}  {:>5}  {:<12} {}", "PROCESS", "MB", "CPU%", "CLASS", "STATUS");
        println!("{}", "─".repeat(80));

        for process in processes.iter().take(20) {
            let name = process.name().to_string();
            let mem_mb = process.memory() / 1024 / 1024;
            let pid = process.pid().as_u32();
            let cpu = process.cpu_usage();

            let classification = match config.overrides.get(&name.to_lowercase()) {
                Some(o) if o == "protected" => Classification::Protected,
                Some(o) if o == "evictable" => Classification::Evictable,
                Some(o) if o == "neutral"   => Classification::Neutral,
                _ => classify(&name),
            };

            let name_lower = name.to_lowercase();
            let is_foreground = is_app_family(&name_lower, &foreground);
            let is_idle = tracker.is_idle(pid);

            let suspended = suspended_pids.lock().unwrap().contains_key(&pid);
            let status = if suspended {
                "⏸ SUSPENDED"
            } else if is_foreground {
                "🔵 FOCUSED"
            } else if !is_idle && classification == Classification::Evictable {
                "⚡ ACTIVE"
            } else {
                ""
            };

            println!(
                "{:<40} {:>6}  {:>5.1}  {:<12} {}",
                truncate(&name, 40),
                mem_mb,
                cpu,
                classification.to_string(),
                status
            );
        }

        println!("{}", "─".repeat(80));
        println!("Protected: {} MB  |  Evictable: {} MB  |  Suspendable: {} processes",
            protected_mb, evictable_mb, evictable_pids_list.len());
        println!();

        // Feature 4: periodic model scan — every 60s unconditionally.
        // Previously guarded by directory mtime, but that silently returns None in some
        // environments (LaunchAgent, certain fs configs), causing detected_models to stay
        // empty permanently. The 60s timer is sufficient throttling.
        {
            let scan_due = last_model_scan.map_or(true, |t: std::time::Instant| t.elapsed().as_secs() >= 60);
            if scan_due {
                detected_models = model_inspector::scan_ollama_models();
                eprintln!("[model-scan] scan complete: {} model(s) found", detected_models.len());
                for m in &detected_models {
                    eprintln!("[model-scan]   {} — {:.1}GB, {}MB RAM needed ({})",
                        m.name,
                        m.file_size_bytes as f64 / 1024.0 / 1024.0 / 1024.0,
                        m.total_required_mb,
                        m.quantization);
                }
                last_model_scan = Some(std::time::Instant::now());
            }
        }

        // Feature 3: AI inference detection — port probe + CPU secondary signal
        {
            let was_ai_active = ai_inference_active;
            let (ollama_just_started, lmstudio_just_started) = port_monitor.check();

            let ollama_cpu_active = processes.iter()
                .any(|p| p.name().to_lowercase().contains("ollama") && p.cpu_usage() > 5.0);

            let new_ai_active = port_monitor.ollama_active || ollama_cpu_active
                || port_monitor.lmstudio_active;

            let ai_just_started = (ollama_just_started || lmstudio_just_started) && !was_ai_active;
            let ai_just_stopped  = was_ai_active && !new_ai_active;

            ai_inference_active = new_ai_active;
            if new_ai_active {
                ai_tool = if port_monitor.ollama_active || ollama_cpu_active {
                    "ollama".to_string()
                } else {
                    "lmstudio".to_string()
                };
            }

            if ai_just_stopped {
                eprintln!("[ai-release] {} inference complete — resuming normal operation", ai_tool);
                println!("[ai-release] {} done — resuming normal memory management", ai_tool);
                model_load_prepared = false;
                ai_tool = "none".to_string();
            }

            if ai_just_started {
                let (ai_name, port) = if ollama_just_started {
                    ("Ollama", 11434u16)
                } else {
                    ("LM Studio", 1234u16)
                };
                eprintln!("[ai-detected] {} started on port {} — triggering preemptive memory clear",
                    ai_name, port);

                // Feature 4: model-aware allocation — only suspend enough to cover deficit
                let available_mb = sys.total_memory().saturating_sub(sys.used_memory()) / 1024 / 1024;
                let deficit_mb: Option<u64> = if let Some(model) = detected_models.iter()
                    .max_by_key(|m| m.total_required_mb)
                {
                    eprintln!("[model-alloc] Largest model: {} — needs {}MB, {}MB available",
                        model.name, model.total_required_mb, available_mb);
                    if model.total_required_mb > available_mb {
                        let d = model.total_required_mb - available_mb;
                        eprintln!("[model-alloc] Deficit {}MB — targeted suspension until covered", d);
                        Some(d)
                    } else {
                        eprintln!("[model-alloc] Sufficient RAM for {} — no preemptive suspension needed",
                            model.name);
                        Some(0) // zero deficit → break immediately in loop below
                    }
                } else {
                    eprintln!("[model-alloc] No models found — blanket preemptive clear");
                    None // None → suspend all evictable (blanket)
                };

                let mut pids_lock = suspended_pids.lock().unwrap();
                let mut total_mb: u64 = 0;
                let mut count: usize = 0;

                for (pid, name) in &evictable_pids_list {
                    // Targeted mode: stop once deficit is covered
                    if let Some(d) = deficit_mb {
                        if total_mb >= d { break; }
                    }
                    if pids_lock.contains_key(pid) { continue; }
                    if !suspension_allowed(name, *pid, &foreground, &suspension_counts) { continue; }
                    let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                        .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                    if dep_map.is_safe_to_suspend(*pid, name, &sys) && platform.suspend_process(*pid) {
                        *suspension_counts.entry(*pid).or_insert(0) += 1;
                        pids_lock.insert(*pid, (name.clone(), Instant::now()));
                        last_suspended_at.insert(*pid, Instant::now());
                        initial_rss_at_suspension.insert(*pid, mem_mb);
                        if is_electron_app(name) {
                            electron_pids.lock().unwrap().insert(*pid, ElectronSuspendInfo {
                                suspended_at: Instant::now(),
                                last_keepalive: Instant::now(),
                                process_name: name.clone(),
                            });
                        }
                        total_mb += mem_mb;
                        count += 1;
                        digest.total_suspensions += 1;
                        model_prep_freed_mb += mem_mb;
                        eprintln!("[ai-clear] Suspended PID {} ({}) — {}MB cleared for {}",
                            pid, name, mem_mb, ai_name);
                    }
                }

                ai_preemptive_clear_mb += total_mb;
                if total_mb > 0 { model_load_prepared = true; }
                eprintln!("[ai-detected] {} inference started — pre-cleared {}MB from {} processes",
                    ai_name, total_mb, count);

                if count > 0 {
                    save_suspended_pids(&pids_lock.keys().copied().collect::<Vec<_>>());
                    drop(pids_lock);
                    platform.notify_memory_pressure();
                }
            }
        }

        // Features 10 + 11: context window tracker with KV cache growth prediction.
        // update_context() maintains the history ring and sets growth_rate / minutes_remaining.
        // warning_level incorporates both fill % and predictive overflow (so level 3 can
        // trigger before fill hits 90% if growth rate predicts overflow in <2 min).
        if port_monitor.ollama_active {
            let poll_due = last_ollama_poll.map_or(true, |t: std::time::Instant| t.elapsed().as_secs() >= 5);
            if poll_due {
                last_ollama_poll = Some(std::time::Instant::now());
                port_monitor.update_context();

                let fill = port_monitor.context_fill_percent;
                let warning_level = port_monitor.get_context_warning_level();

                if fill >= 90.0 || warning_level >= 3 {
                    eprintln!("[context-warning] Context {:.1}% full (level {}) — EMERGENCY: suspending all non-protected",
                        fill, warning_level);

                    // Suspend evictable + neutral (everything non-protected, non-foreground)
                    let emergency_candidates: Vec<(u32, String)> = processes.iter()
                        .filter(|p| {
                            let nm = p.name().to_string();
                            let cls = match config.overrides.get(&nm.to_lowercase()) {
                                Some(o) if o == "protected" => Classification::Protected,
                                Some(o) if o == "evictable" => Classification::Evictable,
                                _ => classify(&nm),
                            };
                            cls != Classification::Protected
                                && !is_app_family(&nm.to_lowercase(), &foreground)
                                && !is_main_browser_process(&nm)
                                && !is_never_suspend(&nm)
                        })
                        .map(|p| (p.pid().as_u32(), p.name().to_string()))
                        .collect();

                    let mut pids_lock = suspended_pids.lock().unwrap();
                    for (pid, name) in &emergency_candidates {
                        if pids_lock.contains_key(pid) { continue; }
                        if !suspension_allowed(&name, *pid, &foreground, &suspension_counts) { continue; }
                        let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                            .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                        if dep_map.is_safe_to_suspend(*pid, &name, &sys) && platform.suspend_process(*pid) {
                            *suspension_counts.entry(*pid).or_insert(0) += 1;
                            pids_lock.insert(*pid, (name.clone(), Instant::now()));
                            last_suspended_at.insert(*pid, Instant::now());
                            initial_rss_at_suspension.insert(*pid, mem_mb);
                            if is_electron_app(&name) {
                                electron_pids.lock().unwrap().insert(*pid, ElectronSuspendInfo {
                                    suspended_at: Instant::now(),
                                    last_keepalive: Instant::now(),
                                    process_name: name.clone(),
                                });
                            }
                            digest.total_suspensions += 1;
                            eprintln!("[context-clear] Emergency: suspended PID {} ({}) — {}MB", pid, name, mem_mb);
                        }
                    }

                } else if fill >= 75.0 || warning_level >= 2 {
                    eprintln!("[context-warning] Context {:.1}% full (level {}) — suspending evictable + neutral",
                        fill, warning_level);

                    // Neutral candidates: idle, non-foreground, not already suspended
                    let neutral_candidates: Vec<(u32, String)> = processes.iter()
                        .filter(|p| {
                            let nm = p.name().to_string();
                            let cls = match config.overrides.get(&nm.to_lowercase()) {
                                Some(o) if o == "neutral" => Classification::Neutral,
                                Some(_) => return false,
                                None => classify(&nm),
                            };
                            cls == Classification::Neutral
                                && tracker.is_idle(p.pid().as_u32())
                                && !is_app_family(&nm.to_lowercase(), &foreground)
                                && !is_never_suspend(&nm)
                        })
                        .map(|p| (p.pid().as_u32(), p.name().to_string()))
                        .collect();

                    let mut pids_lock = suspended_pids.lock().unwrap();
                    // Evictable first
                    for (pid, name) in &evictable_pids_list {
                        if pids_lock.contains_key(pid) { continue; }
                        if !suspension_allowed(&name, *pid, &foreground, &suspension_counts) { continue; }
                        let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                            .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                        if dep_map.is_safe_to_suspend(*pid, &name, &sys) && platform.suspend_process(*pid) {
                            *suspension_counts.entry(*pid).or_insert(0) += 1;
                            pids_lock.insert(*pid, (name.clone(), Instant::now()));
                            last_suspended_at.insert(*pid, Instant::now());
                            initial_rss_at_suspension.insert(*pid, mem_mb);
                            if is_electron_app(&name) {
                                electron_pids.lock().unwrap().insert(*pid, ElectronSuspendInfo {
                                    suspended_at: Instant::now(),
                                    last_keepalive: Instant::now(),
                                    process_name: name.clone(),
                                });
                            }
                            digest.total_suspensions += 1;
                            eprintln!("[context-clear] Suspended evictable PID {} ({}) — {}MB", pid, name, mem_mb);
                        }
                    }
                    // Then neutral
                    for (pid, name) in &neutral_candidates {
                        if pids_lock.contains_key(pid) { continue; }
                        if !suspension_allowed(&name, *pid, &foreground, &suspension_counts) { continue; }
                        let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                            .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                        if dep_map.is_safe_to_suspend(*pid, &name, &sys) && platform.suspend_process(*pid) {
                            *suspension_counts.entry(*pid).or_insert(0) += 1;
                            pids_lock.insert(*pid, (name.clone(), Instant::now()));
                            last_suspended_at.insert(*pid, Instant::now());
                            initial_rss_at_suspension.insert(*pid, mem_mb);
                            digest.total_suspensions += 1;
                            eprintln!("[context-clear] Suspended neutral PID {} ({}) — {}MB", pid, name, mem_mb);
                        }
                    }

                } else if fill >= 50.0 || warning_level >= 1 {
                    eprintln!("[context-warning] Context {:.1}% full (level {}) — suspending evictable",
                        fill, warning_level);

                    let mut pids_lock = suspended_pids.lock().unwrap();
                    for (pid, name) in &evictable_pids_list {
                        if pids_lock.contains_key(pid) { continue; }
                        if !suspension_allowed(&name, *pid, &foreground, &suspension_counts) { continue; }
                        let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                            .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                        if dep_map.is_safe_to_suspend(*pid, &name, &sys) && platform.suspend_process(*pid) {
                            *suspension_counts.entry(*pid).or_insert(0) += 1;
                            pids_lock.insert(*pid, (name.clone(), Instant::now()));
                            last_suspended_at.insert(*pid, Instant::now());
                            initial_rss_at_suspension.insert(*pid, mem_mb);
                            if is_electron_app(&name) {
                                electron_pids.lock().unwrap().insert(*pid, ElectronSuspendInfo {
                                    suspended_at: Instant::now(),
                                    last_keepalive: Instant::now(),
                                    process_name: name.clone(),
                                });
                            }
                            digest.total_suspensions += 1;
                            eprintln!("[context-clear] Suspended PID {} ({}) — {}MB", pid, name, mem_mb);
                        }
                    }
                }
                // level 0 / fill < 50% with no growth warning: no action — normal operation
            }
        } else {
            // Ollama port closed — reset growth history so stale rate doesn't persist
            port_monitor.reset_context();
        }

        // Feature 6: memory budget enforcement — runs regardless of pressure level.
        // For each budgeted process family, if total memory exceeds the limit, suspend
        // the highest-memory helper processes until the family fits within budget.
        if !config.budgets.is_empty() {
            let mut budget_pids = suspended_pids.lock().unwrap();
            for (budget_name, &limit_mb) in &config.budgets {
                // Match all family members (main process + all helpers).
                let family: Vec<_> = processes.iter()
                    .filter(|p| is_app_family(&p.name().to_string().to_lowercase(), budget_name))
                    .collect();

                // Sum the entire family including already-suspended members — this gives
                // the user the true picture of how much RAM the family occupies.
                let total_mb: u64 = family.iter().map(|p| p.memory() / 1024 / 1024).sum();
                if total_mb <= limit_mb { continue; }

                // Collect helpers that are actually suspendable right now.
                // Helpers = subprocesses whose names start with "<budget_name> ".
                let mut helpers: Vec<_> = family.iter()
                    .filter(|p| {
                        let n = p.name().to_string().to_lowercase();
                        n.starts_with(&format!("{} ", budget_name))
                            && !budget_pids.contains_key(&p.pid().as_u32())
                            && !last_resumed_at.get(&p.pid().as_u32())
                                .map_or(false, |t| t.elapsed().as_secs() < 120)
                    })
                    .collect();

                // If every helper is already suspended there's nothing left to do — skip
                // the log entirely to avoid per-cycle spam while the budget is held.
                if helpers.is_empty() { continue; }

                helpers.sort_by(|a, b| b.memory().cmp(&a.memory()));
                println!(
                    "💰 Budget exceeded for '{}': {} MB / {} MB limit — suspending {} helper(s)",
                    budget_name, total_mb, limit_mb, helpers.len()
                );

                let mut running_total = total_mb;
                for helper in helpers {
                    if running_total <= limit_mb { break; }
                    let hpid = helper.pid().as_u32();
                    let hmb  = helper.memory() / 1024 / 1024;
                    if !suspension_allowed(helper.name(), hpid, &foreground, &suspension_counts) { continue; }
                    if dep_map.is_safe_to_suspend(hpid, helper.name(), &sys) && platform.suspend_process(hpid) {
                        *suspension_counts.entry(hpid).or_insert(0) += 1;
                        budget_pids.insert(hpid, (helper.name().to_string(), Instant::now()));
                        last_suspended_at.insert(hpid, Instant::now());
                        initial_rss_at_suspension.insert(hpid, hmb);
                        if is_electron_app(helper.name()) {
                            electron_pids.lock().unwrap().insert(hpid, ElectronSuspendInfo {
                                suspended_at: Instant::now(),
                                last_keepalive: Instant::now(),
                                process_name: helper.name().to_string(),
                            });
                        }
                        nicened_pids.remove(&hpid);
                        digest.total_suspensions += 1;
                        running_total = running_total.saturating_sub(hmb);
                        eprintln!("[dep-check] PID {} ({}) — passed, suspended {}MB (budget)", hpid, helper.name(), hmb);
                        if should_log(&mut last_logged, hpid, "budget_suspend") {
                            println!("  ⏸  Budget-suspended PID {} ({}) — {} MB", hpid, helper.name(), hmb);
                        }
                    }
                }
                save_suspended_pids(&budget_pids.keys().copied().collect::<Vec<_>>());
                platform.notify_memory_pressure();
            }
        }

        if config.auto_optimize {
            let mut pids = suspended_pids.lock().unwrap();

            // Resume all suspended + nicened processes belonging to the foreground app family.
            if !foreground.is_empty() {
                let fg_suspended: Vec<u32> = pids.keys()
                    .filter(|&&pid| {
                        if let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) {
                            let n = p.name().to_string().to_lowercase();
                            is_app_family(&n, &foreground)
                        } else { false }
                    })
                    .copied()
                    .collect();
                for pid in fg_suspended {
                    // No cooldown for foreground resumes — user's active app must unfreeze instantly
                    if let Some(orig) = nicened_pids.remove(&pid) {
                        unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as _, orig); }
                    }
                    unsafe {
                        if libc::kill(pid as i32, libc::SIGCONT) == 0 {
                            if should_log(&mut last_logged, pid, "resume_fg") {
                                println!("  🔵 Resumed PID {} (foreground)", pid);
                            }
                            last_resumed_at.insert(pid, Instant::now());
                            digest.total_resumes += 1;
                        }
                    }
                    electron_pids.lock().unwrap().remove(&pid);
                    let pname = pids.get(&pid).map(|(n, _)| n.clone()).unwrap_or_default();
                    *resume_frequency_today.entry(pname).or_insert(0) += 1;
                    pids.remove(&pid);
                    initial_rss_at_suspension.remove(&pid);
                    compression_logged.remove(&pid);
                }

                // Restore priority for nicened-but-not-suspended foreground processes
                let fg_nicened: Vec<u32> = nicened_pids.keys()
                    .filter(|&&pid| {
                        if let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) {
                            let n = p.name().to_string().to_lowercase();
                            is_app_family(&n, &foreground)
                        } else { false }
                    })
                    .copied()
                    .collect();
                for pid in fg_nicened {
                    let orig = nicened_pids.remove(&pid).unwrap_or(0);
                    unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as _, orig); }
                    println!("  🔄 Restored priority PID {} (foreground)", pid);
                }
            }

            // Safety net: force-resume electron apps after 60s, all others after max_suspension_secs.
            // Runs EVERY cycle — the primary guard against permanently frozen processes.
            let timed_out: Vec<(u32, String, u64)> = {
                let epids = electron_pids.lock().unwrap();
                pids.iter()
                    .filter(|(&pid, (_, t))| {
                        let elapsed = t.elapsed().as_secs();
                        (epids.contains_key(&pid) && elapsed >= 60)
                            || elapsed >= config.max_suspension_secs
                    })
                    .map(|(&pid, (name, t))| (pid, name.clone(), t.elapsed().as_secs()))
                    .collect()
            };
            if !timed_out.is_empty() {
                for (pid, name, elapsed) in &timed_out {
                    eprintln!("[safety] PID {} ({}) — force-resumed after {}s (max {}s)",
                        pid, name, elapsed, config.max_suspension_secs);
                    if let Some(orig) = nicened_pids.remove(pid) {
                        unsafe { libc::setpriority(libc::PRIO_PROCESS, *pid as _, orig); }
                    }
                    unsafe {
                        if libc::kill(*pid as i32, libc::SIGCONT) == 0 {
                            last_resumed_at.insert(*pid, Instant::now());
                            digest.total_resumes += 1;
                            *resume_frequency_today.entry(name.clone()).or_insert(0) += 1;
                        }
                    }
                    electron_pids.lock().unwrap().remove(pid);
                    pids.remove(pid);
                    initial_rss_at_suspension.remove(pid);
                    compression_logged.remove(pid);
                }
                println!("⏱  [safety] Force-resumed {} processes (max suspension exceeded)", timed_out.len());
            }

            let is_critical = used_percent > effective_pressure_threshold;
            let is_moderate = used_percent > 60.0 && !is_critical;
            let is_normal   = used_percent < config.resume_threshold;

            // Feature 5: in focus mode, suspend everything evictable regardless of pressure
            let focus_proc = focus_session.as_ref().map(|f| f.process.as_str()).unwrap_or("");
            if focus_session.is_some() {
                // Build a wider candidate list: all evictable processes, not just idle ones
                let focus_candidates: Vec<(u32, String)> = processes.iter()
                    .filter(|p| {
                        let n = p.name().to_string().to_lowercase();
                        let cls = match config.overrides.get(&n) {
                            Some(o) if o == "evictable" => true,
                            Some(_) => false,
                            None => classify(p.name()) == Classification::Evictable,
                        };
                        // Don't suspend the focused process itself, foreground, or protected names
                        let is_focus = is_app_family(&n, focus_proc);
                        let is_fg = is_app_family(&n, &foreground);
                        cls && !is_focus && !is_fg
                            && !is_main_browser_process(p.name())
                            && !is_never_suspend(p.name())
                    })
                    .map(|p| (p.pid().as_u32(), p.name().to_string()))
                    .collect();

                println!("🎯 FOCUS MODE — suspending {} evictable processes", focus_candidates.len());
                for (pid, name) in &focus_candidates {
                    if !pids.contains_key(pid) {
                        let recently_resumed = last_resumed_at.get(pid)
                            .map_or(false, |t| t.elapsed().as_secs() < 120);
                        if recently_resumed { continue; }
                        if !suspension_allowed(name, *pid, &foreground, &suspension_counts) { continue; }
                        let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                            .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                        if dep_map.is_safe_to_suspend(*pid, name, &sys) && platform.suspend_process(*pid) {
                            *suspension_counts.entry(*pid).or_insert(0) += 1;
                            pids.insert(*pid, (name.clone(), Instant::now()));
                            last_suspended_at.insert(*pid, Instant::now());
                            initial_rss_at_suspension.insert(*pid, mem_mb);
                            if is_electron_app(name) {
                                electron_pids.lock().unwrap().insert(*pid, ElectronSuspendInfo {
                                    suspended_at: Instant::now(),
                                    last_keepalive: Instant::now(),
                                    process_name: name.clone(),
                                });
                            }
                            nicened_pids.remove(pid);
                            digest.total_suspensions += 1;
                            if let Some(ref mut fs) = focus_session {
                                fs.memory_freed_mb += mem_mb;
                            }
                            eprintln!("[dep-check] PID {} ({}) — passed, suspended {}MB (focus)", pid, name, mem_mb);
                            if should_log(&mut last_logged, *pid, "suspend") {
                                println!("  ⏸  Suspended PID {} ({}) — {} MB freed", pid, name, mem_mb);
                            }
                        }
                    }
                }
                save_suspended_pids(&pids.keys().copied().collect::<Vec<_>>());
                platform.notify_memory_pressure();
            } else if is_critical {
                println!("⚡ CRITICAL — suspending idle evictable processes");
                for (pid, name) in &evictable_pids_list {
                    if !pids.contains_key(pid) {
                        // 2-min cooldown: don't re-suspend a recently resumed process
                        let recently_resumed = last_resumed_at.get(pid)
                            .map_or(false, |t| t.elapsed().as_secs() < 120);
                        if recently_resumed { continue; }
                        // Thrash guard (browser+never-suspend already filtered from evictable_pids_list)
                        if suspension_counts.get(pid).copied().unwrap_or(0) >= 10 { continue; }
                        let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                            .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                        if dep_map.is_safe_to_suspend(*pid, name, &sys) && platform.suspend_process(*pid) {
                            *suspension_counts.entry(*pid).or_insert(0) += 1;
                            pids.insert(*pid, (name.clone(), Instant::now()));
                            last_suspended_at.insert(*pid, Instant::now());
                            initial_rss_at_suspension.insert(*pid, mem_mb);
                            if is_electron_app(name) {
                                electron_pids.lock().unwrap().insert(*pid, ElectronSuspendInfo {
                                    suspended_at: Instant::now(),
                                    last_keepalive: Instant::now(),
                                    process_name: name.clone(),
                                });
                            }
                            nicened_pids.remove(pid);
                            digest.total_suspensions += 1;
                            eprintln!("[dep-check] PID {} ({}) — passed, suspended {}MB (critical)", pid, name, mem_mb);
                            if should_log(&mut last_logged, *pid, "suspend") {
                                println!("  ⏸  Suspended PID {} ({}) — {} MB", pid, name, mem_mb);
                            }
                        }
                    }
                }
                save_suspended_pids(&pids.keys().copied().collect::<Vec<_>>());
                platform.notify_memory_pressure();
            } else if is_moderate {
                // Feature 1: lower CPU priority instead of suspending
                println!("📉 MODERATE — lowering priority of idle evictable processes");
                for (pid, name) in &evictable_pids_list {
                    if !pids.contains_key(pid) && !nicened_pids.contains_key(pid) {
                        unsafe {
                            let original = libc::getpriority(libc::PRIO_PROCESS, *pid as _);
                            if libc::setpriority(libc::PRIO_PROCESS, *pid as _, 15) == 0 {
                                nicened_pids.insert(*pid, original);
                                if should_log(&mut last_logged, *pid, "nice") {
                                    println!("  📉 Nice+15 PID {} ({})", pid, name);
                                }
                            }
                        }
                    }
                }
            } else if is_normal && !ai_inference_active {
                // Restore all lowered priorities
                let to_restore: Vec<u32> = nicened_pids.keys().copied().collect();
                if !to_restore.is_empty() {
                    println!("🔄 Restoring priorities for {} processes", to_restore.len());
                    for pid in to_restore {
                        let orig = nicened_pids.remove(&pid).unwrap_or(0);
                        unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as _, orig); }
                        if should_log(&mut last_logged, pid, "unnice") {
                            println!("  🔄 Restored PID {}", pid);
                        }
                    }
                }
                if !pids.is_empty() {
                    let remaining: Vec<u32> = pids.keys().copied().collect();
                    let mut resumed_count = 0usize;
                    for pid in &remaining {
                        // 3-min post-suspension cooldown before pressure-drop auto-resume
                        let too_soon = last_suspended_at.get(pid)
                            .map_or(false, |t| t.elapsed().as_secs() < 180);
                        if too_soon { continue; }
                        unsafe {
                            if libc::kill(*pid as i32, libc::SIGCONT) == 0 {
                                if should_log(&mut last_logged, *pid, "resume_pressure") {
                                    println!("  ▶  Resumed PID {} (pressure normal)", pid);
                                }
                                electron_pids.lock().unwrap().remove(pid);
                                let pname = pids.get(pid).map(|(n, _)| n.clone()).unwrap_or_default();
                                *resume_frequency_today.entry(pname).or_insert(0) += 1;
                                pids.remove(pid);
                                last_resumed_at.insert(*pid, Instant::now());
                                initial_rss_at_suspension.remove(pid);
                                compression_logged.remove(pid);
                                digest.total_resumes += 1;
                                resumed_count += 1;
                            }
                        }
                    }
                    if resumed_count > 0 {
                        println!("✅ Pressure normal — resumed {} processes", resumed_count);
                        save_suspended_pids(&pids.keys().copied().collect::<Vec<_>>());
                    }
                } else {
                    println!("✓  System healthy — standing by");
                }
            } else {
                let n = pids.len() + nicened_pids.len();
                if n > 0 {
                    println!("⏳ Holding — {} suspended, {} nicened", pids.len(), nicened_pids.len());
                } else {
                    println!("✓  System healthy — standing by");
                }
            }
        }

        // 10-second post-suspension natural compression measurement (logged once per PID to stderr)
        {
            let pids = suspended_pids.lock().unwrap();
            for (&pid, (name, _)) in pids.iter() {
                if compression_logged.contains(&pid) { continue; }
                let elapsed = last_suspended_at.get(&pid).map(|t| t.elapsed().as_secs()).unwrap_or(0);
                if elapsed >= 10 {
                    let initial_mb = *initial_rss_at_suspension.get(&pid).unwrap_or(&0);
                    let current_mb = sys.process(sysinfo::Pid::from_u32(pid))
                        .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                    let freed = initial_mb.saturating_sub(current_mb);
                    eprintln!("[compression] PID {} ({}) — initial={}MB current={}MB naturally_freed={}MB",
                        pid, name, initial_mb, current_mb, freed);
                    compression_logged.insert(pid);
                }
            }
        }

        // Update socket server with current state
        {
            let pids = suspended_pids.lock().unwrap();

            // Recalculate mb_freed as a live snapshot of currently-suspended process memory
            digest.total_mb_freed = pids.keys()
                .map(|&pid| sys.process(sysinfo::Pid::from_u32(pid))
                    .map(|p| p.memory() / 1024 / 1024)
                    .unwrap_or(0))
                .sum();
            let mut proc_list: Vec<ProcessInfo> = Vec::new();

            for process in processes.iter() {
                let name = process.name().to_string();
                let pid = process.pid().as_u32();
                let classification = {
                    let base = match config.overrides.get(&name.to_lowercase()) {
                        Some(o) if o == "protected" => "PROTECTED".to_string(),
                        Some(o) if o == "evictable" => "EVICTABLE".to_string(),
                        Some(o) if o == "neutral"   => "NEUTRAL".to_string(),
                        _ => classify(&name).to_string(),
                    };
                    // Window-protection override: if this browser's current frontmost window
                    // title is in the protected list, show it as PROTECTED regardless of its
                    // default or user-override classification
                    if base != "PROTECTED"
                        && is_main_browser_process(&name)
                        && is_app_family(&name.to_lowercase(), &foreground)
                        && !frontmost_window_title_cache.is_empty()
                        && config.protected_windows.contains(&frontmost_window_title_cache)
                    {
                        eprintln!("[window-protect] {} protected — frontmost window matches rule", name);
                        "PROTECTED".to_string()
                    } else {
                        base
                    }
                };

                let is_suspended = pids.contains_key(&pid);
                let name_lower = name.to_lowercase();
                let is_fg = is_app_family(&name_lower, &foreground);
                let is_active = !tracker.is_idle(pid) && classification == "EVICTABLE";

                let status = if is_suspended {
                    "SUSPENDED".to_string()
                } else if is_fg {
                    "FOCUSED".to_string()
                } else if is_active {
                    "ACTIVE".to_string()
                } else {
                    "IDLE".to_string()
                };

                let compression_savings_mb_per_process = if is_suspended {
                    let initial = *initial_rss_at_suspension.get(&pid).unwrap_or(&0);
                    let current = process.memory() / 1024 / 1024;
                    initial.saturating_sub(current)
                } else { 0 };

                let is_electron = is_electron_app(&name);
                let has_active_children = dep_map.has_active_children(pid, &sys);
                let parent_is_protected = dep_map.has_protected_parent(pid, &sys);

                proc_list.push(ProcessInfo {
                    name,
                    pid,
                    memory_mb: process.memory() / 1024 / 1024,
                    cpu_percent: process.cpu_usage(),
                    classification,
                    status,
                    leak_detected: leak_pids.contains(&pid),
                    compression_savings_mb_per_process,
                    is_electron,
                    has_active_children,
                    parent_is_protected,
                });
            }

            let compression_savings_mb: u64 = proc_list.iter()
                .map(|p| p.compression_savings_mb_per_process)
                .sum();

            server.update_status(DaemonStatus {
                total_ram_gb: bytes_to_gb(total_ram),
                used_ram_gb: bytes_to_gb(used_ram),
                pressure_percent: used_percent,
                pressure_label: pressure_label(used_percent).to_string(),
                suspended_count: pids.len(),
                foreground_app: foreground.clone(),
                total_process_count: processes.len(),
                processes: proc_list,
                protected_mb,
                evictable_mb,
                auto_optimize: config.auto_optimize,
                cpu_temperature: cpu_temp,
                effective_pressure_threshold,
                digest_mb_freed: digest.total_mb_freed,
                digest_suspensions: digest.total_suspensions,
                digest_resumes: digest.total_resumes,
                digest_longest_protected_min: digest.longest_protected_session_minutes,
                focus_active: focus_session.is_some(),
                focus_process: focus_session.as_ref().map(|f| f.process.clone()).unwrap_or_default(),
                focus_duration_secs: focus_session.as_ref().map(|f| f.started_at.elapsed().as_secs()).unwrap_or(0),
                focus_memory_freed_mb: focus_session.as_ref().map(|f| f.memory_freed_mb).unwrap_or(0),
                compression_savings_mb,
                electron_suspended_count: electron_pids.lock().unwrap().len(),
                keepalive_events_today: keepalive_count_today.load(Ordering::Relaxed),
                dependency_checks_skipped: dep_skipped_today,
                ai_inference_active,
                ai_tool: ai_tool.clone(),
                ai_preemptive_clear_mb,
                detected_models: detected_models.clone(),
                model_load_prepared,
                model_prep_freed_mb,
                context_fill_percent: port_monitor.context_fill_percent,
                context_warning: port_monitor.context_warning,
                context_growth_rate: port_monitor.context_growth_rate,
                context_minutes_remaining: port_monitor.context_minutes_remaining,
                context_warning_level: port_monitor.get_context_warning_level(),
                peak_context_fill: port_monitor.peak_context_fill,
                wired_mb:      memory_breakdown_cache.wired_mb,
                compressed_mb: memory_breakdown_cache.compressed_mb,
                cached_mb:     memory_breakdown_cache.cached_mb,
                app_mb,
                untracked_mb: {
                    let used_mb = bytes_to_gb(used_ram) * 1024.0;
                    let accounted = memory_breakdown_cache.wired_mb
                        + memory_breakdown_cache.compressed_mb
                        + memory_breakdown_cache.cached_mb
                        + app_mb;
                    (used_mb as u64).saturating_sub(accounted)
                },
            });
        }

        // Keep get_config endpoint fresh
        if let Ok(json) = serde_json::to_string_pretty(&config) {
            server.update_config(json);
        }

        // Process commands from frontend
        for cmd in server.get_commands() {
            match cmd.action.as_str() {
                "set_override" => {
                    config.overrides.insert(cmd.process.to_lowercase(), cmd.class.to_lowercase());
                    config.save();
                    println!("  📝 Override set: {} → {}", cmd.process, cmd.class);
                }
                "optimize_now" => {
                    println!("  ⚡ Manual optimization triggered");
                    let mut pids_lock = suspended_pids.lock().unwrap();
                    let mut any_suspended = false;
                    for (pid, name) in &evictable_pids_list {
                        if !pids_lock.contains_key(pid) {
                            if suspension_counts.get(pid).copied().unwrap_or(0) >= 10 { continue; }
                            let mem_mb = sys.process(sysinfo::Pid::from_u32(*pid))
                                .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                            if dep_map.is_safe_to_suspend(*pid, name, &sys) && platform.suspend_process(*pid) {
                                *suspension_counts.entry(*pid).or_insert(0) += 1;
                                pids_lock.insert(*pid, (name.clone(), Instant::now()));
                                last_suspended_at.insert(*pid, Instant::now());
                                initial_rss_at_suspension.insert(*pid, mem_mb);
                                if is_electron_app(name) {
                                    electron_pids.lock().unwrap().insert(*pid, ElectronSuspendInfo {
                                        suspended_at: Instant::now(),
                                        last_keepalive: Instant::now(),
                                        process_name: name.clone(),
                                    });
                                }
                                digest.total_suspensions += 1;
                                eprintln!("[dep-check] PID {} ({}) — passed, suspended {}MB (optimize_now)", pid, name, mem_mb);
                                any_suspended = true;
                            }
                        }
                    }
                    save_suspended_pids(&pids_lock.keys().copied().collect::<Vec<_>>());
                    if any_suspended {
                        platform.notify_memory_pressure();
                    }
                }
                "start_focus" => {
                    let proc = cmd.process.to_lowercase();
                    println!("  🎯 Focus session started for '{}'", proc);
                    focus_session = Some(FocusSession {
                        process: proc,
                        started_at: Instant::now(),
                        memory_freed_mb: 0,
                    });
                }
                "end_focus" => {
                    if let Some(ref fs) = focus_session {
                        println!("  🎯 Focus session ended for '{}' ({} s, {} MB freed)",
                            fs.process, fs.started_at.elapsed().as_secs(), fs.memory_freed_mb);
                    }
                    focus_session = None;
                }
                "set_budget" => {
                    if !cmd.process.is_empty() && cmd.limit_mb > 0 {
                        config.budgets.insert(cmd.process.to_lowercase(), cmd.limit_mb);
                        config.save();
                        println!("  💰 Budget set: {} → {} MB", cmd.process, cmd.limit_mb);
                    }
                }
                "set_window_protected" => {
                    let title = cmd.title.trim().to_string();
                    if !title.is_empty() {
                        if cmd.protected {
                            if !config.protected_windows.contains(&title) {
                                config.protected_windows.push(title.clone());
                                config.save();
                                eprintln!("[window-protect] added protected window: {}", title);
                            }
                        } else {
                            config.protected_windows.retain(|t| t != &title);
                            config.save();
                            eprintln!("[window-protect] removed protected window: {}", title);
                        }
                    }
                }
                "suspend" => {
                    if cmd.pid > 0 {
                        let name = sys.process(sysinfo::Pid::from_u32(cmd.pid))
                            .map(|p| p.name().to_string())
                            .unwrap_or_else(|| format!("pid:{}", cmd.pid));
                        if !suspension_allowed(&name, cmd.pid, &foreground, &suspension_counts) {
                            println!("  ⚠️  Manual suspend PID {} blocked by safety guard", cmd.pid);
                        } else if !dep_map.is_safe_to_suspend(cmd.pid, &name, &sys) {
                            println!("  ⚠️  Manual suspend PID {} ({}) blocked by dependency check", cmd.pid, name);
                        } else if platform.suspend_process(cmd.pid) {
                            eprintln!("[dep-check] PID {} ({}) — passed, suspending (manual)", cmd.pid, name);
                            *suspension_counts.entry(cmd.pid).or_insert(0) += 1;
                            let mem_mb = sys.process(sysinfo::Pid::from_u32(cmd.pid))
                                .map(|p| p.memory() / 1024 / 1024).unwrap_or(0);
                            suspended_pids.lock().unwrap()
                                .insert(cmd.pid, (name.clone(), Instant::now()));
                            last_suspended_at.insert(cmd.pid, Instant::now());
                            initial_rss_at_suspension.insert(cmd.pid, mem_mb);
                            if is_electron_app(&name) {
                                electron_pids.lock().unwrap().insert(cmd.pid, ElectronSuspendInfo {
                                    suspended_at: Instant::now(),
                                    last_keepalive: Instant::now(),
                                    process_name: name.clone(),
                                });
                            }
                            digest.total_suspensions += 1;
                            digest.total_mb_freed += mem_mb;
                            eprintln!("[suspend] PID {} ({}) — {}MB frozen", cmd.pid, name, mem_mb);
                            println!("  ⏸  Manual suspend PID {} ({})", cmd.pid, name);
                            platform.notify_memory_pressure();
                        }
                    }
                }
                "resume" => {
                    if cmd.pid > 0 {
                        let pname = suspended_pids.lock().unwrap()
                            .get(&cmd.pid).map(|(n, _)| n.clone()).unwrap_or_default();
                        unsafe {
                            if libc::kill(cmd.pid as i32, libc::SIGCONT) == 0 {
                                *resume_frequency_today.entry(pname).or_insert(0) += 1;
                                electron_pids.lock().unwrap().remove(&cmd.pid);
                                suspended_pids.lock().unwrap().remove(&cmd.pid);
                                if let Some(orig) = nicened_pids.remove(&cmd.pid) {
                                    libc::setpriority(libc::PRIO_PROCESS, cmd.pid as _, orig);
                                }
                                last_resumed_at.insert(cmd.pid, Instant::now());
                                initial_rss_at_suspension.remove(&cmd.pid);
                                compression_logged.remove(&cmd.pid);
                                digest.total_resumes += 1;
                                println!("  ▶  Manual resume PID {}", cmd.pid);
                            } else {
                                println!("  ⚠️  Failed to resume PID {} (process may be gone)", cmd.pid);
                            }
                        }
                    }
                }
                "set_config" => {
                    match cmd.key.as_str() {
                        "auto_optimize" => {
                            if let Some(v) = cmd.value.as_bool() {
                                config.auto_optimize = v;
                                config.save();
                                println!("  ⚙️  auto_optimize → {}", v);
                            }
                        }
                        "pressure_threshold" => {
                            if let Some(v) = cmd.value.as_f64() {
                                if (50.0..=95.0).contains(&v) {
                                    config.pressure_threshold = v;
                                    config.save();
                                    println!("  ⚙️  pressure_threshold → {}", v);
                                }
                            }
                        }
                        "resume_threshold" => {
                            if let Some(v) = cmd.value.as_f64() {
                                if (40.0..=80.0).contains(&v) {
                                    config.resume_threshold = v;
                                    config.save();
                                    println!("  ⚙️  resume_threshold → {}", v);
                                }
                            }
                        }
                        "idle_timeout_secs" => {
                            if let Some(v) = cmd.value.as_u64() {
                                if (10..=300).contains(&v) {
                                    config.idle_timeout_secs = v;
                                    tracker.idle_threshold_secs = v;
                                    config.save();
                                    println!("  ⚙️  idle_timeout_secs → {}", v);
                                }
                            }
                        }
                        other => println!("  ⚠️  Unknown config key: {}", other),
                    }
                }
                _ => {}
            }
        }

        // Fix 7: write recovery file every cycle — crash leaves no process frozen
        {
            let pids = suspended_pids.lock().unwrap();
            save_suspended_pids(&pids.keys().copied().collect::<Vec<_>>());
        }

        // Session-scoped daemon: exit when UI is gone.
        // Grace period: skip the check for the first 30s so the daemon doesn't exit
        // before the UI has had a chance to connect and send its first heartbeat.
        if daemon_start.elapsed().as_secs() > 30 {
            let heartbeat_age = last_heartbeat.lock().unwrap().elapsed().as_secs();
            if heartbeat_age > 15 || SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                eprintln!("[shutdown] UI closed (heartbeat age: {}s) — resuming all processes", heartbeat_age);

                let pids = suspended_pids.lock().unwrap().keys().copied().collect::<Vec<_>>();
                for pid in pids {
                    unsafe { libc::kill(pid as i32, libc::SIGCONT); }
                    eprintln!("[shutdown] Resumed PID {}", pid);
                }

                for (pid, original_nice) in &nicened_pids {
                    unsafe { libc::setpriority(libc::PRIO_PROCESS, *pid, *original_nice); }
                }

                let _ = std::fs::remove_file(recovery_path());

                eprintln!("[shutdown] All processes resumed. MEMentum daemon exiting.");
                std::process::exit(0);
            }
        }

        thread::sleep(Duration::from_secs(1));
    }
}

fn recovery_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".mementum").join("suspended.json")
}

fn save_suspended_pids(pids: &[u32]) {
    let path = recovery_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(pids) {
        let _ = std::fs::write(path, json);
    }
}

fn recover_suspended_pids() {
    let path = recovery_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(pids) = serde_json::from_str::<Vec<u32>>(&content) {
                if !pids.is_empty() {
                    println!("⚠️  Recovering from previous crash — resuming {} processes", pids.len());
                    for pid in &pids {
                        unsafe {
                            if libc::kill(*pid as i32, libc::SIGCONT) == 0 {
                                println!("  ▶  Recovered PID {}", pid);
                            }
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&path);
    }
}

fn bytes_to_gb(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0 / 1024.0
}

fn pressure_label(p: f64) -> &'static str {
    if p < 60.0 { "NORMAL" }
    else if p < 75.0 { "MODERATE" }
    else { "CRITICAL" }
}

fn today_date() -> String {
    // Lean on the OS rather than pulling in a date crate
    std::process::Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() > max {
        format!("{}…", &s[..max - 1])
    } else {
        s.to_string()
    }
}

/// Returns false (and logs why) when suspending `name`/`pid` would violate a safety rule:
/// - process is on the never-suspend list (system daemons, Finder, etc.)
/// - process is a main browser executable (Chrome, Firefox, Safari, Arc, Brave)
/// - process is the current foreground app
/// - process has been suspended ≥10 times today (thrash guard)
fn suspension_allowed(
    name: &str,
    pid: u32,
    foreground: &str,
    suspension_counts: &HashMap<u32, u32>,
) -> bool {
    if is_never_suspend(name) {
        eprintln!("[safety] PID {} ({}) — suspension blocked (never-suspend list)", pid, name);
        return false;
    }
    if is_main_browser_process(name) {
        eprintln!("[safety] PID {} ({}) — suspension blocked (main browser process)", pid, name);
        return false;
    }
    if !foreground.is_empty() {
        if is_app_family(&name.to_lowercase(), foreground) {
            eprintln!("[safety] PID {} ({}) — suspension blocked (foreground app)", pid, name);
            return false;
        }
    }
    if suspension_counts.get(&pid).copied().unwrap_or(0) >= 10 {
        eprintln!("[safety] PID {} ({}) — suspension blocked (thrash limit 10/day)", pid, name);
        return false;
    }
    true
}

/// True when `process_lower` belongs to the app family named `app_lower`.
/// Matches exact name ("google chrome") and helper processes ("google chrome helper (renderer)").
/// Uses prefix+space to avoid false positives like "arc" matching "archiver".
fn is_app_family(process_lower: &str, app_lower: &str) -> bool {
    if app_lower.is_empty() { return false; }
    process_lower == app_lower
        || process_lower.starts_with(&format!("{} ", app_lower))
}

/// Returns the title of the frontmost window for a browser that is currently the foreground app.
/// `browser_lower` must be the lowercase process name (e.g. "google chrome").
/// Returns None if the app isn't running, isn't a known browser, or AppleScript fails.
fn get_frontmost_browser_window(browser_lower: &str) -> Option<String> {
    let app_name = match browser_lower {
        "google chrome" => "Google Chrome",
        "firefox"       => "Firefox",
        "safari"        => "Safari",
        "arc"           => "Arc",
        "brave browser" => "Brave Browser",
        _               => return None,
    };
    let script = format!(
        "try\ntell application \"{}\" to get name of front window\nend try",
        app_name
    );
    let out = std::process::Command::new("osascript")
        .arg("-e").arg(&script)
        .output().ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() { return Some(s); }
    }
    None
}

/// Returns true and records the action only if the same (pid, action) pair
/// has not been logged within the last 5 minutes.
fn should_log(last_logged: &mut HashMap<u32, (String, Instant)>, pid: u32, action: &str) -> bool {
    if let Some((prev, t)) = last_logged.get(&pid) {
        if prev == action && t.elapsed().as_secs() < 300 {
            return false;
        }
    }
    last_logged.insert(pid, (action.to_string(), Instant::now()));
    true
}