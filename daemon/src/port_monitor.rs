use std::collections::VecDeque;
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Snapshot of a single model reported by `GET /api/ps`.
#[derive(Debug, Clone)]
pub struct RunningModel {
    pub name: String,
    pub tokens_used: u64,
    pub context_length: u64,
    pub size_bytes: u64,
    pub size_vram: u64,
    pub fill_fraction: f64,
}

/// Aggregated status returned from one `/api/ps` poll.
#[derive(Debug, Clone)]
pub struct OllamaStatus {
    pub models: Vec<RunningModel>,
    /// Highest fill fraction across all running models (0.0–1.0).
    pub max_context_fill: f64,
}

pub struct PortMonitor {
    // Port state
    pub ollama_active: bool,
    pub lmstudio_active: bool,
    last_ollama_check: bool,
    last_lmstudio_check: bool,

    // KV cache growth tracking (Feature 11)
    /// Ring buffer of (timestamp, fill_percent) — up to 60 readings (5 min at 5s intervals).
    context_history: VecDeque<(Instant, f64)>,
    /// Fill % per second averaged over the history window. 0.0 when no growth.
    pub context_growth_rate: f64,
    /// Predicted minutes until context reaches 100%, if growth_rate > 0.
    pub context_minutes_remaining: Option<f64>,
    /// Highest fill % seen this session.
    pub peak_context_fill: f64,
    /// Current fill %, updated every poll.
    pub context_fill_percent: f64,
    /// Whether fill is high enough to warrant a warning.
    pub context_warning: bool,
}

impl PortMonitor {
    pub fn new() -> Self {
        PortMonitor {
            ollama_active: false,
            lmstudio_active: false,
            last_ollama_check: false,
            last_lmstudio_check: false,
            context_history: VecDeque::new(),
            context_growth_rate: 0.0,
            context_minutes_remaining: None,
            peak_context_fill: 0.0,
            context_fill_percent: 0.0,
            context_warning: false,
        }
    }

    /// Probe both ports. Returns (ollama_just_started, lmstudio_just_started).
    pub fn check(&mut self) -> (bool, bool) {
        let ollama_now = TcpStream::connect_timeout(
            &"127.0.0.1:11434".parse().unwrap(),
            Duration::from_millis(50),
        )
        .is_ok();

        let lmstudio_now = TcpStream::connect_timeout(
            &"127.0.0.1:1234".parse().unwrap(),
            Duration::from_millis(50),
        )
        .is_ok();

        let ollama_just_started   = ollama_now   && !self.last_ollama_check;
        let lmstudio_just_started = lmstudio_now && !self.last_lmstudio_check;

        self.last_ollama_check   = ollama_now;
        self.last_lmstudio_check = lmstudio_now;
        self.ollama_active   = ollama_now;
        self.lmstudio_active = lmstudio_now;

        (ollama_just_started, lmstudio_just_started)
    }

    /// Poll `/api/ps`, update growth tracking, and return the raw status.
    /// Should be called every ~5 seconds when `ollama_active` is true.
    pub fn update_context(&mut self) -> Option<OllamaStatus> {
        let status = poll_ollama_api()?;
        let fill_pct = status.max_context_fill * 100.0;

        // Push reading into history ring; cap at 60 entries.
        self.context_history.push_back((Instant::now(), fill_pct));
        if self.context_history.len() > 60 {
            self.context_history.pop_front();
        }

        // Growth rate: slope over the full history window.
        self.context_growth_rate = self.calculate_growth_rate();

        // Minutes remaining until 100%.
        self.context_minutes_remaining = if self.context_growth_rate > 0.0 {
            Some((100.0 - fill_pct) / self.context_growth_rate / 60.0)
        } else {
            None
        };

        // Update peaks and derived fields.
        if fill_pct > self.peak_context_fill {
            self.peak_context_fill = fill_pct;
        }
        self.context_fill_percent = fill_pct;
        self.context_warning = fill_pct >= 50.0;

        eprintln!(
            "[kv-cache] fill={:.1}% growth={:.3}%/s remaining={:?}min level={}",
            fill_pct,
            self.context_growth_rate,
            self.context_minutes_remaining.map(|m| format!("{:.1}", m)),
            self.get_context_warning_level(),
        );

        Some(status)
    }

