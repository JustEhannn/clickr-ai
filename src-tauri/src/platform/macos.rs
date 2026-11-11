use screencapturekit::prelude::*;
use screencapturekit::screenshot_manager::SCScreenshotManager;
use screencapturekit::screenshot_manager::CGImageExt;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri_nspanel::ManagerExt;

/// Holds the native global mouse-move monitor alive for the app's lifetime.
/// If this gets dropped, the monitor is removed — so it's stored in Tauri's
/// managed state and never dropped while the app runs.
pub struct MouseMonitor {
    _monitor: Retained<AnyObject>,
}

unsafe impl Send for MouseMonitor {}
unsafe impl Sync for MouseMonitor {}

/// Installs a global (system-wide) mouse-move monitor and uses it to toggle
/// the main window's click-through state. This is independent of whether
/// the window itself is currently receiving mouse events — necessary
/// because a window with ignoresMouseEvents=true stops receiving ANY mouse
/// events, including the moves needed to detect "cursor is back over real
/// UI," which is what made the naive JS-only approach get stuck.
pub fn install_click_through_monitor(
    app: &tauri::AppHandle,
    ignoring: Arc<AtomicBool>,
) -> Option<MouseMonitor> {
    let mtm = MainThreadMarker::new()?;
    let app_handle = app.clone();

    let _ = mtm;

    let block = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        // A drag of files (from Finder etc.) generates LeftMouseDragged, not
        // MouseMoved, so without this the panel stays click-through during a
        // drag and never sees the drop — which is why dropping only worked
        // while Clickr had focus.
        let is_drag = unsafe { event.as_ref().r#type() } == NSEventType::LeftMouseDragged;

        if is_drag && !dragging_files() {
            return;
        }

        if crate::is_drag_active() {
            return;
        }

        // Both the mouse position and the window frame are in the same global,
        // bottom-left coordinate space, so no flipping or cached screen height
        // is needed — and the frame is read fresh, so dragging the pill around
        // can't leave us comparing against an old position.
        let location = NSEvent::mouseLocation();

        let inside = (|| {
            let (rx, ry, rw, rh) = crate::safe_rect()?;
            let panel = app_handle.get_webview_panel("main").ok()?;
            let frame = panel.as_panel().frame();
            let left = frame.origin.x + rx;
            let top = frame.origin.y + frame.size.height - ry;
            Some(
                location.x >= left
                    && location.x <= left + rw
                    && location.y <= top
                    && location.y >= top - rh,
            )
        })()
        .unwrap_or(false);

        // While Agent Mode runs the chat is hidden and must not catch any clicks.
        let should_ignore = crate::agent_hidden() || !inside;

        if should_ignore != ignoring.load(Ordering::Relaxed) {
            ignoring.store(should_ignore, Ordering::Relaxed);

            if let Ok(panel) = app_handle.get_webview_panel("main") {
                panel.set_ignores_mouse_events(should_ignore);

                if should_ignore {
                    panel.resign_key_window();
                } else if !is_drag {
                    // Don't steal focus for a drop; receiving the drag is enough.
                    panel.make_key_window();
                }
            }
        }
    });

    let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::MouseMoved | NSEventMask::LeftMouseDragged,
        &block,
    )?;

    Some(MouseMonitor { _monitor: monitor })
}

/// True while the system drag pasteboard holds files.
fn dragging_files() -> bool {
    let pb = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
    match pb.types() {
        Some(types) => types
            .iter()
            .any(|t| &*t == unsafe { NSPasteboardTypeFileURL }),
        None => false,
    }
}

