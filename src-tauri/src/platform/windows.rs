// Windows native layer: screen capture, active-window info, input injection (Agent Mode),
// click-through for the transparent pill, and a few window helpers.
// Mirrors the function set of platform/macos.rs. Process is per-monitor DPI aware (tao sets that
// at startup), so every Win32 coordinate below is in physical pixels; "points" handed to the
// front end are logical (physical / scale of the primary display).

use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    EnumDisplayMonitors, HDC, HMONITOR, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
    DIB_RGB_COLORS, HGDIOBJ, MONITOR_DEFAULTTOPRIMARY, SRCCOPY,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    MAPVK_VK_TO_VSC, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY, VK_BACK, VK_CONTROL,
    VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_HOME, VK_INSERT, VK_LEFT, VK_MENU, VK_NEXT,
    VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, GetSystemMetrics,
    GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, SetCursorPos, SetForegroundWindow,
    SetWindowDisplayAffinity, SetWindowLongPtrW, ShowWindow, WindowFromPoint, GA_ROOT,
    GWL_EXSTYLE, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE,
    WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/* =========================================================
   Small helpers
   ========================================================= */

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    wide_to_string(&buf[..n as usize])
}

fn window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    wide_to_string(&buf[..n as usize])
}

pub(super) fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn own_pid() -> u32 {
    unsafe { GetCurrentProcessId() }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
    }
}

/// Executable file name without extension ("chrome", "notepad"), or None.
fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
    }
}

/// Friendly name for common apps; otherwise the exe name with a capital letter.
fn friendly_app_name(exe: &str) -> String {
    match exe.to_lowercase().as_str() {
        "chrome" => "Google Chrome".into(),
        "msedge" => "Microsoft Edge".into(),
        "firefox" => "Firefox".into(),
        "explorer" => "File Explorer".into(),
        "notepad" => "Notepad".into(),
        "code" => "Visual Studio Code".into(),
        "winword" => "Microsoft Word".into(),
        "excel" => "Microsoft Excel".into(),
        "powerpnt" => "Microsoft PowerPoint".into(),
        "outlook" | "olk" => "Microsoft Outlook".into(),
        "slack" => "Slack".into(),
        "discord" => "Discord".into(),
        "spotify" => "Spotify".into(),
        "windowsterminal" => "Windows Terminal".into(),
        "applicationframehost" => "Windows app".into(),
        _ => {
            let mut chars = exe.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => exe.to_string(),
            }
        }
    }
}

/* =========================================================
   Window lists
   ========================================================= */

unsafe extern "system" fn collect_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<HWND>);
    list.push(hwnd);
    BOOL(1)
}

/// All top-level windows, top of the z-order first.
pub(super) fn all_top_level_windows() -> Vec<HWND> {
    let mut list: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect_windows), LPARAM(&mut list as *mut Vec<HWND> as isize));
    }
    list
}

/// A window the user would call "an app window": visible, titled, not a tool/shell window, not Clickr.
fn is_user_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || is_cloaked(hwnd) {
            return false;
        }
        if window_pid(hwnd) == own_pid() {
            return false;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 {
            return false;
        }
        if window_text(hwnd).trim().is_empty() {
            return false;
        }
        !matches!(
            window_class(hwnd).as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "XamlExplorerHostIslandWindow"
        )
    }
}

/// The window the user is working in, ignoring Clickr: the foreground window if it is an
/// app window, otherwise the first app window down the z-order (Clickr's pill is usually
/// the foreground window while the user types a question).
pub(super) fn target_window() -> Option<HWND> {
    let fg = unsafe { GetForegroundWindow() };
    if !fg.0.is_null() && is_user_window(fg) {
        return Some(fg);
    }
    all_top_level_windows().into_iter().find(|h| is_user_window(*h))
}

/* =========================================================
   Screen capture
   ========================================================= */

/// Hides every Clickr window from screen capture (Windows 10 2004+), so the model never sees
/// the pill, the cursor overlay or the status bar. Cheap when already applied.
/// Debug builds only: CLICKR_NO_EXCLUDE=1 keeps Clickr visible to screenshots so its own
/// rendering can be inspected.
fn exclusion_disabled() -> bool {
    cfg!(debug_assertions) && std::env::var_os("CLICKR_NO_EXCLUDE").is_some()
}