    /// (latest_fill - oldest_fill) / elapsed_seconds, in fill-percent per second.
    fn calculate_growth_rate(&self) -> f64 {
        if self.context_history.len() < 2 {
            return 0.0;
        }
        let (oldest_t, oldest_fill) = self.context_history.front().unwrap();
        let (latest_t, latest_fill) = self.context_history.back().unwrap();
        let elapsed = latest_t.duration_since(*oldest_t).as_secs_f64();
        if elapsed < 1.0 {
            return 0.0;
        }
        let delta = latest_fill - oldest_fill;
        if delta <= 0.0 { 0.0 } else { delta / elapsed }
    }

    /// Returns 0–3 warning level based on fill % and predicted time remaining.
    pub fn get_context_warning_level(&self) -> u8 {
        // Fill-based thresholds
        if self.context_fill_percent >= 90.0 { return 3; }
        if self.context_fill_percent >= 75.0 { return 2; }
        if self.context_fill_percent >= 50.0 { return 1; }

        // Predictive thresholds (growth rate overrides fill when overflow is imminent)
        if let Some(mins) = self.context_minutes_remaining {
            if mins < 2.0  { return 3; }
            if mins < 5.0  { return 2; }
            if mins < 10.0 { return 1; }
        }
        0
    }

    /// Reset all context tracking state (call when Ollama goes offline).
    pub fn reset_context(&mut self) {
        self.context_history.clear();
        self.context_growth_rate = 0.0;
        self.context_minutes_remaining = None;
        self.context_fill_percent = 0.0;
        self.context_warning = false;
        // Preserve peak_context_fill — useful to know the session high-water mark.
    }
}

/// Raw HTTP poll of `GET http://localhost:11434/api/ps` via curl (1-second timeout).
fn poll_ollama_api() -> Option<OllamaStatus> {
    eprintln!("[ollama-api] polling http://localhost:11434/api/ps");

    let output = std::process::Command::new("curl")
        .args(["-s", "--max-time", "1", "http://localhost:11434/api/ps"])
        .output()
        .ok()?;

    eprintln!(
        "[ollama-api] curl exit={}, bytes={}",
        output.status.code().unwrap_or(-1),
        output.stdout.len()
    );

    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let empty = vec![];
    let model_array = json["models"].as_array().unwrap_or(&empty);

    if model_array.is_empty() {
        eprintln!("[ollama-api] no models currently loaded");
        return Some(OllamaStatus { models: vec![], max_context_fill: 0.0 });
    }

    let mut models = Vec::new();
    let mut max_fill = 0.0f64;

    for m in model_array {
        let name       = m["name"].as_str().unwrap_or("unknown").to_string();
        let size_bytes = m["size"].as_u64().unwrap_or(0);
        let size_vram  = m["size_vram"].as_u64().unwrap_or(0);

        let prompt_tokens = m["prompt_eval_count"].as_u64().unwrap_or(0);
        let eval_tokens   = m["eval_count"].as_u64().unwrap_or(0);
        let tokens_used   = prompt_tokens.saturating_add(eval_tokens);

        let context_length = m["details"]["context_length"].as_u64().unwrap_or(0);

        let fill = if context_length > 0 && tokens_used > 0 {
            (tokens_used as f64 / context_length as f64).min(1.0)
        } else if size_bytes > 0 {
            0.01 // model loaded but idle — show 1% so field is visibly non-zero
        } else {
            0.0
        };

        eprintln!(
            "[ollama-api] model={} tokens={}/{} fill={:.1}% size={}MB",
            name, tokens_used, context_length,
            fill * 100.0,
            size_bytes / 1024 / 1024,
        );

        if fill > max_fill { max_fill = fill; }
        models.push(RunningModel { name, tokens_used, context_length, size_bytes, size_vram, fill_fraction: fill });
    }

    Some(OllamaStatus { models, max_context_fill: max_fill })
}
