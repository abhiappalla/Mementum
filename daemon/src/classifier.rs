use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub enum Classification {
    Protected,
    Neutral,
    Evictable,
}

impl std::fmt::Display for Classification {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Classification::Protected => write!(f, "PROTECTED"),
            Classification::Neutral   => write!(f, "NEUTRAL"),
            Classification::Evictable => write!(f, "EVICTABLE"),
        }
    }
}

/// Tracks when a process was last seen using CPU
pub struct ActivityTracker {
    last_active: HashMap<u32, Instant>,
    pub idle_threshold_secs: u64,
}

impl ActivityTracker {
    pub fn new(idle_threshold_secs: u64) -> Self {
        ActivityTracker {
            last_active: HashMap::new(),
            idle_threshold_secs,
        }
    }

    /// Update activity for a process based on CPU usage
    pub fn update(&mut self, pid: u32, cpu_percent: f32) {
        if cpu_percent > 1.0 {
            self.last_active.insert(pid, Instant::now());
        } else if !self.last_active.contains_key(&pid) {
            // First time seeing this process, give it a grace period
            self.last_active.insert(pid, Instant::now());
        }
    }

    /// Check if a process has been idle long enough to suspend
    pub fn is_idle(&self, pid: u32) -> bool {
        match self.last_active.get(&pid) {
            Some(last) => last.elapsed().as_secs() >= self.idle_threshold_secs,
            None => true,
        }
    }

    /// Clean up PIDs that no longer exist
    pub fn cleanup(&mut self, active_pids: &[u32]) {
        self.last_active.retain(|pid, _| active_pids.contains(pid));
    }
}

/// Main browser executable — must NEVER be suspended. Only helpers/renderers may be.
pub fn is_main_browser_process(name: &str) -> bool {
    matches!(name.to_lowercase().as_str(),
        "google chrome" | "firefox" | "safari" | "arc" | "brave browser" | "microsoft edge")
}

/// Processes that must never be suspended under any circumstance.
pub fn is_never_suspend(name: &str) -> bool {
    matches!(name.to_lowercase().as_str(),
        "finder" | "dock" | "systemuiserver" | "controlcenter" |
        "notificationcenter" | "windowserver" | "loginwindow" |
        "coreaudiod" | "bluetoothd" | "airportd" | "configd")
}

/// True when the process is an Electron-based app whose internal heartbeat
/// timers will misfire after extended suspension, requiring the keepalive layer.
pub fn is_electron_app(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("slack")
        || n.contains("discord")
        || n.contains("notion")
        || n.contains("teams")
        || n.contains("whatsapp")
        || n.contains("signal")
        || n.contains("telegram")
        || n == "electron"
        || n.starts_with("electron ")
}

pub fn classify(name: &str) -> Classification {
    let n = name.to_lowercase();

    if n.contains("ollama")
        || n.contains("lm studio")
        || n.contains("llm")
        || n.contains("stable diffusion")
        || n.contains("python")
        || n.contains("jupyter")
        || n.contains("claude")
        || n.contains("cursor")
    {
        return Classification::Protected;
    }

    if n.contains("code")
        || n.contains("xcode")
        || n.contains("terminal")
        || n.contains("iterm")
        || n.contains("warp")
        || n.contains("ghostty")
    {
        return Classification::Protected;
    }

    if n.contains("kernel")
        || n.contains("launchd")
        || n.contains("systemd")
        || n.contains("loginwindow")
        || n.contains("windowserver")
        || n.contains("coreaudiod")
        || n.contains("openvpn")
        || n.contains("wireguard")
        || n.contains("1password")
        || n.contains("keychain")
    {
        return Classification::Protected;
    }

    if n.contains("chrome")
        || n.contains("firefox")
        || n.contains("safari")
        || n.contains("arc")
        || n.contains("brave")
        || n.contains("edge")
        || n.contains("opera")
    {
        return Classification::Evictable;
    }

    if n.contains("slack")
        || n.contains("discord")
        || n.contains("zoom")
        || n.contains("teams")
        || n.contains("mail")
        || n.contains("telegram")
        || n.contains("whatsapp")
        || n.contains("signal")
    {
        return Classification::Evictable;
    }

    if n.contains("spotify")
        || n.contains("music")
        || n.contains("vlc")
        || n.contains("figma")
        || n.contains("notion")
    {
        return Classification::Evictable;
    }

    Classification::Neutral
}