fn exclude_own_windows_from_capture() {
    if exclusion_disabled() {
        return;
    }
    let me = own_pid();
    for hwnd in all_top_level_windows() {
        if window_pid(hwnd) != me {
            continue;
        }
        unsafe {
            let mut current = 0u32;
            let _ = GetWindowDisplayAffinity(hwnd, &mut current);
            if current != WDA_EXCLUDEFROMCAPTURE.0 {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            }
        }
    }
}

/// One BitBlt of a screen rectangle (physical pixels) into RGBA.
fn blit_rect(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("Couldn't access the screen.".to_string());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, HGDIOBJ(bitmap.0));

        let copied = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(mem, bitmap, 0, h as u32, Some(pixels.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);

        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if copied.is_err() || lines == 0 {
            return Err("Couldn't capture the screen.".to_string());
        }
        // BGRA -> RGBA, opaque.
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        Ok(pixels)
    }
}

/// Runs the capture on its own thread so a display that never answers (some virtual / remote
/// monitors block BitBlt forever) can be skipped instead of freezing Clickr.
fn blit_rect_with_timeout(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(blit_rect(x, y, w, h));
    });
    rx.recv_timeout(Duration::from_secs(4))
        .map_err(|_| "Timed out capturing a display.".to_string())?
}

unsafe extern "system" fn collect_monitors(
    _monitor: HMONITOR,
    _dc: HDC,
    rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<(i32, i32, i32, i32)>);
    let r = *rect;
    list.push((r.left, r.top, r.right - r.left, r.bottom - r.top));
    BOOL(1)
}

/// Every display as (x, y, width, height) in physical pixels, left to right.
fn monitor_rects() -> Vec<(i32, i32, i32, i32)> {
    let mut list: Vec<(i32, i32, i32, i32)> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect_monitors), LPARAM(&mut list as *mut _ as isize));
    }
    list.retain(|(_, _, w, h)| *w > 0 && *h > 0);
    list.sort_by_key(|(x, _, _, _)| *x);
    list
}

pub fn capture_screen_excluding_windows(
    _titles_to_exclude: &[&str],
    all_displays: bool,
) -> Result<(u32, u32, Vec<u8>), String> {
    exclude_own_windows_from_capture();

    let primary = (0, 0, unsafe { GetSystemMetrics(SM_CXSCREEN) }, unsafe { GetSystemMetrics(SM_CYSCREEN) });
    if primary.2 <= 0 || primary.3 <= 0 {
        return Err("No display found".to_string());
    }

    if !all_displays {
        let pixels = blit_rect_with_timeout(primary.0, primary.1, primary.2, primary.3)?;
        return Ok((primary.2 as u32, primary.3 as u32, pixels));
    }

    // Each display on its own, stitched left to right (like the macOS build). A display that
    // fails or times out is skipped as long as at least one works.
    // All displays are grabbed at the same time under one shared deadline.
    let jobs: Vec<_> = monitor_rects()
        .into_iter()
        .map(|(x, y, w, h)| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(blit_rect(x, y, w, h));
            });
            (w, h, rx)
        })
        .collect();
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    let mut images: Vec<image::RgbaImage> = Vec::new();
    for (w, h, rx) in jobs {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if let Ok(Ok(pixels)) = rx.recv_timeout(left) {
            if let Some(img) = image::RgbaImage::from_raw(w as u32, h as u32, pixels) {
                images.push(img);
            }
        }
    }
    if images.is_empty() {
        let pixels = blit_rect_with_timeout(primary.0, primary.1, primary.2, primary.3)?;
        return Ok((primary.2 as u32, primary.3 as u32, pixels));
    }
    if images.len() == 1 {
        let img = images.remove(0);
        return Ok((img.width(), img.height(), img.into_raw()));
    }
    let total_width: u32 = images.iter().map(|i| i.width()).sum();
    let max_height: u32 = images.iter().map(|i| i.height()).max().unwrap_or(0);
    let mut canvas = image::RgbaImage::new(total_width, max_height);
    let mut x_offset = 0i64;
    for img in &images {
        image::imageops::overlay(&mut canvas, img, x_offset, 0);
        x_offset += img.width() as i64;
    }
    Ok((canvas.width(), canvas.height(), canvas.into_raw()))
}

/* =========================================================
   Active window
   ========================================================= */

pub fn active_window_info(_titles_to_exclude: &[&str]) -> Option<(String, Option<String>)> {
    let hwnd = target_window()?;
    let exe = process_name(window_pid(hwnd))?;
    let title = window_text(hwnd);
    let title = if title.trim().is_empty() { None } else { Some(title) };
    Some((friendly_app_name(&exe), title))
}

