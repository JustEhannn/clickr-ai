/// No-op on Windows: there's no Dock to hide from. Windows visibility in the
/// taskbar is instead controlled by the `skipTaskbar` window config option,
/// which is already cross-platform and set in tauri.conf.json.
pub fn hide_dock_icon(_app: &tauri::AppHandle) {}

/// Windows screen-capture-with-exclusion isn't implemented yet — Windows
/// support is a later phase of Clickr. Falls back to a clear error rather
/// than silently doing the wrong thing.
pub fn capture_screen_excluding_windows(
    _titles_to_exclude: &[&str],
    _all_displays: bool,
) -> Result<(u32, u32, Vec<u8>), String> {
    Err("Screen capture is not yet implemented for Windows.".to_string())
}

pub fn active_window_info(_titles_to_exclude: &[&str]) -> Option<(String, Option<String>)> {
    None
}

pub fn install_click_through_monitor(
    _app: &tauri::AppHandle,
    _ignoring: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Option<()> {
    None
}

pub fn disable_window_shadow(_window: &tauri::WebviewWindow) {}

const NO_CONTROL: &str = "Computer control is not available on Windows yet.";
pub fn accessibility_trusted() -> bool { false }
pub fn mouse_click(_x: f64, _y: f64, _right: bool, _double: bool, _real: bool) -> Result<(), String> { Err(NO_CONTROL.into()) }
pub fn type_text(_text: &str, _real: bool) -> Result<(), String> { Err(NO_CONTROL.into()) }
pub fn press_key(_key: &str, _modifiers: &[String], _real: bool) -> Result<(), String> { Err(NO_CONTROL.into()) }
pub fn scroll(_amount: i32, _real: bool) -> Result<(), String> { Err(NO_CONTROL.into()) }

pub fn to_screen_point(x: f64, y: f64) -> (f64, f64) { (x, y) }
pub fn main_display_bounds() -> (f64, f64, f64, f64) { (0.0, 0.0, 1920.0, 1080.0) }

pub fn frontmost_pid() -> Option<i32> { None }
pub fn pid_at_point(_x: f64, _y: f64) -> Option<i32> { None }
pub fn request_accessibility() -> bool { false }