/// Hides the app from the Dock and app switcher, so Clickr behaves as a
/// menu-bar-only utility rather than a normal application window.
pub fn hide_dock_icon(app: &tauri::AppHandle) {
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

use objc2_app_kit::NSWindow;

/// Tauri's .shadow(false) builder option doesn't reliably suppress the
/// native shadow on plain (non-panel) windows on macOS — this does it
/// directly via AppKit.
pub fn disable_window_shadow(window: &tauri::WebviewWindow) {
    if let Ok(ns_window) = window.ns_window() {
        let ns_window = ns_window as *mut NSWindow;
        unsafe {
            if let Some(w) = ns_window.as_ref() {
                w.setHasShadow(false);
            }
        }
    }
}

/// Captures one display (excluding Clickr's own windows) as an RGBA image.
fn capture_display_rgba(
    display: &SCDisplay,
    own_windows: &[&SCWindow],
) -> Result<image::RgbaImage, String> {
    let filter = SCContentFilter::create()
        .with_display(display)
        .with_excluding_windows(own_windows)
        .build();

    let config = SCStreamConfiguration::new()
        .with_width(display.width() as u32)
        .with_height(display.height() as u32);

    let image = SCScreenshotManager::capture_image(&filter, &config).map_err(|e| e.to_string())?;
    let rgba = image.rgba_data().map_err(|e| e.to_string())?;

    image::RgbaImage::from_raw(image.width() as u32, image.height() as u32, rgba)
        .ok_or_else(|| "Failed to build image from captured pixel data".to_string())
}

/// Captures the screen while excluding Clickr's own window(s) using
/// ScreenCaptureKit's native window-exclusion support. With `all_displays`
/// every monitor is captured and stitched left-to-right (by physical
/// position) into one image; otherwise only the primary display.
pub fn capture_screen_excluding_windows(
    titles_to_exclude: &[&str],
    all_displays: bool,
) -> Result<(u32, u32, Vec<u8>), String> {
    let content = SCShareableContent::get().map_err(|e| e.to_string())?;

    let mut displays = content.displays();
    if displays.is_empty() {
        return Err("No display found".to_string());
    }
    if !all_displays {
        displays.truncate(1);
    } else {
        displays.sort_by(|a, b| {
            a.frame()
                .origin
                .x
                .partial_cmp(&b.frame().origin.x)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    let own_windows: Vec<SCWindow> = content
        .windows()
        .into_iter()
        .filter(|w| {
            w.title()
                .map(|title| titles_to_exclude.contains(&title.as_str()))
                .unwrap_or(false)
        })
        .collect();
    let own_window_refs: Vec<&SCWindow> = own_windows.iter().collect();

    let mut images = Vec::new();
    for display in &displays {
        images.push(capture_display_rgba(display, &own_window_refs)?);
    }

    let buffer = if images.len() == 1 {
        images.remove(0)
    } else {
        let total_width: u32 = images.iter().map(|i| i.width()).sum();
        let max_height: u32 = images.iter().map(|i| i.height()).max().unwrap_or(0);
        let mut canvas = image::RgbaImage::new(total_width, max_height);
        let mut x_offset = 0i64;
        for img in &images {
            image::imageops::overlay(&mut canvas, img, x_offset, 0);
            x_offset += img.width() as i64;
        }
        canvas
    };

    Ok((buffer.width(), buffer.height(), buffer.into_raw()))
}

/// Returns (app name, window title) of the frontmost user window, ignoring
/// Clickr itself. Used for App-Aware Assistance.
pub fn active_window_info(titles_to_exclude: &[&str]) -> Option<(String, Option<String>)> {
    let content = SCShareableContent::get().ok()?;

    for w in content.windows() {
        if !w.is_active() || w.window_layer() != 0 {
            continue;
        }
        let title = w.title();
        if let Some(t) = &title {
            if titles_to_exclude.contains(&t.as_str()) {
                continue;
            }
        }
        let app = w.owning_application()?;
        if app.bundle_identifier() == "net.getclickr.app" {
            continue;
        }
        let title = title.filter(|t| !t.trim().is_empty());
        return Some((app.application_name(), title));
    }
    None
}

// ---------------------------------------------------------------------------
// Computer control (Agent Mode). Needs the Accessibility permission.
// Coordinates arrive normalised to a 0-1000 grid over the main display.
//
// By default input is posted straight to the target app's process (the app
// under the point), so the user's real mouse pointer never moves — the on-screen
// agent cursor is a separate overlay. "Real mouse" mode posts to the system
// instead, for apps that ignore directly-posted events.
// ---------------------------------------------------------------------------

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use core_graphics::window::{copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly};
use foreign_types::ForeignType;
use std::sync::atomic::AtomicI32;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

extern "C" {
    fn CGEventPostToPid(pid: i32, event: *mut std::ffi::c_void);
    fn CGEventSetLocation(event: *mut std::ffi::c_void, point: CGPoint);
    fn CGEventCreateScrollWheelEvent(
        source: *const std::ffi::c_void,
        units: u32,
        wheel_count: u32,
        wheel1: i32, ...
    ) -> *mut std::ffi::c_void;
    fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
    fn CFRelease(cf: *const std::ffi::c_void);
}

pub fn set_target_pid(pid: i32) {
    TARGET_PID.store(pid, Ordering::Relaxed);
}

/// The app the agent last clicked in; keyboard input follows it.
static TARGET_PID: AtomicI32 = AtomicI32::new(0);

pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> bool;
}

/// Asks macOS for Accessibility access. This is what makes Clickr appear in the
/// Accessibility list and shows macOS's own "allow" prompt. Only ever called after
/// the user chooses to turn Agent Mode on.
pub fn request_accessibility() -> bool {
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

fn event_source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "Couldn't create an input event source.".to_string())
}

fn require_accessibility() -> Result<(), String> {
    if accessibility_trusted() {
        Ok(())
    } else {
        Err("Accessibility permission is required for computer control. Enable Clickr in System Settings → Privacy & Security → Accessibility, then restart Clickr.".to_string())
    }
}

/// Maps the agent's 0-1000 grid to global screen points on the main display.
pub fn to_screen_point(x: f64, y: f64) -> (f64, f64) {
    let p = to_point(x, y);
    (p.x, p.y)
}

/// (x, y, width, height) of the main display in points.
pub fn main_display_bounds() -> (f64, f64, f64, f64) {
    let b = CGDisplay::main().bounds();
    (b.origin.x, b.origin.y, b.size.width, b.size.height)
}

fn to_point(x: f64, y: f64) -> CGPoint {
    let b = CGDisplay::main().bounds();
    CGPoint::new(
        b.origin.x + (x.clamp(0.0, 1000.0) / 1000.0) * b.size.width,
        b.origin.y + (y.clamp(0.0, 1000.0) / 1000.0) * b.size.height,
    )
}

fn dict_number(d: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<f64> {
    d.find(CFString::from_static_string(key))
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_f64())
}

/// Visible, normal app windows from front to back: (pid, x, y, w, h, window number).
fn visible_windows() -> Vec<(i32, f64, f64, f64, f64, i64)> {
    let me = std::process::id() as i32;
    let Some(list) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for item in list.iter() {
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };

        let layer = dict_number(&dict, "kCGWindowLayer").unwrap_or(0.0);
        let alpha = dict_number(&dict, "kCGWindowAlpha").unwrap_or(1.0);
        let pid = dict_number(&dict, "kCGWindowOwnerPID").unwrap_or(0.0) as i32;
        if layer != 0.0 || alpha < 0.05 || pid == 0 || pid == me {
            continue;
        }

        let Some(bounds) = dict
            .find(CFString::from_static_string("kCGWindowBounds"))
            .and_then(|v| v.downcast::<CFDictionary>())
        else {
            continue;
        };
        let bounds: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef()) };
        let (Some(x), Some(y), Some(w), Some(h)) = (
            dict_number(&bounds, "X"),
            dict_number(&bounds, "Y"),
            dict_number(&bounds, "Width"),
            dict_number(&bounds, "Height"),
        ) else {
            continue;
        };
        let number = dict_number(&dict, "kCGWindowNumber").unwrap_or(0.0) as i64;
        out.push((pid, x, y, w, h, number));
    }
    out
}