/// PID of the app the user is working in (not Clickr).
pub fn frontmost_pid() -> Option<i32> {
    target_window().map(|h| window_pid(h) as i32)
}

pub fn pid_at_point(x: f64, y: f64) -> Option<i32> {
    let (px, py) = logical_to_physical(x, y);
    unsafe {
        let hwnd = WindowFromPoint(POINT { x: px as i32, y: py as i32 });
        if hwnd.0.is_null() {
            return None;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        Some(window_pid(if root.0.is_null() { hwnd } else { root }) as i32)
    }
}

/// Gives keyboard focus back to the app underneath Clickr (used when Agent Mode starts and
/// the pill steps aside, so the agent's keystrokes land in the app, not in Clickr).
pub fn focus_external_window() {
    if let Some(hwnd) = target_window() {
        unsafe {
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/* =========================================================
   Clickr's own windows
   ========================================================= */

/// Applied to the pill / status bar / cursor overlay windows right after they are built.
/// `tool` keeps them out of Alt-Tab; `no_activate` stops them from ever taking focus from the
/// app being controlled. All Clickr windows are excluded from screen capture.
pub fn prepare_overlay(window: &tauri::WebviewWindow, tool: bool, no_activate: bool) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if tool {
            ex |= WS_EX_TOOLWINDOW.0;
            ex &= !WS_EX_APPWINDOW.0;
        }
        if no_activate {
            ex |= WS_EX_NOACTIVATE.0;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize);
        if !exclusion_disabled() {
            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

/// tao rewrites a window's extended styles whenever one of its flags changes (the click-through
/// poller toggles one constantly), which drops WS_EX_TOOLWINDOW. Re-apply it so Clickr stays out
/// of Alt-Tab.
fn ensure_tool_window(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 == 0 {
            let new = (ex | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new as isize);
            let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    }
}

/// Shows a window without stealing focus.
pub fn show_no_activate(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0), SW_SHOWNOACTIVATE);
        }
    }
}

/// Hides a window that was shown with show_no_activate (tao's own hide() ignores it, because
/// tao never saw the window become visible).
pub fn hide_now(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0), SW_HIDE);
        }
    }
}

pub fn hide_dock_icon(_app: &tauri::AppHandle) {}
pub fn disable_window_shadow(_window: &tauri::WebviewWindow) {}

/// Windows 10/11 build, e.g. "10.0.26200".
pub fn os_version() -> String {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("cmd")
        .args(["/C", "ver"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            let start = s.find("Version ")? + "Version ".len();
            let end = s[start..].find(']')? + start;
            Some(s[start..end].trim().to_string())
        })
        .unwrap_or_default()
}

/// Relaunches Clickr a moment after this process has exited (single-instance would otherwise
/// turn the new copy away).
pub fn relaunch_after_exit() {
    use std::os::windows::process::CommandExt;
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new("cmd")
            .args(["/C", &format!("ping -n 2 127.0.0.1 >nul & start \"\" \"{}\"", exe.display())])
            .creation_flags(0x0800_0000)
            .spawn();
    }
}

/* =========================================================
   Click-through for the transparent pill
   ========================================================= */

/// WebView2 does not let clicks fall through its transparent pixels, so a small poller
/// switches the main window between "interactive" and "click-through" depending on whether
/// the cursor is over the clickable rectangle the front end reports. (Mac does the same
/// with a global mouse monitor.) It also keeps the pill click-through while Agent Mode runs.
pub fn start_click_through_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(25));
            let Some(window) = app.get_webview_window("main") else { continue };
            if !window.is_visible().unwrap_or(false) {
                last = None;
                continue;
            }
            ensure_tool_window(&window);
            let ignore = if crate::agent_hidden() {
                true
            } else if crate::is_drag_active() {
                false
            } else {
                match crate::safe_rect() {
                    None => false,
                    Some((rx, ry, rw, rh)) => {
                        let (Ok(pos), Ok(scale)) = (window.outer_position(), window.scale_factor()) else {
                            continue;
                        };
                        let mut cursor = POINT::default();
                        if unsafe { GetCursorPos(&mut cursor) }.is_err() {
                            continue;
                        }
                        // The page is zoomed (ui_zoom), so its CSS pixels are bigger on screen.
                        let scale = scale * ui_zoom();
                        let left = pos.x as f64 + rx * scale;
                        let top = pos.y as f64 + ry * scale;
                        let inside = (cursor.x as f64) >= left
                            && (cursor.x as f64) <= left + rw * scale
                            && (cursor.y as f64) >= top
                            && (cursor.y as f64) <= top + rh * scale;
                        !inside
                    }
                }
            };
            if last != Some(ignore) {
                last = Some(ignore);
                let _ = window.set_ignore_cursor_events(ignore);
            }
        }
    });
}

