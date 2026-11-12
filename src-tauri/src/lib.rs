mod platform;

mod local;
mod cli;
mod engine;
mod agent;
use base64::{engine::general_purpose, Engine as _};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter,
    Manager,
    WebviewWindowBuilder,
    WebviewUrl,
};
use tauri_plugin_global_shortcut::{
    GlobalShortcutExt,
    Shortcut,
    ShortcutState,
};


use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;


static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

static DRAG_ACTIVE_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A drag only counts while drag events keep arriving. If the "drag ended"
/// event is ever missed, this expires on its own instead of leaving the pill
/// permanently click-through.
pub fn is_drag_active() -> bool {
    DRAG_ACTIVE.load(Ordering::Relaxed) && now_ms().saturating_sub(DRAG_ACTIVE_AT.load(Ordering::Relaxed)) < 1500
}

#[tauri::command]
fn set_drag_active(app: tauri::AppHandle, active: bool) {
    DRAG_ACTIVE.store(active, Ordering::Relaxed);
    DRAG_ACTIVE_AT.store(now_ms(), Ordering::Relaxed);

    #[cfg(target_os = "macos")]
    if active {
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.set_ignores_mouse_events(false);
        }
    }
}
struct ClickThroughIgnoring(Arc<AtomicBool>);
/// True while Agent Mode runs: the chat panel is invisible and click-through.
static AGENT_HIDDEN: AtomicBool = AtomicBool::new(false);

pub fn agent_hidden() -> bool {
    AGENT_HIDDEN.load(Ordering::Relaxed)
}

static BAR_WANTED: AtomicBool = AtomicBool::new(false);

static SAFE_RECT: StdMutex<Option<(f64, f64, f64, f64)>> = StdMutex::new(None);

pub fn set_safe_rect(x: f64, y: f64, width: f64, height: f64) {
    *SAFE_RECT.lock().unwrap() = Some((x, y, width, height));
}

/// The clickable area, relative to the window's top-left (set by the frontend).
pub fn safe_rect() -> Option<(f64, f64, f64, f64)> {
    *SAFE_RECT.lock().unwrap()
}

/* =========================================================
   GLOBAL SHORTCUTS
   ========================================================= */

const DEFAULT_TOGGLE_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";
const DEFAULT_ASSIST_SHORTCUT: &str = "CmdOrCtrl+Enter";

struct ShortcutConfig {
    toggle: Mutex<Shortcut>,
    assist: Mutex<Shortcut>,
}

/* =========================================================
   CLICKR AI PROMPT
   ========================================================= */



/// Makes the panel ignore (or accept) mouse events without touching focus.
/// The global mouse monitor turns it back on when the cursor re-enters the UI.
#[tauri::command]
fn set_click_through(app: tauri::AppHandle, ignore: bool) {
    #[cfg(target_os = "macos")]
    {
        if is_drag_active() {
            return;
        }
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.set_ignores_mouse_events(ignore);
        }
        if let Some(state) = app.try_state::<ClickThroughIgnoring>() {
            state.0.store(ignore, Ordering::Relaxed);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, ignore);
}

/* =========================================================
   MOUSE FIX CLICKING
   ========================================================= */

#[tauri::command]
fn update_clickable_rect(x: f64, y: f64, width: f64, height: f64) {
    set_safe_rect(x, y, width, height);
}

/* =========================================================
   OPEN MAIN WINDOW
   ========================================================= */

/// Showing the panel always starts it interactive; the mouse monitor then
/// re-evaluates on the next move. Prevents a stale "ignoring" state from a
/// previous session leaving the pill dead on arrival.
#[cfg(target_os = "macos")]
fn make_interactive(app: &tauri::AppHandle, panel: &dyn tauri_nspanel::Panel) {
    panel.set_ignores_mouse_events(false);
    if let Some(state) = app.try_state::<ClickThroughIgnoring>() {
        state.0.store(false, Ordering::Relaxed);
    }
}

pub fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.show();
            make_interactive(app, &*panel);
            panel.make_key_window();
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    // Lets the chat put the cursor in the message box so you can start typing straight away.
    let _ = app.emit("panel-shown", ());
}

