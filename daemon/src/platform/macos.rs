use super::{MemoryBreakdown, PlatformMemory};
use sysinfo::System;
use std::process::Command;

pub struct MacOSPlatform;

impl MacOSPlatform {
    pub fn new() -> Self { MacOSPlatform }

    // CPU temperature via powermetrics requires root — not available as a user agent.
    // Planned for a future release using a user-accessible API.
    pub fn get_cpu_temperature(&self) -> Option<f64> {
        None
    }

    pub fn get_foreground_app(&self) -> Option<String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"System Events\" to get name of first application process whose frontmost is true")
            .output()
            .ok()?;

        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() { return Some(name); }
        }
        None
    }

    pub fn get_memory_breakdown(&self) -> MemoryBreakdown {
        let page_size = 16384u64; // Apple Silicon page size
        let out = Command::new("vm_stat").output();

        let mut wired      = 0u64;
        let mut compressed = 0u64;
        let mut purgeable  = 0u64;
        let mut file_backed = 0u64;

        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let parse = |l: &str| -> u64 {
                    l.split(':').nth(1)
                        .and_then(|v| v.trim().trim_end_matches('.').parse::<u64>().ok())
                        .unwrap_or(0)
                };
                if line.starts_with("Pages wired down:")           { wired       = parse(line) * page_size; }
                if line.starts_with("Pages occupied by compressor:") { compressed = parse(line) * page_size; }
                if line.starts_with("Pages purgeable:")            { purgeable   = parse(line) * page_size; }
                if line.starts_with("File-backed pages:")          { file_backed = parse(line) * page_size; }
            }
        }

        MemoryBreakdown {
            wired_mb:      wired / 1024 / 1024,
            compressed_mb: compressed / 1024 / 1024,
            cached_mb:     (purgeable + file_backed) / 1024 / 1024,
        }
    }

    /// Option A: fire macOS memory-pressure notifications via the public notifyd API.
    /// Synchronous and fast — both notifyutil calls return immediately.
    pub fn notify_memory_pressure(&self) {
        Command::new("notifyutil")
            .args(["-p", "com.apple.memorypressure.critical"])
            .output().ok();
        Command::new("notifyutil")
            .args(["-p", "com.apple.system.memorypressure"])
            .output().ok();
        eprintln!("[compression] memory pressure notifications sent");
    }

}

// ── PlatformMemory impl ───────────────────────────────────────────────────────

impl PlatformMemory for MacOSPlatform {
    fn suspend_process(&self, pid: u32) -> bool {
        unsafe {
            if libc::kill(pid as i32, 0) != 0 { return false; }
            libc::kill(pid as i32, libc::SIGSTOP) == 0
        }
    }

    fn resume_process(&self, pid: u32) -> bool {
        unsafe {
            if libc::kill(pid as i32, 0) != 0 { return false; }
            libc::kill(pid as i32, libc::SIGCONT) == 0
        }
    }

    fn process_exists(&self, pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    fn memory_pressure(&self) -> f64 {
        let mut sys = System::new_all();
        sys.refresh_memory();
        let used  = sys.used_memory() as f64;
        let total = sys.total_memory() as f64;
        (used / total) * 100.0
    }
}