/* =========================================================
   Display geometry
   ========================================================= */

pub(super) fn primary_scale() -> f64 {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let (mut dx, mut dy) = (96u32, 96u32);
        if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy).is_ok() && dx > 0 {
            return dx as f64 / 96.0;
        }
    }
    1.0
}

/// Page zoom for Clickr's own windows. Defaults to 1.0: at 1.0 the pill takes up the same share
/// of a 1080p screen as it does on a 15" MacBook Air, which is the intended look. To nudge it
/// without rebuilding, put a number (0.8 to 1.5, e.g. 1.05) in the file
/// `ui-zoom.txt` inside the `net.getclickr.app` folder under %APPDATA%, then restart Clickr.
pub fn ui_zoom() -> f64 {
    static ZOOM: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *ZOOM.get_or_init(|| {
        std::env::var_os("APPDATA")
            .map(|d| std::path::PathBuf::from(d).join("net.getclickr.app").join("ui-zoom.txt"))
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .map(|z| z.clamp(0.8, 1.5))
            .unwrap_or(1.0)
    })
}

fn primary_physical_size() -> (f64, f64) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN) as f64, GetSystemMetrics(SM_CYSCREEN) as f64) }
}

fn logical_to_physical(x: f64, y: f64) -> (f64, f64) {
    let s = primary_scale();
    (x * s, y * s)
}

/// Maps the agent's 0-1000 grid to logical points on the primary display.
pub fn to_screen_point(x: f64, y: f64) -> (f64, f64) {
    let (_, _, w, h) = main_display_bounds();
    (x.clamp(0.0, 1000.0) / 1000.0 * w, y.clamp(0.0, 1000.0) / 1000.0 * h)
}

/// (x, y, width, height) of the primary display in logical points.
pub fn main_display_bounds() -> (f64, f64, f64, f64) {
    let s = primary_scale();
    let (w, h) = primary_physical_size();
    (0.0, 0.0, w / s, h / s)
}

/// 0-1000 grid -> physical pixels on the primary display.
fn to_physical(x: f64, y: f64) -> (i32, i32) {
    let (w, h) = primary_physical_size();
    (
        (x.clamp(0.0, 1000.0) / 1000.0 * (w - 1.0)).round() as i32,
        (y.clamp(0.0, 1000.0) / 1000.0 * (h - 1.0)).round() as i32,
    )
}

/* =========================================================
   Permissions (none on Windows)
   ========================================================= */

pub fn accessibility_trusted() -> bool {
    true
}
pub fn request_accessibility() -> bool {
    true
}

/* =========================================================
   Input (Agent Mode)
   ========================================================= */

static LAST_POINT: Mutex<Option<(i32, i32)>> = Mutex::new(None);

fn token_elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
            return Some(true); // access denied: it is running at a higher level than we are
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if ok { Some(elevation.TokenIsElevated != 0) } else { None }
    }
}

fn pid_is_elevated(pid: u32) -> Option<bool> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let r = token_elevated(handle);
        let _ = CloseHandle(handle);
        r
    }
}

fn self_elevated() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        // GetCurrentProcess() is a pseudo handle (-1).
        token_elevated(HANDLE(-1isize as *mut _)).unwrap_or(false)
    })
}

const ELEVATED_MSG: &str = "That window belongs to an app running as administrator, and Windows blocks Clickr from controlling it. Ask the user to do this step themselves (or to run Clickr as administrator).";

fn check_controllable(hwnd: HWND) -> Result<(), String> {
    if hwnd.0.is_null() {
        return Ok(());
    }
    if !self_elevated() && pid_is_elevated(window_pid(hwnd)) == Some(true) {
        return Err(ELEVATED_MSG.to_string());
    }
    Ok(())
}