/// Hides the chat panel (used by the Esc key).
#[tauri::command]
fn hide_panel(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Ok(panel) = app.get_webview_panel("main") {
        panel.hide();
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/* =========================================================
   AGENT MODE: hide the chat, show a small status pill
   ========================================================= */

/// Hides (or restores) the chat while the agent works so it never gets in the way.
#[tauri::command]
fn set_agent_hidden(app: tauri::AppHandle, hidden: bool) {
    AGENT_HIDDEN.store(hidden, Ordering::Relaxed);

    #[cfg(target_os = "macos")]
    {
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.set_ignores_mouse_events(hidden);
            if hidden {
                panel.resign_key_window();
            }
        }
        if let Some(state) = app.try_state::<ClickThroughIgnoring>() {
            state.0.store(hidden, Ordering::Relaxed);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, hidden);
}

/// Brings the chat panel back (used when an agent run ends or is stopped).
#[tauri::command]
fn show_panel(app: tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_main_window(&handle));
}

/// Puts everything back exactly as it was before an agent run: chat visible and
/// clickable, status pill and cursor overlay gone. Safe to call at any time.
#[tauri::command]
fn agent_restore(app: tauri::AppHandle, show: Option<bool>) {
    use tauri::Manager;
    let show = show.unwrap_or(true);

    AGENT_HIDDEN.store(false, Ordering::SeqCst);
    BAR_WANTED.store(false, Ordering::SeqCst);

    if let Some(window) = app.get_webview_window("cursor") {
        let _ = window.close();
    }
    // (agent.rs keeps its own "wanted" flag for the cursor window)
    agent::agent_cursor_hide(app.clone());

    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(bar) = handle.get_webview_panel("agentbar") {
                bar.hide();
            }
            if let Ok(panel) = handle.get_webview_panel("main") {
                make_interactive(&handle, &*panel);
                if show {
                    panel.show();
                    panel.make_key_window();
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    if show {
        show_main_window(&app);
    }
}

#[tauri::command]
fn agent_bar_show(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        BAR_WANTED.store(true, Ordering::SeqCst);
        let handle = app.clone();
        return app
            .run_on_main_thread(move || {
                // The run may already have ended before this executes.
                if !BAR_WANTED.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(panel) = handle.get_webview_panel("agentbar") {
                    panel.show();
                    return;
                }
                let (ox, oy, w, _) = platform::main_display_bounds();
                let (bar_w, bar_h) = (560.0, 52.0);
                let built = PanelBuilder::<_, AgentBarPanel>::new(&handle, "agentbar")
                    .url(WebviewUrl::App("index.html?window=agentbar".into()))
                    .with_window(move |win| {
                        win.title("Clickr Agent")
                            .inner_size(bar_w, bar_h)
                            .position(ox + (w - bar_w) / 2.0, oy + 44.0)
                            .resizable(false)
                            .decorations(false)
                            .transparent(true)
                            .shadow(false)
                            .skip_taskbar(true)
                            .visible(false)
                    })
                    .level(PanelLevel::Floating)
                    .style_mask(StyleMask::empty().nonactivating_panel())
                    .build();
                match built {
                    Ok(panel) => {
                        panel.as_panel().setHasShadow(false);
                        panel.show();
                    }
                    Err(e) => eprintln!("Failed to build agent bar: {e}"),
                }
            })
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
fn agent_bar_hide(app: tauri::AppHandle) {
    BAR_WANTED.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(panel) = handle.get_webview_panel("agentbar") {
                panel.hide();
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/* =========================================================
   TOGGLE WINDOW
   ========================================================= */

fn toggle_window(app: &tauri::AppHandle) {
    // Emergency exit: while the agent runs the chat is hidden, so the hotkey
    // stops the run (which also brings the chat back).
    if agent_hidden() {
        let _ = app.emit("agent-decision", serde_json::json!({ "decision": "stop" }));
        return;
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(panel) = app.get_webview_panel("main") {
            if panel.is_visible() {
                panel.hide();
            } else {
                panel.show();
                make_interactive(app, &*panel);
                panel.make_key_window();
                let _ = app.emit("panel-shown", ());
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window("main") {
            let visible = window.is_visible().unwrap_or(false);
            if visible {
                let _ = window.hide();
            } else {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

/* =========================================================
   SETTINGS WINDOW
   ========================================================= */

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let app_handle = app.clone();

    app.run_on_main_thread(move || {
        let window = WebviewWindowBuilder::new(
            &app_handle,
            "settings",
            WebviewUrl::App("index.html?window=settings".into()),
        )
        .title("Clickr Settings")
        .inner_size(340.0, 640.0)
        .min_inner_size(340.0, 520.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(true)
        .focused(true)
        .build();

        match window {
    Ok(window) => {
        let _ = window.set_focus();

        #[cfg(target_os = "macos")]
        platform::disable_window_shadow(&window);

        let opened_at = std::time::Instant::now();
        let window_for_event = window.clone();

        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(false) = event {
                // Ignore the very first blur — it can fire almost
                // immediately after creation as focus settles. Only
                // start closing on blur once the window's actually
                // been open for a moment, so a real click elsewhere
                // is what triggers this, not creation noise.
                if opened_at.elapsed() > std::time::Duration::from_millis(300) {
                    let _ = window_for_event.close();
                }
            }
        });
    }
    Err(e) => {
        eprintln!("Failed to build settings window: {e}");
    }
}
    })
    .map_err(|e| e.to_string())?;

    Ok(())
}

/* =========================================================
   BUG REPORT WINDOW
   ========================================================= */

/// Version / OS details attached to a bug report (only if the user leaves "include
/// diagnostics" on). Nothing about screen contents or chats is included.
#[tauri::command]
fn bug_diagnostics(app: tauri::AppHandle) -> serde_json::Value {
    let os = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    serde_json::json!({
        "app_version": app.package_info().version.to_string(),
        "os": format!("macOS {os}"),
        "arch": std::env::consts::ARCH,
    })
}

/// Opens (or focuses) the bug report window. Unlike Settings it does NOT close when it
/// loses focus, so people can switch away to check something and come back to finish.
#[tauri::command]
fn open_bug_report(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("bugreport") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("bug-prefill", ()); // already open: re-read what triggered it
        return Ok(());
    }

    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::new(
            &app_handle,
            "bugreport",
            WebviewUrl::App("index.html?window=bug".into()),
        )
        .title("Clickr Bug Report")
        .inner_size(380.0, 470.0)
        .min_inner_size(380.0, 260.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(true)
        .focused(true)
        .build();

        match built {
            Ok(window) => {
                #[cfg(target_os = "macos")]
                platform::disable_window_shadow(&window);
                let _ = window.set_focus();
            }
            Err(e) => eprintln!("Failed to build bug report window: {e}"),
        }
    })
    .map_err(|e| e.to_string())
}

/* =========================================================
   FILE DRAG DROP
   ========================================================= */

#[tauri::command]
fn read_image_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;

       let mime_type = match std::path::Path::new(&path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        Some("csv") => "text/csv",
        // Source files are sent as plain text so the model reads them as code.
        Some("rs") | Some("py") | Some("js") | Some("jsx") | Some("ts") | Some("tsx")
        | Some("java") | Some("c") | Some("h") | Some("cpp") | Some("cs") | Some("go")
        | Some("rb") | Some("php") | Some("swift") | Some("kt") | Some("sh") | Some("sql")
        | Some("html") | Some("css") | Some("json") | Some("yaml") | Some("yml")
        | Some("toml") | Some("xml") => "text/plain",
        _ => "application/octet-stream",
    };

    let base64_data = general_purpose::STANDARD.encode(&bytes);

    Ok(format!("data:{};base64,{}", mime_type, base64_data))
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    // Relaunch through LaunchServices (`open`) a moment after this process has exited, so the new
    // copy isn't turned away by the single-instance guard and macOS treats it as a fresh launch
    // (which is what makes a newly granted Screen Recording permission take effect).
    if let Ok(exe) = std::env::current_exe() {
        let bundle = exe.ancestors().find(|p| p.extension().map_or(false, |e| e == "app"));
        let target = bundle.unwrap_or(exe.as_path()).to_string_lossy().replace('\'', "'\\''");
        let _ = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("sleep 1; /usr/bin/open -n '{}'", target))
            .spawn();
    }
    app.exit(0);
}


/* =========================================================
   QUIT APP
   ========================================================= */

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/* =========================================================
   SCREENSHOT
   ========================================================= */

/// Every Clickr window title. New windows must be added here or they show up
/// in screenshots.
const OWN_WINDOW_TITLES: &[&str] = &["Clickr", "Clickr Settings", "Clickr Cursor", "Clickr Agent", "Clickr Bug Report"];

/// Frontmost app + window title, for App-Aware Assistance.
#[tauri::command]
async fn get_active_app() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        platform::active_window_info(OWN_WINDOW_TITLES).map(|(app, title)| match title {
            Some(t) => format!("{app} — \"{t}\""),
            None => app,
        })
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn capture_screenshot(_app: tauri::AppHandle, all_displays: bool, max_dimension: Option<u32>) -> Result<String, String> {
    let max_dim = max_dimension.unwrap_or(UPLOAD_MAX_DIMENSION).clamp(512, 2400);
    tauri::async_runtime::spawn_blocking(move || {
        let (w, h, rgba) = platform::capture_screen_excluding_windows(OWN_WINDOW_TITLES, all_displays)?;
        let img = image::RgbaImage::from_raw(w, h, rgba)
            .ok_or_else(|| "Failed to read the captured screen.".to_string())?;

        // Shrink before encoding (Triangle is much faster than Lanczos) and go
        // straight to JPEG. A full-size PNG round trip was a big part of the delay.
        let dynamic = image::DynamicImage::ImageRgba8(img);
        let resized = if dynamic.width().max(dynamic.height()) > max_dim {
            dynamic.resize(max_dim, max_dim, image::imageops::FilterType::Triangle)
        } else {
            dynamic
        };
        let rgb = resized.to_rgb8();

        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80)
            .encode_image(&rgb)
            .map_err(|e| e.to_string())?;

        Ok::<String, String>(format!("data:image/jpeg;base64,{}", general_purpose::STANDARD.encode(&buf)))
    })
    .await
    .map_err(|e| format!("Screenshot worker failed: {e}"))?
}


#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, ManagerExt, PanelBuilder, PanelLevel, StyleMask};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(AgentBarPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })

    panel!(MainPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            become_key_only_if_needed: true,
            is_floating_panel: true

        }
    })
}

/* =========================================================
   Permission Prompt (macOS only)
   ========================================================= */

#[cfg(target_os = "macos")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[tauri::command]
fn check_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[tauri::command]
fn request_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { CGRequestScreenCaptureAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn open_system_settings_pane(pane: String) {
    #[cfg(target_os = "macos")]
    {
        let url = match pane.as_str() {
            "screen_recording" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            _ => return,
        };

        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}


/* =========================================================
   AI REQUEST
   ========================================================= */
/// Splits a data URL like "data:image/jpeg;base64,AAAA..." into its mime
/// type and raw base64 payload. Needed because user-attached images can be
/// any format, unlike our own screenshots which are always PNG.
const UPLOAD_MAX_DIMENSION: u32 = 1568;

fn parse_data_url(data_url: &str) -> Result<(String, String), String> {
    let parts: Vec<&str> = data_url.splitn(2, ',').collect();

    if parts.len() != 2 {
        return Err("Invalid image data".to_string());
    }

    let header = parts[0];
    let base64_data = parts[1].to_string();

    let mime_type = header
        .strip_prefix("data:")
        .and_then(|s| s.split(';').next())
        .unwrap_or("image/png")
        .to_string();

    Ok((mime_type, base64_data))
}

/// Downscales an image to a max dimension and re-encodes as JPEG before
/// upload, so a Retina screenshot doesn't blow past the backend's size cap
/// or cost more quota-processing time than it needs to.
fn downscale_and_encode(bytes: &[u8], max_dimension: u32, quality: u8) -> Result<(String, String), String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;

    let resized = if img.width().max(img.height()) > max_dimension {
        img.resize(max_dimension, max_dimension, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let mut buf = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    resized
        .write_with_encoder(encoder)
        .map_err(|e| e.to_string())?;

    Ok((general_purpose::STANDARD.encode(&buf), "image/jpeg".to_string()))
}

/// Takes a data URL (from a screenshot or an attached file), decodes it,
/// downscales it, and returns (mime, base64) ready for the backend.
pub(crate) fn prepare_image_for_upload(data_url: &str) -> Result<(String, String), String> {
    prepare_image_for_upload_max(data_url, UPLOAD_MAX_DIMENSION)
}

pub(crate) fn prepare_image_for_upload_max(data_url: &str, max_dim: u32) -> Result<(String, String), String> {
    let (original_mime, base64_data) = parse_data_url(data_url)?;

    if !original_mime.starts_with("image/") {
        // PDFs/text files: pass through as-is, no image decoding attempted.
        return Ok((original_mime, base64_data));
    }

    let bytes = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Couldn't decode image data: {e}"))?;

    // Already a JPEG within the size limit (e.g. our own screenshots)? Send as is.
    if original_mime == "image/jpeg" {
        if let Ok(reader) = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format() {
            if let Ok((w, h)) = reader.into_dimensions() {
                if w.max(h) <= max_dim {
                    return Ok((original_mime, base64_data));
                }
            }
        }
    }

    let (data, mime) = downscale_and_encode(&bytes, max_dim, 82)?;
    Ok((mime, data))
}

const SYSTEM_PROMPT: &str = "You are Clickr AI, a helpful assistant that lives on the user's computer.\n\nBe concise and prefer direct answers.\nFormat code using markdown code blocks and equations using markdown math.\nWhen a screenshot is provided, use it only as visual context for the user's request; do not describe it unless that helps.\nA \"Clickr background context\" block may precede the user's message (time, active app, saved memories, recent conversation). Use it silently when relevant and never recite it.";

#[tauri::command]
async fn ask_ai(
    app: tauri::AppHandle,
    question: String,
    screenshot_base64: Option<String>,
    attached_images_base64: Option<Vec<String>>,
    context: Option<String>,
    stream_id: Option<String>,
) -> Result<String, engine::AskError> {
    let bad = |e: String| engine::AskError { kind: "bad_image".into(), message: e, retry_after_seconds: None };

    let mut images: Vec<(String, String)> = Vec::new();
    let mut files = String::new();
    for data_url in screenshot_base64.into_iter().chain(attached_images_base64.unwrap_or_default().into_iter().take(4)) {
        let (mime, data) = prepare_image_for_upload(&data_url).map_err(bad)?;
        if mime.starts_with("image/") {
            images.push((mime, data));
        } else if mime.starts_with("text/") {
            let bytes = general_purpose::STANDARD.decode(&data).map_err(|e| bad(e.to_string()))?;
            files.push_str(&format!("\n\n[Attached file]\n{}", String::from_utf8_lossy(&bytes).chars().take(20_000).collect::<String>()));
        } else {
            return Err(bad("Local models can't read this file type yet. Try an image or a text file.".into()));
        }
    }

    let context = context.filter(|c| !c.trim().is_empty());
    let text = match context {
        Some(c) => format!("{c}\n\n{question}{files}"),
        None => format!("{question}{files}"),
    };
    let mut parts = vec![serde_json::json!({ "type": "text", "text": text })];
    for (mime, data) in images {
        parts.push(serde_json::json!({ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{data}") } }));
    }
    let messages = serde_json::json!([
        { "role": "system", "content": SYSTEM_PROMPT },
        { "role": "user", "content": parts },
    ]);

    let reply = engine::chat(&app, messages, None, stream_id.as_deref()).await?;
    let answer = reply.get("content").and_then(|c| c.as_str()).unwrap_or("").trim().to_string();
    if answer.is_empty() {
        return Err(engine::AskError { kind: "unknown".into(), message: "The model sent an empty answer. Try again.".into(), retry_after_seconds: None });
    }
    Ok(answer)
}

/* =========================================================
   SET GLOBAL SHORTCUTS
   ========================================================= */

#[tauri::command]
fn set_global_shortcuts(
    app: tauri::AppHandle,
    toggle_shortcut: String,
    assist_shortcut: String,
    fallback_toggle_shortcut: String,
    fallback_assist_shortcut: String,
) -> Result<(), String> {
    let toggle: Shortcut = toggle_shortcut
        .parse()
        .map_err(|e| {
            format!(
                "Invalid toggle shortcut: {e}"
            )
        })?;

    let assist: Shortcut = assist_shortcut
        .parse()
        .map_err(|e| {
            format!(
                "Invalid assist shortcut: {e}"
            )
        })?;

    if toggle == assist {
        return Err(
            "Toggle and Assist shortcuts cannot be the same."
                .to_string(),
        );
    }

    let fallback_toggle: Shortcut =
        fallback_toggle_shortcut
            .parse()
            .map_err(|e| {
                format!(
                    "Invalid fallback toggle shortcut: {e}"
                )
            })?;

    let fallback_assist: Shortcut =
        fallback_assist_shortcut
            .parse()
            .map_err(|e| {
                format!(
                    "Invalid fallback assist shortcut: {e}"
                )
            })?;

    if fallback_toggle == fallback_assist {
        return Err(
            "Fallback shortcuts cannot be the same."
                .to_string(),
        );
    }

    let global =
        app.global_shortcut();

    global
        .unregister_all()
        .map_err(|e| e.to_string())?;

    if let Err(error) =
        global.register(toggle)
    {
        let _ = global.unregister_all();
        let _ = global.register(fallback_toggle.clone());
        let _ = global.register(fallback_assist.clone());

        let config = app.state::<ShortcutConfig>();
        *config.toggle.lock().unwrap() = fallback_toggle;
        *config.assist.lock().unwrap() = fallback_assist;

        return Err(format!(
            "Could not register toggle shortcut: {error}"
        ));
    }

    if let Err(error) =
        global.register(assist)
    {
        let _ = global.unregister_all();
        let _ = global.register(fallback_toggle.clone());
        let _ = global.register(fallback_assist.clone());

        let config = app.state::<ShortcutConfig>();
        *config.toggle.lock().unwrap() = fallback_toggle;
        *config.assist.lock().unwrap() = fallback_assist;

        return Err(format!(
            "Could not register assist shortcut: {error}"
        ));
    }

    let config =
        app.state::<ShortcutConfig>();

    *config
        .toggle
        .lock()
        .unwrap() = toggle;

    *config
        .assist
        .lock()
        .unwrap() = assist;

    Ok(())
}

/* =========================================================
   APP
   ========================================================= */

#[cfg_attr(
    mobile,
    tauri::mobile_entry_point
)]
pub fn run() {
        let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch (e.g. via the deep link) hands its args to this
            // running instance instead of opening a duplicate app.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    #[cfg(desktop)]
    {
        // In-app updates: checks the signed update feed and installs new versions.
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder = builder.plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    {
        // Optional "open at login" (off until the user turns it on in Settings).
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder = builder
        .manage(
            ShortcutConfig {
                toggle: Mutex::new(
                    DEFAULT_TOGGLE_SHORTCUT
                        .parse()
                        .unwrap(),
                ),
                assist: Mutex::new(
                    DEFAULT_ASSIST_SHORTCUT
                        .parse()
                        .unwrap(),
                ),
            },
        )
        .plugin(
            tauri_plugin_opener::init(),
        );

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(
                    |app, shortcut, event| {
                        if event.state
                            != ShortcutState::Pressed
                        {
                            return;
                        }

                        let config =
                            app.state::<ShortcutConfig>();

                        let is_assist = {
                            let assist =
                                config
                                    .assist
                                    .lock()
                                    .unwrap();

                            *assist == *shortcut
                        };

                        let is_toggle = {
                            let toggle =
                                config
                                    .toggle
                                    .lock()
                                    .unwrap();

                            *toggle == *shortcut
                        };

                        
                        if is_assist {
                            let _ =
                                app.emit(
                                    "assist-shortcut",
                                    (),
                                );
                        } else if is_toggle {
                            toggle_window(app);
                        }
                    },
                )
                .build(),
        )
        .setup(|app| {
            platform::hide_dock_icon(
                app.handle(),
            );

            #[cfg(target_os = "macos")]
            {
                PanelBuilder::<_, MainPanel>::new(&app.handle(), "main")
                    .url(WebviewUrl::App("index.html".into()))
                    .with_window(|w| {

                        w.title("Clickr")
                            .inner_size(680.0, 760.0)
                            .resizable(false)
                            .decorations(false)
                            .transparent(true)
                            .shadow(false)
                            .skip_taskbar(true)
                            .center()
                            .visible(false)
                    })
                    .level(PanelLevel::Floating)
                    .build()
                    .map_err(|e| e.to_string())?;

                // A transparent window with a native shadow shows a faint dark box.
                if let Ok(panel) = app.get_webview_panel("main") {
                    panel.as_panel().setHasShadow(false);
                }
            }

            let toggle: Shortcut =
                DEFAULT_TOGGLE_SHORTCUT
                    .parse()
                    .unwrap();

            let assist: Shortcut =
                DEFAULT_ASSIST_SHORTCUT
                    .parse()
                    .unwrap();

            app.global_shortcut()
                .register(toggle)?;

            app.global_shortcut()
                .register(assist)?;

            let show_hide =
                MenuItem::with_id(
                    app,
                    "show_hide",
                    "Show/Hide Clickr",
                    true,
                    None::<&str>,
                )?;

            let settings_item =
                MenuItem::with_id(
                    app,
                    "settings",
                    "Settings…",
                    true,
                    None::<&str>,
                )?;

            let report_item =
                MenuItem::with_id(
                    app,
                    "report_bug",
                    "Report a Bug…",
                    true,
                    None::<&str>,
                )?;

            let quit =
                MenuItem::with_id(
                    app,
                    "quit",
                    "Quit Clickr",
                    true,
                    None::<&str>,
                )?;

            let menu =
                Menu::with_items(
                    app,
                    &[&show_hide, &settings_item, &report_item, &quit],
                )?;
            let tray_icon_bytes = include_bytes!("../icons/tray-icon.png");
            let tray_icon_image = image::load_from_memory(tray_icon_bytes)
                .map_err(|e| e.to_string())?
                .into_rgba8();
            let (tray_icon_width, tray_icon_height) = tray_icon_image.dimensions();

            let tray_icon = tauri::image::Image::new_owned(
                tray_icon_image.into_raw(),
                tray_icon_width,
                tray_icon_height,
            );
            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_hide" => {
                        
                        toggle_window(app);
                    }
                    "settings" => {
                        let _ = open_settings(app.clone());
                    }
                    "report_bug" => {
                        let _ = open_bug_report(app.clone());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

             #[cfg(target_os = "macos")]
             {
                let ignoring = Arc::new(AtomicBool::new(false));
                app.manage(ClickThroughIgnoring(ignoring.clone()));

                if let Some(monitor) = platform::install_click_through_monitor(&app.handle(), ignoring) {
                    app.manage(monitor);
                }
             }

            show_main_window(app.handle());
            engine::start_idle_reaper();

            Ok(())
        })
        .invoke_handler(
            tauri::generate_handler![
                capture_screenshot,
                ask_ai,
                engine::check_ai,
                engine::ai_status,
                engine::ai_download_model,
                engine::ai_set_model,
                engine::system_ram_gb,
                set_global_shortcuts,
                open_settings,
                quit_app,
                read_image_file,
                update_clickable_rect,
                check_screen_recording_permission,
                open_system_settings_pane,
                local::get_session,
                request_screen_recording_permission,
                restart_app,
                set_drag_active,
                set_agent_hidden,
                hide_panel,
                agent_restore,
                show_panel,
                agent_bar_show,
                agent_bar_hide,
                set_click_through,
                get_active_app,
                agent::agent_step,
                agent::agent_exec,
                agent::agent_cursor_show,
                agent::agent_cursor_hide,
                agent::agent_tool_needs_screen,
                agent::check_accessibility,
                agent::request_accessibility,
                local::list_memories,
                local::add_memory,
                local::delete_memory,
                bug_diagnostics,
                open_bug_report,
            ]
        )
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Don't leave a model running (and holding memory) after Clickr quits.
            if let tauri::RunEvent::Exit = event {
                engine::shutdown();
            }
        });
}