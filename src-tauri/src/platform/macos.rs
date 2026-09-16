/// Hides the app from the Dock and app switcher, so Clickr behaves as a
/// menu-bar-only utility rather than a normal application window.
pub fn hide_dock_icon(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}