/// Keyboard input goes to the foreground window: make sure it is an app, not Clickr itself,
/// and that Windows will let us talk to it.
fn check_keyboard_target() -> Result<(), String> {
    let fg = unsafe { GetForegroundWindow() };
    if !fg.0.is_null() && window_pid(fg) == own_pid() {
        // The pill normally steps aside first; hand focus back to the app underneath.
        focus_external_window();
        std::thread::sleep(Duration::from_millis(120));
        let fg = unsafe { GetForegroundWindow() };
        if !fg.0.is_null() && window_pid(fg) == own_pid() {
            return Err("Nothing was typed: Clickr's own window has focus. Click into the app first.".to_string());
        }
    }
    let fg = unsafe { GetForegroundWindow() };
    check_controllable(fg)
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err("Windows blocked the input (the target app may be running as administrator).".to_string());
    }
    Ok(())
}

fn mouse_input(flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn vk_key(vk: u16, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if matches!(
        VIRTUAL_KEY(vk),
        VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_INSERT | VK_DELETE
    ) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    key_input(vk, scan, flags)
}

fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok().map(|_| (p.x, p.y))
}

/// Moves the real pointer, clicks, and puts the pointer back where the user had it.
/// (Windows has no per-process input, so `real` makes no difference here.)
pub fn mouse_click(x: f64, y: f64, right: bool, double: bool, _real: bool) -> Result<(), String> {
    let (px, py) = to_physical(x, y);
    let target = unsafe {
        let h = WindowFromPoint(POINT { x: px, y: py });
        if h.0.is_null() { h } else { GetAncestor(h, GA_ROOT) }
    };
    check_controllable(target)?;

    let original = cursor_pos();
    unsafe { SetCursorPos(px, py) }.map_err(|_| "Couldn't move the pointer.".to_string())?;
    *LAST_POINT.lock().unwrap() = Some((px, py));
    std::thread::sleep(Duration::from_millis(40));

    let (down, up) = if right {
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    } else {
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    };
    for _ in 0..(if double { 2 } else { 1 }) {
        send(&[mouse_input(down, 0)])?;
        std::thread::sleep(Duration::from_millis(25));
        send(&[mouse_input(up, 0)])?;
        std::thread::sleep(Duration::from_millis(25));
    }

    if let Some((ox, oy)) = original {
        std::thread::sleep(Duration::from_millis(60));
        unsafe {
            let _ = SetCursorPos(ox, oy);
        }
    }
    Ok(())
}

/// Types text as real Unicode keystrokes into whatever has focus (works for every language,
/// emoji and symbol, and leaves the clipboard alone).
pub fn type_text(text: &str, _real: bool) -> Result<(), String> {
    check_keyboard_target()?;
    std::thread::sleep(Duration::from_millis(140));

    for ch in text.chars() {
        match ch {
            '\r' => continue,
            '\n' => {
                send(&[vk_key(VK_RETURN.0, false), vk_key(VK_RETURN.0, true)])?;
            }
            '\t' => {
                send(&[vk_key(VK_TAB.0, false), vk_key(VK_TAB.0, true)])?;
            }
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units).iter().copied() {
                    send(&[
                        key_input(0, unit, KEYEVENTF_UNICODE),
                        key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
                    ])?;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(3));
    }
    Ok(())
}

fn vk_for_key(key: &str) -> Option<u16> {
    let lower = key.to_lowercase();
    let named = match lower.as_str() {
        "return" | "enter" => VK_RETURN.0,
        "tab" => VK_TAB.0,
        "space" => VK_SPACE.0,
        "delete" | "backspace" => VK_BACK.0,
        "forwarddelete" => VK_DELETE.0,
        "escape" | "esc" => VK_ESCAPE.0,
        "left" => VK_LEFT.0,
        "right" => VK_RIGHT.0,
        "up" => VK_UP.0,
        "down" => VK_DOWN.0,
        "home" => VK_HOME.0,
        "end" => VK_END.0,
        "pageup" => VK_PRIOR.0,
        "pagedown" => VK_NEXT.0,
        "insert" => VK_INSERT.0,
        "period" => return vk_for_char('.'),
        "comma" => return vk_for_char(','),
        "minus" | "dash" => return vk_for_char('-'),
        "equal" | "equals" => return vk_for_char('='),
        "slash" => return vk_for_char('/'),
        "backslash" => return vk_for_char('\\'),
        "semicolon" => return vk_for_char(';'),
        "quote" => return vk_for_char('\''),
        "backtick" => return vk_for_char('`'),
        "bracketleft" => return vk_for_char('['),
        "bracketright" => return vk_for_char(']'),
        _ => 0,
    };
    if named != 0 {
        return Some(named);
    }
    // F1..F12
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=12).contains(&n) {
            return Some(VK_F1.0 + n - 1);
        }
    }
    let mut it = key.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => vk_for_char(c),
        _ => None,
    }
}