/// The app whose window is on top at this screen point.
pub fn pid_at_point(x: f64, y: f64) -> Option<i32> {
    window_at(&CGPoint::new(x, y)).map(|(p, _)| p)
}

fn window_at(pt: &CGPoint) -> Option<(i32, i64)> {
    visible_windows()
        .into_iter()
        .find(|(_, x, y, w, h, _)| pt.x >= *x && pt.x <= x + w && pt.y >= *y && pt.y <= y + h)
        .map(|(pid, _, _, _, _, number)| (pid, number))
}

/// The frontmost regular app (used for typing before anything was clicked).
pub fn frontmost_pid() -> Option<i32> {
    visible_windows().first().map(|(pid, ..)| *pid)
}

fn target_pid() -> Option<i32> {
    let t = TARGET_PID.load(Ordering::Relaxed);
    if t > 0 { Some(t) } else { frontmost_pid() }
}

/// Brings the target app forward if it isn't already (no mouse movement involved).
fn ensure_active(pid: i32) {
    use objc2_app_kit::NSRunningApplication;
    if frontmost_pid() == Some(pid) {
        return;
    }
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        if let Some(bundle) = app.bundleIdentifier() {
            let _ = std::process::Command::new("open").arg("-b").arg(bundle.to_string()).status();
            std::thread::sleep(std::time::Duration::from_millis(180));
        }
    }
}

