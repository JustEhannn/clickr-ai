#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub mod ax;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;
// UI Automation plays the role macOS's AX module plays (same function names).
#[cfg(target_os = "windows")]
#[path = "uia.rs"]
pub mod ax;