fn vk_for_char(c: char) -> Option<u16> {
    let mut units = [0u16; 2];
    let unit = *c.encode_utf16(&mut units).first()?;
    let r = unsafe { VkKeyScanW(unit) };
    if r == -1 {
        return None;
    }
    Some((r & 0xFF) as u16)
}

pub fn press_key(key: &str, modifiers: &[String], _real: bool) -> Result<(), String> {
    let lower = key.to_lowercase();
    let has = |m: &str| modifiers.iter().any(|x| x == m);
    // Never let the agent quit apps or close windows by keyboard, whatever the model decides.
    // ("cmd" is treated as Ctrl on Windows, so Cmd+Q maps to Ctrl+Q.)
    if ((has("cmd") || has("ctrl")) && lower == "q")
        || (has("alt") && lower == "f4")
        || (has("cmd") && has("alt") && (lower == "escape" || lower == "esc"))
        || (has("ctrl") && has("alt") && lower == "delete")
    {
        return Err("Quitting apps is blocked for safety. Ask the user to do it.".to_string());
    }

    check_keyboard_target()?;

    let vk = vk_for_key(key).ok_or_else(|| format!("Unsupported key: {key}"))?;
    let mut mods: Vec<u16> = Vec::new();
    for m in modifiers {
        let vk_mod = match m.as_str() {
            "cmd" | "ctrl" => VK_CONTROL.0,
            "shift" => VK_SHIFT.0,
            "alt" => VK_MENU.0,
            _ => continue,
        };
        if !mods.contains(&vk_mod) {
            mods.push(vk_mod);
        }
    }

    let mut events: Vec<INPUT> = Vec::new();
    for m in &mods {
        events.push(vk_key(*m, false));
    }
    events.push(vk_key(vk, false));
    events.push(vk_key(vk, true));
    for m in mods.iter().rev() {
        events.push(vk_key(*m, true));
    }
    send(&events)
}

/// Positive `amount` scrolls down (like the macOS side). Scrolls over the spot the agent last
/// clicked, or the middle of the app window if it hasn't clicked yet.
pub fn scroll(amount: i32, _real: bool) -> Result<(), String> {
    let spot = (*LAST_POINT.lock().unwrap()).or_else(|| {
        let hwnd = target_window()?;
        let mut r = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut r) }.ok()?;
        Some(((r.left + r.right) / 2, (r.top + r.bottom) / 2))
    });
    if let Some((x, y)) = spot {
        let target = unsafe {
            let h = WindowFromPoint(POINT { x, y });
            if h.0.is_null() { h } else { GetAncestor(h, GA_ROOT) }
        };
        check_controllable(target)?;
    }

    let original = cursor_pos();
    if let Some((x, y)) = spot {
        unsafe {
            let _ = SetCursorPos(x, y);
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    // One "line" is 120 wheel units; the wheel is positive-up, the agent's amount positive-down.
    let result = send(&[mouse_input(MOUSEEVENTF_WHEEL, -amount * 120)]);
    if let Some((ox, oy)) = original {
        std::thread::sleep(Duration::from_millis(60));
        unsafe {
            let _ = SetCursorPos(ox, oy);
        }
    }
    result
}

/* =========================================================
   Recycle Bin
   ========================================================= */

pub fn trash_path(path: &std::path::Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    let mut wide: Vec<u16> = path.to_string_lossy().encode_utf16().collect();
    wide.push(0);
    wide.push(0); // double-null terminated list
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(wide.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
        ..Default::default()
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc == 0 && !op.fAnyOperationsAborted.as_bool() {
        Ok(())
    } else {
        Err("Couldn't move it to the Recycle Bin.".to_string())
    }
}


pub(super) fn is_visible_uncloaked(hwnd: HWND) -> bool {
    unsafe { IsWindowVisible(hwnd).as_bool() && !is_cloaked(hwnd) }
}

/// Primary display size in physical pixels.
pub(super) fn main_display_bounds_physical() -> (f64, f64) {
    primary_physical_size()
}
