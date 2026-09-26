use super::PlatformMemory;

pub struct WindowsPlatform;

impl WindowsPlatform {
    pub fn new() -> Self {
        WindowsPlatform
    }
}

// ── Real implementation (Windows only) ───────────────────────────────────────

#[cfg(target_os = "windows")]
impl WindowsPlatform {
    /// Returns the executable name of the process that owns the foreground window.
    pub fn get_foreground_app(&self) -> Option<String> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };

        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0 == 0 {
                return None;
            }

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }

            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

            let mut buf = vec![0u16; 260];
            let mut size = buf.len() as u32;
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .ok()?;
            CloseHandle(handle).ok();

            let path = String::from_utf16_lossy(&buf[..size as usize]);
            let name = std::path::Path::new(&path)
                .file_stem()?
                .to_string_lossy()
                .to_string();
            Some(name)
        }
    }

    /// No-op on Windows — memory compaction is handled by the memory manager.
    pub fn notify_memory_pressure(&self) {}

    /// Windows does not expose a CPU die temperature through a public API
    /// without third-party hardware drivers.
    pub fn get_cpu_temperature(&self) -> Option<f64> {
        None
    }
}

#[cfg(target_os = "windows")]
impl PlatformMemory for WindowsPlatform {
    fn suspend_process(&self, pid: u32) -> bool {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};

        type NtSuspendProcess =
            unsafe extern "system" fn(ProcessHandle: windows::Win32::Foundation::HANDLE) -> i32;

        unsafe {
            let handle = match OpenProcess(PROCESS_SUSPEND_RESUME, false, pid) {
                Ok(h) => h,
                Err(_) => return false,
            };

            let ntdll = GetModuleHandleA(windows::core::s!("ntdll.dll")).unwrap_or_default();
            let proc_addr = GetProcAddress(ntdll, windows::core::s!("NtSuspendProcess"));

            let result = if let Some(func) = proc_addr {
                let suspend: NtSuspendProcess = std::mem::transmute(func);
                suspend(handle) >= 0
            } else {
                false
            };

            CloseHandle(handle).ok();
            result
        }
    }

    fn resume_process(&self, pid: u32) -> bool {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};

        type NtResumeProcess =
            unsafe extern "system" fn(ProcessHandle: windows::Win32::Foundation::HANDLE) -> i32;

        unsafe {
            let handle = match OpenProcess(PROCESS_SUSPEND_RESUME, false, pid) {
                Ok(h) => h,
                Err(_) => return false,
            };

            let ntdll = GetModuleHandleA(windows::core::s!("ntdll.dll")).unwrap_or_default();
            let proc_addr = GetProcAddress(ntdll, windows::core::s!("NtResumeProcess"));

            let result = if let Some(func) = proc_addr {
                let resume: NtResumeProcess = std::mem::transmute(func);
                resume(handle) >= 0
            } else {
                false
            };

            CloseHandle(handle).ok();
            result
        }
    }

    fn process_exists(&self, pid: u32) -> bool {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => {
                    CloseHandle(h).ok();
                    true
                }
                Err(_) => false,
            }
        }
    }

    fn memory_pressure(&self) -> f64 {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        unsafe {
            // MEMORYSTATUSEX must have dwLength set before calling GlobalMemoryStatusEx
            let mut mem_status: MEMORYSTATUSEX = std::mem::zeroed();
            mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;

            if GlobalMemoryStatusEx(&mut mem_status).is_ok() {
                mem_status.dwMemoryLoad as f64
            } else {
                0.0
            }
        }
    }
}

// ── Non-Windows stubs (compile-time only, never called on macOS/Linux) ────────

#[cfg(not(target_os = "windows"))]
impl PlatformMemory for WindowsPlatform {
    fn suspend_process(&self, _pid: u32) -> bool { false }
    fn resume_process(&self, _pid: u32) -> bool { false }
    fn process_exists(&self, _pid: u32) -> bool { false }
    fn memory_pressure(&self) -> f64 { 0.0 }
}

#[cfg(not(target_os = "windows"))]
impl WindowsPlatform {
    pub fn get_foreground_app(&self) -> Option<String> { None }
    pub fn notify_memory_pressure(&self) {}
    pub fn get_cpu_temperature(&self) -> Option<f64> { None }
    pub fn get_memory_breakdown(&self) -> super::MemoryBreakdown { super::MemoryBreakdown::default() }
}
