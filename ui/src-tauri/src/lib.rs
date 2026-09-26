use std::process::{Command, Child};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};

// ── Managed state ─────────────────────────────────────────────────────────────

struct DaemonProcess(Mutex<Option<Child>>);

struct TrayState {
    status_item: MenuItem<tauri::Wry>,
}

// ── Daemon binary discovery ───────────────────────────────────────────────────

fn find_daemon_binary() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();

    let candidates: Vec<Option<String>> = vec![
        // Bundled next to the app binary (production .app bundle)
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("mementum-daemon")))
            .map(|p| p.to_string_lossy().into_owned()),
        // Installed location
        Some(format!("{}/.local/bin/mementum-daemon", home)),
        // Dev build locations
        Some(format!("{}/ramspread-daemon/target/debug/mementum-daemon", home)),
        Some(format!("{}/ramspread-daemon/target/release/mementum-daemon", home)),
        // System path
        Some("/usr/local/bin/mementum-daemon".to_string()),
    ];

    for path in candidates.into_iter().flatten() {
        if std::path::Path::new(&path).exists() {
            eprintln!("[daemon] using binary at {}", path);
            return Some(path);
        }
    }
    eprintln!("[daemon] ERROR: could not find mementum-daemon binary in any candidate path");
    None
}

// ── Window helpers ────────────────────────────────────────────────────────────

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ── Force-kill any running daemon (child or external) ────────────────────────

fn force_kill_daemon(guard: &mut Option<Child>) {
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[daemon] killed child process");
    }
    // Belt-and-suspenders: kill any daemon by name (catches externally started ones)
    let _ = Command::new("pkill")
        .args(["-x", "mementum-daemon"])
        .status();
    eprintln!("[daemon] pkill mementum-daemon issued");
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_app_icon(app_name: String) -> Option<String> {
    let app_path = find_app(&app_name)?;
    let icns_path = find_icns(&app_path)?;

    let tmp = std::env::temp_dir().join(format!(
        "mementum_icon_{}.png",
        app_name.replace(|c: char| !c.is_alphanumeric(), "_")
    ));
    let out = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", &icns_path, "--out"])
        .arg(&tmp)
        .output()
        .ok()?;

    if !out.status.success() { return None; }

    let data = std::fs::read(&tmp).ok()?;
    let _ = std::fs::remove_file(&tmp);
    Some(format!("data:image/png;base64,{}", b64_encode(&data)))
}

#[tauri::command]
fn start_daemon(state: State<DaemonProcess>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // If we already have a live child, nothing to do
    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(None) => {
                eprintln!("[daemon] child already running");
                return Ok("already running".to_string());
            }
            _ => { *guard = None; } // exited — fall through to respawn
        }
    }

    // Check if an externally started daemon is already listening
    let external = Command::new("pgrep")
        .args(["-x", "mementum-daemon"])
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    if external {
        eprintln!("[daemon] external daemon already running, adopting it");
        return Ok("external".to_string());
    }

    let path = find_daemon_binary()
        .ok_or_else(|| "mementum-daemon binary not found in any candidate path".to_string())?;

    let child = Command::new(&path)
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", path, e))?;

    eprintln!("[daemon] spawned pid {}", child.id());
    *guard = Some(child);
    Ok("started".to_string())
}

#[tauri::command]
fn stop_daemon(state: State<DaemonProcess>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    force_kill_daemon(&mut *guard);
    Ok("stopped".to_string())
}

#[tauri::command]
fn update_tray_status(
    _app: tauri::AppHandle,
    tray_state: State<TrayState>,
    pressure: f64,
    suspended: u32,
) -> Result<(), String> {
    let text = if pressure > 0.0 {
        format!("Engine: Active — {:.0}% · {} paused", pressure, suspended)
    } else {
        "Engine: Active".to_string()
    };
    tray_state.status_item.set_text(text).map_err(|e| e.to_string())?;
    Ok(())
}

// ── App / icon helpers ────────────────────────────────────────────────────────

fn find_app(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        "/Applications".to_string(),
        "/System/Applications".to_string(),
        "/Applications/Utilities".to_string(),
        format!("{}/Applications", home),
    ];
    for dir in &dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                if !fname.ends_with(".app") { continue; }
                let stem = fname.trim_end_matches(".app").to_lowercase();
                if stem.contains(&lower) || lower.contains(&stem) {
                    return Some(entry.path().to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

fn find_icns(app_path: &str) -> Option<String> {
    let resources = format!("{}/Contents/Resources", app_path);
    let entries = std::fs::read_dir(&resources).ok()?;
    let mut candidates: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "icns").unwrap_or(false))
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect();
    candidates.sort_by_key(|p| if p.contains("AppIcon") { 0u8 } else { 1u8 });
    candidates.into_iter().next()
}

fn b64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(CHARS[b0 >> 2] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3f] as char } else { '=' });
    }
    out
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DaemonProcess(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let status_item = MenuItem::with_id(
                app, "status", "Engine: Active", false, None::<&str>,
            )?;
            let show_item = MenuItem::with_id(
                app, "show", "Open MEMentum", true, None::<&str>,
            )?;
            let optimize_item = MenuItem::with_id(
                app, "optimize", "Optimize Now", true, None::<&str>,
            )?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(
                app, "quit", "Quit MEMentum", true, None::<&str>,
            )?;

            let menu = Menu::with_items(app, &[
                &status_item,
                &sep1,
                &show_item,
                &optimize_item,
                &sep2,
                &quit_item,
            ])?;

            app.manage(TrayState { status_item });

            let tray_icon = app.default_window_icon().unwrap().clone();

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "optimize" => {
                        let _ = app.emit("tray-optimize", ());
                    }
                    "quit" => {
                        let _ = app.emit("tray-quit", ());
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            // Give frontend 1.2s to send HTTP shutdown to daemon
                            std::thread::sleep(std::time::Duration::from_millis(1200));
                            // Force-kill by name regardless of child handle state
                            let _ = Command::new("pkill")
                                .args(["-x", "mementum-daemon"])
                                .status();
                            eprintln!("[daemon] tray quit: pkill issued, exiting");
                            handle.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                let _ = window.emit("window-hidden-to-tray", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_icon,
            start_daemon,
            stop_daemon,
            update_tray_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            match event {
                // Dock icon clicked while app is already running (window hidden to tray)
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    show_main_window(app_handle);
                }
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    eprintln!("[daemon] app exiting — stopping daemon");
                    // Inner block ensures state + MutexGuard are dropped before
                    // the match arm ends (fixes E0597 lifetime error)
                    {
                        let state: tauri::State<DaemonProcess> = app_handle.state();
                        if let Ok(mut guard) = state.0.lock() {
                            force_kill_daemon(&mut *guard);
                        };
                    }
                    // Unconditional pkill covers externally-started daemons and
                    // the case where the lock was poisoned above
                    let _ = Command::new("pkill")
                        .args(["-x", "mementum-daemon"])
                        .status();
                }
                _ => {}
            }
        });
}
