use super::PlatformMemory;
use std::fs;
use std::path::Path;

pub struct LinuxPlatform;

impl LinuxPlatform {
    pub fn new() -> Self {
        LinuxPlatform
    }

    /// Returns the cgroup v2 path for the given PID by reading /proc/PID/cgroup.
    fn get_cgroup_path(&self, pid: u32) -> Option<String> {
        let content = fs::read_to_string(format!("/proc/{}/cgroup", pid)).ok()?;
        for line in content.lines() {
            // cgroups v2 unified hierarchy: "0::<path>"
            // cgroups v1 memory controller: "<id>:memory:<path>"
            if line.starts_with("0::") || line.contains(":memory:") {
                let parts: Vec<&str> = line.splitn(3, ':').collect();
                if parts.len() >= 3 {
                    return Some(format!("/sys/fs/cgroup{}", parts[2].trim()));
                }
            }
        }
        None
    }

    /// Places the process in /sys/fs/cgroup/mementum/<pid> and writes memory.max.
    fn set_memory_limit(&self, pid: u32, limit_bytes: u64) -> bool {
        let cgroup_path = format!("/sys/fs/cgroup/mementum/{}", pid);
        if fs::create_dir_all(&cgroup_path).is_err() {
            return false;
        }
        if fs::write(format!("{}/memory.max", cgroup_path), limit_bytes.to_string()).is_err() {
            return false;
        }
        fs::write(format!("{}/cgroup.procs", cgroup_path), pid.to_string()).is_ok()
    }

    /// Returns the current VmRSS (resident set size) for a PID in bytes,
    /// read directly from /proc/PID/status to avoid sysinfo overhead.
    fn read_rss_bytes(&self, pid: u32) -> Option<u64> {
        let status = fs::read_to_string(format!("/proc/{}/status", pid)).ok()?;
        for line in status.lines() {
            if line.starts_with("VmRSS:") {
                let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
                return Some(kb * 1024);
            }
        }
        None
    }

    /// On Linux, use xdotool to query the active window name.
    pub fn get_foreground_app(&self) -> Option<String> {
        let output = std::process::Command::new("xdotool")
            .args(["getactivewindow", "getwindowname"])
            .output()
            .ok()?;
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
        None
    }

    /// No CPU temperature reading on Linux without root + lm-sensors or hwmon parsing.
    /// Returns None to signal the caller should skip thermal throttling.
    pub fn get_cpu_temperature(&self) -> Option<f64> {
        // Try /sys/class/thermal/thermal_zone0/temp (millidegrees Celsius)
        if let Ok(raw) = fs::read_to_string("/sys/class/thermal/thermal_zone0/temp") {
            if let Ok(millideg) = raw.trim().parse::<i64>() {
                return Some(millideg as f64 / 1000.0);
            }
        }
        None
    }

    /// No-op on Linux — memory pressure notifications go through cgroup events,
    /// not a separate notify utility.
    pub fn notify_memory_pressure(&self) {}

    pub fn get_memory_breakdown(&self) -> super::MemoryBreakdown {
        super::MemoryBreakdown::default()
    }
}

impl PlatformMemory for LinuxPlatform {
    /// Suspends the process with SIGSTOP, then places it in a MEMentum cgroup
    /// with memory.high set to 50% of its current RSS so the kernel actively
    /// pages out its working set while it is frozen.
    fn suspend_process(&self, pid: u32) -> bool {
        unsafe {
            if libc::kill(pid as i32, 0) != 0 {
                return false;
            }
            if libc::kill(pid as i32, libc::SIGSTOP) != 0 {
                return false;
            }
        }

        // Cgroups v2: create per-PID cgroup and apply memory pressure
        let cgroup_path = format!("/sys/fs/cgroup/mementum/{}", pid);
        if fs::create_dir_all(&cgroup_path).is_ok() {
            if let Some(rss_bytes) = self.read_rss_bytes(pid) {
                // Set memory.high to 50% of RSS → kernel reclaims the other half
                let high = rss_bytes / 2;
                let _ = fs::write(format!("{}/memory.high", cgroup_path), high.to_string());
                let _ = fs::write(format!("{}/cgroup.procs", cgroup_path), pid.to_string());
                eprintln!(
                    "[linux] PID {} — SIGSTOP sent, cgroup memory.high set to {}MB",
                    pid,
                    high / 1024 / 1024
                );
            } else {
                eprintln!("[linux] PID {} — SIGSTOP sent (cgroup RSS read failed)", pid);
            }
        } else {
            eprintln!("[linux] PID {} — SIGSTOP sent (no cgroup support or not root)", pid);
        }

        true
    }

    /// Resumes the process: lifts the cgroup memory.high limit back to "max"
    /// so the kernel stops pressuring it, then sends SIGCONT.
    fn resume_process(&self, pid: u32) -> bool {
        // Remove memory pressure before unfreezing so the process doesn't
        // immediately page-fault on all its evicted pages at once
        let high_path = format!("/sys/fs/cgroup/mementum/{}/memory.high", pid);
        let _ = fs::write(&high_path, "max");

        unsafe {
            if libc::kill(pid as i32, 0) != 0 {
                return false;
            }
            libc::kill(pid as i32, libc::SIGCONT) == 0
        }
    }

    fn process_exists(&self, pid: u32) -> bool {
        Path::new(&format!("/proc/{}", pid)).exists()
    }

    /// Reads /proc/meminfo for accurate available RAM, avoiding sysinfo's
    /// cached values which can lag by one refresh cycle.
    fn memory_pressure(&self) -> f64 {
        let Ok(content) = fs::read_to_string("/proc/meminfo") else {
            return 0.0;
        };
        let mut total = 0u64;
        let mut available = 0u64;
        for line in content.lines() {
            if line.starts_with("MemTotal:") {
                total = line.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
            } else if line.starts_with("MemAvailable:") {
                available = line.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
            }
        }
        if total > 0 {
            (total - available) as f64 / total as f64 * 100.0
        } else {
            0.0
        }
    }
}
