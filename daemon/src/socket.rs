use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;
use std::fs;
use serde::{Deserialize, Serialize};
use crate::model_inspector::ModelInfo;

static ACTIVE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
const MAX_CONNECTIONS: usize = 20;

pub static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

// ── API token ─────────────────────────────────────────────────────────────────

fn generate_api_token() -> String {
    use std::io::Read as _;
    let mut bytes = [0u8; 32];
    let mut f = fs::File::open("/dev/urandom").expect("Failed to open /dev/urandom");
    f.read_exact(&mut bytes).expect("Failed to read random bytes");
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn get_or_create_token() -> String {
    use std::os::unix::fs::PermissionsExt;

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let config_dir = std::path::PathBuf::from(home).join(".mementum");
    let path = config_dir.join("api_token");

    if path.exists() {
        if let Ok(t) = fs::read_to_string(&path) {
            let trimmed = t.trim().to_string();
            if !trimmed.is_empty() { return trimmed; }
        }
    }

    let token = generate_api_token();
    let _ = fs::create_dir_all(&config_dir);
    // Restrict directory to owner only before writing the token
    let _ = fs::set_permissions(&config_dir, fs::Permissions::from_mode(0o700));
    let _ = fs::write(&path, &token);
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    token
}

#[derive(Serialize)]
pub struct ProcessInfo {
    pub name: String,
    pub pid: u32,
    pub memory_mb: u64,
    pub cpu_percent: f32,
    pub classification: String,
    pub status: String,
    pub leak_detected: bool,
    pub compression_savings_mb_per_process: u64,
    pub is_electron: bool,
    pub has_active_children: bool,
    pub parent_is_protected: bool,
}

#[derive(Serialize)]
pub struct DaemonStatus {
    pub total_ram_gb: f64,
    pub used_ram_gb: f64,
    pub pressure_percent: f64,
    pub pressure_label: String,
    pub suspended_count: usize,
    pub foreground_app: String,
    pub total_process_count: usize,
    pub processes: Vec<ProcessInfo>,
    pub protected_mb: u64,
    pub evictable_mb: u64,
    pub auto_optimize: bool,
    pub cpu_temperature: f64,
    pub effective_pressure_threshold: f64,
    pub digest_mb_freed: u64,
    pub digest_suspensions: u64,
    pub digest_resumes: u64,
    pub digest_longest_protected_min: u64,
    pub focus_active: bool,
    pub focus_process: String,
    pub focus_duration_secs: u64,
    pub focus_memory_freed_mb: u64,
    pub compression_savings_mb: u64,
    pub electron_suspended_count: usize,
    pub keepalive_events_today: u32,
    pub dependency_checks_skipped: u32,
    pub ai_inference_active: bool,
    pub ai_tool: String,
    pub ai_preemptive_clear_mb: u64,
    pub detected_models: Vec<ModelInfo>,
    pub model_load_prepared: bool,
    pub model_prep_freed_mb: u64,
    #[serde(default)]
    pub context_fill_percent: f64,
    #[serde(default)]
    pub context_warning: bool,
    #[serde(default)]
    pub context_growth_rate: f64,
    #[serde(default)]
    pub context_minutes_remaining: Option<f64>,
    #[serde(default)]
    pub context_warning_level: u8,
    #[serde(default)]
    pub peak_context_fill: f64,
    // Memory breakdown (from vm_stat on macOS)
    pub wired_mb:      u64,
    pub compressed_mb: u64,
    pub cached_mb:     u64,
    pub app_mb:        u64,
    pub untracked_mb:  u64,
}

#[derive(Deserialize, Clone)]
pub struct Command {
    pub action: String,
    #[serde(default)]
    pub process: String,
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub limit_mb: u64,
    /// Max processes to return in get_status / get_processes (0 = all)
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: serde_json::Value,
    /// Optional API token (alternative to X-Ramspread-Token header)
    #[serde(default)]
    pub token: Option<String>,
    /// Window title for set_window_protected
    #[serde(default)]
    pub title: String,
    /// Browser name for set_window_protected
    #[serde(default)]
    pub browser: String,
    /// Protected flag for set_window_protected
    #[serde(default)]
    pub protected: bool,
}

pub struct SocketServer {
    status: Arc<Mutex<Option<DaemonStatus>>>,
    command_queue: Arc<Mutex<Vec<Command>>>,
    /// Serialised Config JSON kept fresh by the main loop so get_config can serve it instantly.
    config_json: Arc<Mutex<Option<String>>>,
    /// Static token read/created at startup; every request must supply it.
    auth_token: String,
    /// Last time a heartbeat was received from the UI.
    last_heartbeat: Arc<Mutex<Instant>>,
    /// Cached result of get_browser_windows (AppleScript is slow — 5 second TTL)
    browser_cache: Arc<Mutex<Option<(Instant, String)>>>,
}

impl SocketServer {
    pub fn new() -> Self {
        SocketServer {
            status: Arc::new(Mutex::new(None)),
            command_queue: Arc::new(Mutex::new(Vec::new())),
            config_json: Arc::new(Mutex::new(None)),
            auth_token: get_or_create_token(),
            last_heartbeat: Arc::new(Mutex::new(Instant::now())),
            browser_cache: Arc::new(Mutex::new(None)),
        }
    }

    pub fn last_heartbeat(&self) -> Arc<Mutex<Instant>> {
        Arc::clone(&self.last_heartbeat)
    }

    pub fn update_status(&self, status: DaemonStatus) {
        *self.status.lock().unwrap() = Some(status);
    }

    /// Call this each cycle (and after config mutations) to keep get_config fresh.
    pub fn update_config(&self, json: String) {
        *self.config_json.lock().unwrap() = Some(json);
    }

    pub fn get_commands(&self) -> Vec<Command> {
        self.command_queue.lock().unwrap().drain(..).collect()
    }

    pub fn start(&self) {
        let status        = Arc::clone(&self.status);
        let commands      = Arc::clone(&self.command_queue);
        let cfg_json      = Arc::clone(&self.config_json);
        let token         = self.auth_token.clone();
        let last_hb       = Arc::clone(&self.last_heartbeat);
        let browser_cache = Arc::clone(&self.browser_cache);

        std::thread::spawn(move || {
            let listener = match TcpListener::bind("127.0.0.1:7779") {
                Ok(l)  => l,
                Err(e) => { eprintln!("Socket server failed to start: {}", e); return; }
            };

            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };

                // Silently drop connections beyond the cap to prevent thread exhaustion
                if ACTIVE_CONNECTIONS.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }

                let status        = Arc::clone(&status);
                let commands      = Arc::clone(&commands);
                let cfg_json      = Arc::clone(&cfg_json);
                let token         = token.clone();
                let last_hb       = Arc::clone(&last_hb);
                let browser_cache = Arc::clone(&browser_cache);

                std::thread::spawn(move || {
                    handle_http(stream, status, commands, cfg_json, token, last_hb, browser_cache);
                    ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
    }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

fn http_response(status_code: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        status_code, reason, body.len(), body,
    )
}

fn err(msg: &str) -> String {
    format!(r#"{{"error":"{}"}}"#, msg)
}

const ALLOWED_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

fn is_allowed_origin(origin: &str) -> bool {
    ALLOWED_ORIGINS.contains(&origin)
}

// ── Request handler ───────────────────────────────────────────────────────────

fn handle_http(
    mut stream: std::net::TcpStream,
    status:        Arc<Mutex<Option<DaemonStatus>>>,
    commands:      Arc<Mutex<Vec<Command>>>,
    cfg_json:      Arc<Mutex<Option<String>>>,
    auth_token:    String,
    last_heartbeat: Arc<Mutex<Instant>>,
    browser_cache: Arc<Mutex<Option<(Instant, String)>>>,
) {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

    let read_half = match stream.try_clone() {
        Ok(s)  => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(read_half);

    // ── Request line ──────────────────────────────────────────────────────────
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() { return; }
    let request_line = request_line.trim();
    if request_line.is_empty() { return; }

    let is_options = request_line.starts_with("OPTIONS");
    let is_post    = request_line.starts_with("POST");
    if !is_options && !is_post {
        let resp = http_response(405, "Method Not Allowed", &err("method not allowed"));
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    // ── Headers ───────────────────────────────────────────────────────────────
    let mut content_length: usize = 0;
    let mut request_token = String::new();
    let mut origin        = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() { return; }
        let trimmed = line.trim();
        if trimmed.is_empty() { break; }
        let lower = trimmed.to_lowercase();
        if let Some(val) = lower.strip_prefix("content-length:") {
            content_length = val.trim().parse().unwrap_or(0);
        }
        if let Some(val) = lower.strip_prefix("x-mementum-token:") {
            request_token = val.trim().to_string();
        }
        if let Some(val) = lower.strip_prefix("origin:") {
            origin = val.trim().to_string();
        }
    }

    // ── CORS preflight ────────────────────────────────────────────────────────
    if is_options {
        let allowed = is_allowed_origin(&origin);
        eprintln!("[cors] OPTIONS preflight from origin={:?} -> {}", origin, if allowed { "allowed" } else { "no ACAO header" });
        let cors_headers = if allowed {
            format!(
                "Access-Control-Allow-Origin: {}\r\n\
                 Access-Control-Allow-Methods: POST, OPTIONS\r\n\
                 Access-Control-Allow-Headers: Content-Type, X-MEMentum-Token\r\n\
                 Access-Control-Max-Age: 86400\r\n",
                origin
            )
        } else {
            String::new()
        };
        let resp = format!(
            "HTTP/1.1 204 No Content\r\n\
             {}Connection: close\r\n\
             \r\n",
            cors_headers
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    if content_length > 65_536 {
        let resp = http_response(400, "Bad Request", &err("body too large"));
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    // ── Body ──────────────────────────────────────────────────────────────────
    let mut body = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() { return; }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    let cmd: Command = match serde_json::from_slice(&body) {
        Ok(c)  => c,
        Err(_) => {
            let resp = http_response(400, "Bad Request", &err("invalid json"));
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            return;
        }
    };

    // ── Token authentication ──────────────────────────────────────────────────
    // Accept token from header (X-Ramspread-Token) or body field ("token").
    let body_token = cmd.token.as_deref().unwrap_or("").to_string();
    let provided = if !request_token.is_empty() { &request_token } else { &body_token };
    if provided != &auth_token {
        let resp = http_response(403, "Forbidden", &err("invalid or missing token"));
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    let response_body: String = match cmd.action.as_str() {

        // ── Read-only endpoints served directly from shared state ──────────────

        "get_status" => {
            let s = status.lock().unwrap();
            match &*s {
                Some(s) => {
                    let n = cmd.limit;
                    if n == 0 || n >= s.processes.len() {
                        serde_json::to_string(s).unwrap_or_else(|_| err("serialise error"))
                    } else {
                        // Truncate only the processes field; all other fields (including
                        // total_process_count) reflect the full picture.
                        match serde_json::to_value(s) {
                            Ok(mut v) => {
                                if let Some(arr) = v.get_mut("processes").and_then(|p| p.as_array_mut()) {
                                    arr.truncate(n);
                                }
                                v.to_string()
                            }
                            Err(_) => err("serialise error"),
                        }
                    }
                }
                None => err("daemon not ready yet"),
            }
        }

        "get_processes" => {
            let s = status.lock().unwrap();
            match &*s {
                Some(s) => {
                    let n = cmd.limit;
                    let procs: &[ProcessInfo] = if n == 0 || n >= s.processes.len() {
                        &s.processes
                    } else {
                        &s.processes[..n]
                    };
                    serde_json::to_string(procs).unwrap_or_else(|_| err("serialise error"))
                }
                None => err("daemon not ready yet"),
            }
        }

        "get_config" => {
            let c = cfg_json.lock().unwrap();
            match &*c {
                Some(j) => j.clone(),
                None    => err("config not ready yet"),
            }
        }

        "get_digest" => {
            // Extract just the digest fields from DaemonStatus
            let s = status.lock().unwrap();
            match &*s {
                Some(s) => serde_json::json!({
                    "total_mb_freed_today":            s.digest_mb_freed,
                    "total_suspensions_today":         s.digest_suspensions,
                    "total_resumes_today":             s.digest_resumes,
                    "longest_protected_session_min":   s.digest_longest_protected_min,
                }).to_string(),
                None => err("daemon not ready yet"),
            }
        }

        "get_models" => {
            let s = status.lock().unwrap();
            match &*s {
                Some(s) => {
                    eprintln!("[api] get_models: detected_models cache has {} entries", s.detected_models.len());
                    let available_mb = ((s.total_ram_gb - s.used_ram_gb) * 1024.0) as u64;
                    let models_json: Vec<serde_json::Value> = s.detected_models.iter().map(|m| {
                        let can_fit = m.total_required_mb <= available_mb;
                        let mb_to_free = if can_fit { 0u64 } else { m.total_required_mb - available_mb };
                        serde_json::json!({
                            "name":                  m.name,
                            "file_size_gb":          m.file_size_bytes as f64 / 1024.0 / 1024.0 / 1024.0,
                            "estimated_ram_mb":      m.estimated_ram_mb,
                            "estimated_kv_cache_mb": m.estimated_kv_cache_mb,
                            "total_required_mb":     m.total_required_mb,
                            "quantization":          m.quantization,
                            "parameter_count":       m.parameter_count,
                            "can_fit":               can_fit,
                            "mb_to_free":            mb_to_free,
                        })
                    }).collect();
                    eprintln!("[api] get_models returning {} models", models_json.len());
                    serde_json::json!({
                        "models":             models_json,
                        "total_available_mb": available_mb,
                        "model_load_prepared": s.model_load_prepared,
                        "model_prep_freed_mb": s.model_prep_freed_mb,
                    }).to_string()
                }
                None => err("daemon not ready yet"),
            }
        }

        // ── Write commands queued to the main loop ────────────────────────────

        "suspend" => {
            if cmd.pid == 0 {
                err("missing pid")
            } else {
                commands.lock().unwrap().push(cmd);
                r#"{"ok":true}"#.to_string()
            }
        }

        "resume" => {
            if cmd.pid == 0 {
                err("missing pid")
            } else {
                commands.lock().unwrap().push(cmd);
                r#"{"ok":true}"#.to_string()
            }
        }

        "set_config" => {
            if cmd.key.is_empty() {
                err("missing key")
            } else {
                let valid = match cmd.key.as_str() {
                    "auto_optimize"      => cmd.value.as_bool().is_some(),
                    "pressure_threshold" => cmd.value.as_f64().map_or(false, |v| (50.0..=95.0).contains(&v)),
                    "resume_threshold"   => cmd.value.as_f64().map_or(false, |v| (40.0..=80.0).contains(&v)),
                    "idle_timeout_secs"  => cmd.value.as_u64().map_or(false, |v| (10..=300).contains(&v)),
                    _                    => false,
                };
                if !valid {
                    err("invalid value")
                } else {
                    let resp = serde_json::json!({"ok": true, "key": &cmd.key, "value": &cmd.value}).to_string();
                    commands.lock().unwrap().push(cmd);
                    resp
                }
            }
        }

        "set_override" => {
            if cmd.process.is_empty() {
                err("missing process")
            } else if cmd.class.is_empty() {
                err("missing class — must be protected|neutral|evictable")
            } else {
                commands.lock().unwrap().push(cmd);
                r#"{"ok":true}"#.to_string()
            }
        }

        "optimize_now" => {
            let estimated_savings_mb: u64 = {
                let s = status.lock().unwrap();
                s.as_ref().map(|st| {
                    st.processes.iter()
                        .filter(|p| p.classification == "EVICTABLE"
                            && p.status != "SUSPENDED"
                            && p.status != "FOCUSED")
                        .map(|p| p.memory_mb)
                        .sum()
                }).unwrap_or(0)
            };
            commands.lock().unwrap().push(cmd);
            serde_json::json!({"ok": true, "estimated_savings_mb": estimated_savings_mb}).to_string()
        }

        "toggle_auto"
        | "start_focus" | "end_focus"
        | "set_budget" => {
            commands.lock().unwrap().push(cmd);
            r#"{"ok":true}"#.to_string()
        }

        "heartbeat" => {
            *last_heartbeat.lock().unwrap() = Instant::now();
            r#"{"ok":true}"#.to_string()
        }

        "shutdown" => {
            eprintln!("[shutdown] Shutdown requested by UI");
            SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
            r#"{"ok":true}"#.to_string()
        }

        // ── Browser window picker ─────────────────────────────────────────────

        "get_browser_windows" => {
            // Return cached result if <5 seconds old (AppleScript is slow)
            let cached = {
                let c = browser_cache.lock().unwrap();
                c.as_ref()
                    .filter(|(t, _)| t.elapsed().as_secs() < 5)
                    .map(|(_, s)| s.clone())
            };
            if let Some(json) = cached {
                json
            } else {
                // Read current protected_windows from config cache
                let protected_windows: Vec<String> = {
                    let c = cfg_json.lock().unwrap();
                    c.as_ref()
                        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
                        .and_then(|v| v.get("protected_windows").cloned())
                        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                        .unwrap_or_default()
                };

                let script = r#"set output to ""
set browserList to {"Google Chrome", "Safari", "Firefox", "Arc", "Brave Browser"}
repeat with browserName in browserList
    tell application "System Events"
        set isRunning to (exists process browserName)
    end tell
    if isRunning then
        try
            tell application browserName
                repeat with w in windows
                    set output to output & browserName & "|" & (name of w) & "\n"
                end repeat
            end tell
        end try
    end if
end repeat
return output"#;

                let out = std::process::Command::new("osascript")
                    .arg("-e").arg(script)
                    .output();

                let mut windows: Vec<serde_json::Value> = Vec::new();
                if let Ok(out) = out {
                    let text = String::from_utf8_lossy(&out.stdout);
                    for line in text.lines() {
                        let line = line.trim();
                        if line.is_empty() { continue; }
                        if let Some((browser, title)) = line.split_once('|') {
                            let browser = browser.trim().to_string();
                            let title   = title.trim().to_string();
                            if title.is_empty() { continue; }
                            let is_protected = protected_windows.contains(&title);
                            windows.push(serde_json::json!({
                                "browser":   browser,
                                "title":     title,
                                "protected": is_protected,
                            }));
                        }
                    }
                }

                let json = serde_json::json!({ "windows": windows }).to_string();
                *browser_cache.lock().unwrap() = Some((Instant::now(), json.clone()));
                json
            }
        }

        "set_window_protected" => {
            if cmd.title.is_empty() {
                err("missing title")
            } else {
                // Invalidate cache so the next get_browser_windows reflects the change
                *browser_cache.lock().unwrap() = None;
                commands.lock().unwrap().push(cmd);
                r#"{"ok":true}"#.to_string()
            }
        }

        other => err(&format!("unknown action: {}", other)),
    };

    // ── Response ──────────────────────────────────────────────────────────────
    let response = if is_allowed_origin(&origin) {
        format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Access-Control-Allow-Origin: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {}",
            response_body.len(), origin, response_body
        )
    } else {
        http_response(200, "OK", &response_body)
    };
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