fn post(ev: &CGEvent, pid: Option<i32>) {
    match pid {
        Some(pid) => unsafe { CGEventPostToPid(pid, ev.as_ptr() as *mut std::ffi::c_void) },
        None => ev.post(CGEventTapLocation::HID),
    }
}

/// `real_mouse` = true posts through the system (reliable everywhere; the pointer is
/// put back where the user had it afterwards). false posts straight to the app
/// under the point so the pointer never moves — experimental.
pub fn mouse_click(x: f64, y: f64, right: bool, double: bool, real_mouse: bool) -> Result<(), String> {
    require_accessibility()?;
    let source = event_source()?;
    let pt = to_point(x, y);
    let (down_t, up_t, button) = if right {
        (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right)
    } else {
        (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left)
    };

    let target = if real_mouse { None } else { window_at(&pt) };
    let pid = target.map(|(p, _)| p);
    if let Some(p) = pid {
        TARGET_PID.store(p, Ordering::Relaxed);
        ensure_active(p);
    } else if real_mouse {
        if let Some((p, _)) = window_at(&pt) {
            TARGET_PID.store(p, Ordering::Relaxed);
        }
    }

    // Remember where the user's pointer was so it can be put back.
    let original = if real_mouse {
        CGEvent::new(source.clone()).ok().map(|e| e.location())
    } else {
        None
    };

    let with_window = |ev: &CGEvent| {
        if let Some((_, number)) = target {
            // Tell AppKit which window the event is for (fields 91/92), otherwise
            // many apps drop events posted directly to a process.
            ev.set_integer_value_field(91, number);
            ev.set_integer_value_field(92, number);
        }
    };

    let moved = CGEvent::new_mouse_event(source.clone(), CGEventType::MouseMoved, pt, CGMouseButton::Left)
        .map_err(|_| "mouse move failed".to_string())?;
    with_window(&moved);
    post(&moved, pid);
    std::thread::sleep(std::time::Duration::from_millis(40));

    let clicks = if double { 2 } else { 1 };
    for n in 1..=clicks {
        for t in [down_t, up_t] {
            let ev = CGEvent::new_mouse_event(source.clone(), t, pt, button)
                .map_err(|_| "mouse click failed".to_string())?;
            ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, n);
            with_window(&ev);
            post(&ev, pid);
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    if let Some(orig) = original {
        std::thread::sleep(std::time::Duration::from_millis(60));
        if let Ok(back) = CGEvent::new_mouse_event(source, CGEventType::MouseMoved, orig, CGMouseButton::Left) {
            back.post(CGEventTapLocation::HID);
        }
    }
    Ok(())
}

/// Types text into whatever is focused.
/// - Plain keyboard characters are sent as real key presses (with proper key codes and
///   Shift), which is what number fields, search boxes and editors expect.
/// - Anything else (emoji, accents, very long text) is pasted, with the user's
///   clipboard text put back afterwards, or typed as raw Unicode as a last resort.
pub fn type_text(text: &str, real_mouse: bool) -> Result<(), String> {
    require_accessibility()?;

    // Make sure the keystrokes land in the app the agent has been working in.
    let pid = if real_mouse { None } else { target_pid() };
    if let Some(p) = target_pid() {
        ensure_active(p);
    }
    // Give a field that was just clicked or focused a moment to take focus.
    std::thread::sleep(std::time::Duration::from_millis(140));

    let count = text.chars().count();
    if count <= 120 && text.chars().all(|c| key_for_char(c).is_some()) {
        return type_keys(text, pid);
    }
    if count >= 4 && paste_text(text, pid).is_ok() {
        return Ok(());
    }

    let source = event_source()?;
    let chars: Vec<char> = text.chars().collect();
    for chunk in chars.chunks(8) {
        let s: String = chunk.iter().collect();
        for down in [true, false] {
            let ev = CGEvent::new_keyboard_event(source.clone(), 0, down)
                .map_err(|_| "key event failed".to_string())?;
            ev.set_string(&s);
            post(&ev, pid);
        }
        std::thread::sleep(std::time::Duration::from_millis(18));
    }
    Ok(())
}

/// One real key press per character: key code + Shift + the character itself.
fn type_keys(text: &str, pid: Option<i32>) -> Result<(), String> {
    let source = event_source()?;
    for c in text.chars() {
        let Some((code, shift)) = key_for_char(c) else { continue };
        let flags = if shift { CGEventFlags::CGEventFlagShift } else { CGEventFlags::empty() };
        let s = c.to_string();
        for down in [true, false] {
            let ev = CGEvent::new_keyboard_event(source.clone(), code, down)
                .map_err(|_| "key event failed".to_string())?;
            ev.set_flags(flags);
            if c != '\n' && c != '\t' {
                ev.set_string(&s);
            }
            post(&ev, pid);
            std::thread::sleep(std::time::Duration::from_millis(6));
        }
        std::thread::sleep(std::time::Duration::from_millis(14));
    }
    Ok(())
}

/// Pastes via the clipboard (Cmd+V). Refuses if the clipboard holds something
/// other than text (an image, files) so the user's clipboard is never lost.
fn paste_text(text: &str, pid: Option<i32>) -> Result<(), String> {
    use objc2_app_kit::NSPasteboardTypeString;
    use objc2_foundation::NSString;

    let pb = NSPasteboard::generalPasteboard();
    let text_only = pb
        .types()
        .map(|types| {
            types.iter().all(|t| {
                let t = t.to_string();
                t.contains("text") || t.contains("String") || t.starts_with("dyn.")
            })
        })
        .unwrap_or(true);
    if !text_only {
        return Err("clipboard holds non-text data".to_string());
    }

    let saved = unsafe { pb.stringForType(NSPasteboardTypeString) };
    unsafe {
        pb.clearContents();
        pb.setString_forType(&NSString::from_str(text), NSPasteboardTypeString);
    }

    let source = event_source()?;
    let code = 9u16; // "v"
    for down in [true, false] {
        let ev = CGEvent::new_keyboard_event(source.clone(), code, down).map_err(|_| "key event failed".to_string())?;
        ev.set_flags(CGEventFlags::CGEventFlagCommand);
        post(&ev, pid);
    }
    std::thread::sleep(std::time::Duration::from_millis(220));

    unsafe {
        pb.clearContents();
        if let Some(prev) = saved {
            pb.setString_forType(&prev, NSPasteboardTypeString);
        }
    }
    Ok(())
}

/// US-layout keycode (and whether Shift is needed) for a typed character.
fn key_for_char(c: char) -> Option<(u16, bool)> {
    if c.is_ascii_uppercase() {
        return keycode_for(&c.to_ascii_lowercase().to_string()).map(|k| (k, true));
    }
    if c.is_ascii_lowercase() || c.is_ascii_digit() {
        return keycode_for(&c.to_string()).map(|k| (k, false));
    }
    Some(match c {
        ' ' => (49, false),
        '\n' => (36, false),
        '\t' => (48, false),
        '-' => (27, false), '=' => (24, false), '[' => (33, false), ']' => (30, false),
        '\\' => (42, false), ';' => (41, false), '\'' => (39, false), ',' => (43, false),
        '.' => (47, false), '/' => (44, false), '`' => (50, false),
        '!' => (18, true), '@' => (19, true), '#' => (20, true), '$' => (21, true),
        '%' => (23, true), '^' => (22, true), '&' => (26, true), '*' => (28, true),
        '(' => (25, true), ')' => (29, true), '_' => (27, true), '+' => (24, true),
        '{' => (33, true), '}' => (30, true), '|' => (42, true), ':' => (41, true),
        '"' => (39, true), '<' => (43, true), '>' => (47, true), '?' => (44, true),
        '~' => (50, true),
        _ => return None,
    })
}

fn keycode_for(key: &str) -> Option<u16> {
    Some(match key.to_lowercase().as_str() {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "period" | "." => 47,
        "comma" | "," => 43,
        "minus" | "dash" | "-" => 27,
        "equal" | "equals" | "=" => 24,
        "slash" | "/" => 44,
        "backslash" | "\\" => 42,
        "semicolon" | ";" => 41,
        "quote" | "'" => 39,
        "backtick" | "`" => 50,
        "bracketleft" | "[" => 33,
        "bracketright" | "]" => 30,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "forwarddelete" => 117,
        "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5, "z" => 6, "x" => 7,
        "c" => 8, "v" => 9, "b" => 11, "q" => 12, "w" => 13, "e" => 14, "r" => 15,
        "y" => 16, "t" => 17, "1" => 18, "2" => 19, "3" => 20, "4" => 21, "6" => 22,
        "5" => 23, "9" => 25, "7" => 26, "8" => 28, "0" => 29, "o" => 31, "u" => 32,
        "i" => 34, "p" => 35, "l" => 37, "j" => 38, "k" => 40, "n" => 45, "m" => 46,
        _ => return None,
    })
}

pub fn press_key(key: &str, modifiers: &[String], real_mouse: bool) -> Result<(), String> {
    require_accessibility()?;
    // Never let the agent quit apps or log the user out, whatever the model decides.
    let lower = key.to_lowercase();
    let has = |m: &str| modifiers.iter().any(|x| x == m);
    if (has("cmd") && lower == "q") || (has("cmd") && has("alt") && (lower == "escape" || lower == "esc")) {
        return Err("Quitting apps is blocked for safety. Ask the user to do it.".to_string());
    }

    let code = keycode_for(key)
        .or_else(|| {
            let mut it = key.chars();
            match (it.next(), it.next()) {
                (Some(c), None) => key_for_char(c).map(|(k, _)| k),
                _ => None,
            }
        })
        .ok_or_else(|| format!("Unsupported key: {key}"))?;
    let mut flags = CGEventFlags::empty();
    for m in modifiers {
        match m.as_str() {
            "cmd" => flags |= CGEventFlags::CGEventFlagCommand,
            "shift" => flags |= CGEventFlags::CGEventFlagShift,
            "alt" => flags |= CGEventFlags::CGEventFlagAlternate,
            "ctrl" => flags |= CGEventFlags::CGEventFlagControl,
            _ => {}
        }
    }
    let source = event_source()?;
    let pid = if real_mouse { None } else { target_pid() };
    for down in [true, false] {
        let ev = CGEvent::new_keyboard_event(source.clone(), code, down)
            .map_err(|_| "key event failed".to_string())?;
        ev.set_flags(flags);
        post(&ev, pid);
    }
    Ok(())
}

pub fn scroll(amount: i32, real_mouse: bool) -> Result<(), String> {
    require_accessibility()?;
    // Positive = down for the agent; the CoreGraphics wheel is the opposite.
    unsafe {
        let ev = CGEventCreateScrollWheelEvent(std::ptr::null(), 1 /* line */, 1, -amount);
        if ev.is_null() {
            return Err("scroll failed".to_string());
        }
        if real_mouse {
            CGEventPost(0 /* HID */, ev);
        } else if let Some(pid) = target_pid() {
            // Scroll where the agent last pointed: the middle of that app's front window.
            if let Some((_, x, y, w, h, _)) = visible_windows().into_iter().find(|(p, ..)| *p == pid) {
                CGEventSetLocation(ev, CGPoint::new(x + w / 2.0, y + h / 2.0));
            }
            CGEventPostToPid(pid, ev);
        } else {
            CGEventPost(0, ev);
        }
        CFRelease(ev);
    }
    Ok(())
}
