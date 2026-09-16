/// No-op on Windows: there's no Dock to hide from. Windows visibility in the
/// taskbar is instead controlled by the `skipTaskbar` window config option,
/// which is already cross-platform and set in tauri.conf.json.
pub fn hide_dock_icon(_app: &tauri::AppHandle) {}