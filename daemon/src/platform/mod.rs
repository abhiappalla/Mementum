pub mod linux;
pub mod macos;
pub mod windows;

pub struct MemoryBreakdown {
    pub wired_mb:      u64,
    pub compressed_mb: u64,
    pub cached_mb:     u64,
}

impl Default for MemoryBreakdown {
    fn default() -> Self {
        MemoryBreakdown { wired_mb: 0, compressed_mb: 0, cached_mb: 0 }
    }
}

pub trait PlatformMemory {
    fn suspend_process(&self, pid: u32) -> bool;
    fn resume_process(&self, pid: u32) -> bool;
    fn process_exists(&self, pid: u32) -> bool;
    fn memory_pressure(&self) -> f64;
}

#[cfg(target_os = "macos")]
pub fn get_platform() -> macos::MacOSPlatform {
    macos::MacOSPlatform::new()
}

#[cfg(target_os = "windows")]
pub fn get_platform() -> windows::WindowsPlatform {
    windows::WindowsPlatform::new()
}

#[cfg(target_os = "linux")]
pub fn get_platform() -> linux::LinuxPlatform {
    linux::LinuxPlatform::new()
}
