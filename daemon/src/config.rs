use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DailyDigest {
    pub date: String,
    pub total_mb_freed: u64,
    pub total_suspensions: u64,
    pub total_resumes: u64,
    pub longest_protected_session_minutes: u64,
}

impl DailyDigest {
    pub fn path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".mementum").join("digest.json")
    }

    pub fn save(&self) {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = fs::write(path, json);
        }
    }
}

fn default_idle_timeout_secs() -> u64 { 30 }
fn default_max_suspension_secs() -> u64 { 300 }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    /// User overrides: process name -> "protected" | "neutral" | "evictable"
    pub overrides: HashMap<String, String>,

    /// RAM percentage that triggers optimization
    pub pressure_threshold: f64,

    /// RAM percentage at which suspended processes resume
    pub resume_threshold: f64,

    /// Whether auto-optimization is enabled
    pub auto_optimize: bool,

    /// Per-process memory budgets: process name -> max MB before helpers are suspended
    #[serde(default)]
    pub budgets: HashMap<String, u64>,

    /// Seconds a process must be CPU-idle before it becomes eligible for suspension
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,

    /// Maximum seconds any process stays suspended before automatic resume (default 300)
    #[serde(default = "default_max_suspension_secs")]
    pub max_suspension_secs: u64,

    /// Window titles (from any browser) whose browser is kept PROTECTED when that window is frontmost.
    #[serde(default)]
    pub protected_windows: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            overrides: HashMap::new(),
            pressure_threshold: 75.0,
            resume_threshold: 60.0,
            auto_optimize: true,
            budgets: HashMap::new(),
            idle_timeout_secs: 30,
            max_suspension_secs: 300,
            protected_windows: Vec::new(),
        }
    }
}

impl Config {
    pub fn path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".mementum").join("config.json")
    }

    pub fn load() -> Self {
        let path = Self::path();
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str(&content) {
                    return config;
                }
            }
        }
        let default = Config::default();
        default.save();
        default
    }

    pub fn save(&self) {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = fs::write(path, json);
        }
    }
}