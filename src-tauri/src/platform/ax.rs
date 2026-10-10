// macOS Accessibility (AX) access for Agent Mode: lists the real buttons, tabs,
// menus and fields of the frontmost app by name, and presses them directly.
// This is far more reliable than the model guessing pixel coordinates.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::geometry::{CGPoint, CGSize};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};

type AXUIElementRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(el: AXUIElementRef, attr: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(el: AXUIElementRef, attr: CFStringRef, value: CFTypeRef) -> i32;
    fn AXUIElementPerformAction(el: AXUIElementRef, action: CFStringRef) -> i32;
    fn AXUIElementSetMessagingTimeout(el: AXUIElementRef, timeout: f32) -> i32;
    fn AXUIElementIsAttributeSettable(el: AXUIElementRef, attr: CFStringRef, settable: *mut u8) -> i32;
    fn AXUIElementCopyElementAtPosition(app: AXUIElementRef, x: f32, y: f32, out: *mut CFTypeRef) -> i32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
}

const AX_POINT: u32 = 1;
const AX_SIZE: u32 = 2;

struct Held {
    el: CFType,
    role: String,
    label: String,
    center: (f64, f64),
}
// The AX elements are only touched while holding the mutex.
unsafe impl Send for Held {}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());

fn attr(el: &CFType, name: &'static str) -> Option<CFType> {
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            el.as_CFTypeRef() as AXUIElementRef,
            CFString::from_static_string(name).as_concrete_TypeRef(),
            &mut out,
        )
    };
    if err != 0 || out.is_null() {
        None
    } else {
        Some(unsafe { CFType::wrap_under_create_rule(out) })
    }
}

fn string_attr(el: &CFType, name: &'static str) -> Option<String> {
    attr(el, name)?.downcast::<CFString>().map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}

fn frame_of(el: &CFType) -> Option<(CGPoint, CGSize)> {
    let pos = attr(el, "AXPosition")?;
    let size = attr(el, "AXSize")?;
    let mut p = CGPoint::new(0.0, 0.0);
    let mut s = CGSize::new(0.0, 0.0);
    unsafe {
        if !AXValueGetValue(pos.as_CFTypeRef(), AX_POINT, &mut p as *mut _ as *mut c_void) {
            return None;
        }
        if !AXValueGetValue(size.as_CFTypeRef(), AX_SIZE, &mut s as *mut _ as *mut c_void) {
            return None;
        }
    }
    Some((p, s))
}

fn interactive(role: &str) -> bool {
    matches!(
        role,
        "AXButton" | "AXRadioButton" | "AXCheckBox" | "AXPopUpButton" | "AXMenuButton" | "AXMenuItem"
            | "AXMenuBarItem" | "AXLink" | "AXTextField" | "AXTextArea" | "AXComboBox" | "AXTab"
            | "AXSlider" | "AXDisclosureTriangle" | "AXSearchField"
    )
}

fn short_role(role: &str) -> &str {
    role.strip_prefix("AX").unwrap_or(role)
}

/// Lists the interactive elements of `pid`'s windows and menu bar, in reading
/// order, each with an id for `press_element` and a position on the agent's
/// 0-1000 grid. Returns plain text for the model.
pub fn list_elements(pid: i32, display: (f64, f64, f64, f64)) -> String {
    let (dx, dy, dw, dh) = display;
    // Keystrokes that follow should go to the app being inspected.
    crate::platform::set_target_pid(pid);
    let app_raw = unsafe { AXUIElementCreateApplication(pid) };
    if app_raw.is_null() {
        return "Couldn't read that app's interface.".to_string();
    }
    let app = unsafe { CFType::wrap_under_create_rule(app_raw as CFTypeRef) };
    unsafe { AXUIElementSetMessagingTimeout(app_raw, 1.0) };

    // Chromium/Electron apps only build their accessibility tree on request.
    let yes = CFBoolean::true_value();
    for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        unsafe {
            AXUIElementSetAttributeValue(
                app_raw,
                CFString::from_static_string(name).as_concrete_TypeRef(),
                yes.as_CFTypeRef(),
            );
        }
    }

    let mut queue: VecDeque<(CFType, u32)> = VecDeque::new();
    if let Some(windows) = attr(&app, "AXWindows").and_then(|w| w.downcast::<CFArray>()) {
        for w in windows.iter() {
            queue.push_back((unsafe { CFType::wrap_under_get_rule(*w as CFTypeRef) }, 0));
        }
    }
    if let Some(menu) = attr(&app, "AXMenuBar") {
        queue.push_back((menu, 0));
    }

    let started = Instant::now();
    let mut visited = 0;
    let mut found: Vec<(String, String, f64, f64)> = Vec::new(); // role, label, cx, cy (points)
    let mut held: Vec<Held> = Vec::new();

    while let Some((el, depth)) = queue.pop_front() {
        if visited > 1200 || found.len() >= 250 || started.elapsed() > Duration::from_millis(2500) {
            break;
        }
        visited += 1;

        let role = string_attr(&el, "AXRole").unwrap_or_default();
        if interactive(&role) {
            if let Some((p, s)) = frame_of(&el) {
                let (cx, cy) = (p.x + s.width / 2.0, p.y + s.height / 2.0);
                if s.width > 1.0 && s.height > 1.0 && cx >= dx && cx <= dx + dw && cy >= dy && cy <= dy + dh {
                    let label = string_attr(&el, "AXTitle")
                        .or_else(|| string_attr(&el, "AXDescription"))
                        .or_else(|| string_attr(&el, "AXValue"))
                        .or_else(|| string_attr(&el, "AXHelp"))
                        .or_else(|| string_attr(&el, "AXPlaceholderValue"))
                        .unwrap_or_default();
                    found.push((role.clone(), label.chars().take(70).collect(), cx, cy));
                    held.push(Held { el: el.clone(), role: role.clone(), label: label.chars().take(70).collect(), center: (cx, cy) });
                }
            }
        }

        if depth < 14 {
            if let Some(children) = attr(&el, "AXChildren").and_then(|c| c.downcast::<CFArray>()) {
                for c in children.iter() {
                    queue.push_back((unsafe { CFType::wrap_under_get_rule(*c as CFTypeRef) }, depth + 1));
                }
            }
        }
    }

    // Reading order (top to bottom in rows of ~14px, then left to right) so "3rd tab" is countable.
    let mut order: Vec<usize> = (0..found.len()).collect();
    order.sort_by(|a, b| {
        let (ra, rb) = ((found[*a].3 / 14.0).round(), (found[*b].3 / 14.0).round());
        ra.partial_cmp(&rb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(found[*a].2.partial_cmp(&found[*b].2).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut sorted_held = Vec::with_capacity(held.len());
    let mut lines = Vec::new();
    for (new_id, old) in order.into_iter().enumerate() {
        let (role, label, cx, cy) = &found[old];
        let gx = ((cx - dx) / dw * 1000.0).round();
        let gy = ((cy - dy) / dh * 1000.0).round();
        let name = if label.is_empty() { "(no label)".to_string() } else { format!("\"{label}\"") };
        lines.push(format!("[{new_id}] {} {name} at x={gx}, y={gy}", short_role(role)));
        sorted_held.push(Held {
            el: held[old].el.clone(),
            role: held[old].role.clone(),
            label: held[old].label.clone(),
            center: held[old].center,
        });
    }
    *HELD.lock().unwrap() = sorted_held;

    if lines.is_empty() {
        "No labelled controls found in the frontmost app. Use screenshot coordinates instead.".to_string()
    } else {
        format!(
            "{} interactive elements in reading order (left to right, top to bottom). Use press_element with the [id]:\n{}",
            lines.len(),
            lines.join("\n")
        )
    }
}

/// Global screen point (x, y) of a listed element, for the cursor overlay.
pub fn element_center(id: usize) -> Option<(f64, f64)> {
    HELD.lock().unwrap().get(id).map(|h| h.center)
}

/// Presses (or focuses, for text fields) a listed element. No mouse involved.
pub fn press_element(id: usize) -> Result<String, String> {
    let held = HELD.lock().unwrap();
    let h = held.get(id).ok_or("Unknown element id — call list_ui_elements again first.")?;
    let raw = h.el.as_CFTypeRef() as AXUIElementRef;

    if matches!(h.role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField") {
        let ok = unsafe {
            AXUIElementSetAttributeValue(
                raw,
                CFString::from_static_string("AXFocused").as_concrete_TypeRef(),
                CFBoolean::true_value().as_CFTypeRef(),
            )
        };
        return if ok == 0 { Ok("Focused the field.".to_string()) } else { Err("Couldn't focus that field.".to_string()) };
    }

    let err = unsafe { AXUIElementPerformAction(raw, CFString::from_static_string("AXPress").as_concrete_TypeRef()) };
    if err == 0 {
        Ok("Pressed.".to_string())
    } else {
        Err(format!("That element didn't accept a press (AX error {err}). Try clicking its coordinates instead."))
    }
}

/// The text currently in the focused field of `pid`, so the agent can confirm typing worked.
pub fn focused_value(pid: i32) -> Option<String> {
    let app_raw = unsafe { AXUIElementCreateApplication(pid) };
    if app_raw.is_null() {
        return None;
    }
    let app = unsafe { CFType::wrap_under_create_rule(app_raw as CFTypeRef) };
    unsafe { AXUIElementSetMessagingTimeout(app_raw, 0.6) };
    unsafe {
        AXUIElementSetAttributeValue(
            app_raw,
            CFString::from_static_string("AXManualAccessibility").as_concrete_TypeRef(),
            CFBoolean::true_value().as_CFTypeRef(),
        );
    }
    let focused = attr(&app, "AXFocusedUIElement")?;
    let value = string_attr(&focused, "AXValue").unwrap_or_default();
    Some(value.chars().take(160).collect())
}

/// Role and label of a listed element (for safety checks before pressing it).
pub fn element_info(id: usize) -> Option<(String, String)> {
    HELD.lock().unwrap().get(id).map(|h| (h.role.clone(), h.label.clone()))
}

fn label_of(el: &CFType) -> String {
    string_attr(el, "AXTitle")
        .or_else(|| string_attr(el, "AXDescription"))
        .or_else(|| string_attr(el, "AXPlaceholderValue"))
        .or_else(|| string_attr(el, "AXHelp"))
        .unwrap_or_default()
        .chars()
        .take(70)
        .collect()
}

/// The control under a screen point: (role, label).
pub fn element_at(pid: i32, x: f64, y: f64) -> Option<(String, String)> {
    let app_raw = unsafe { AXUIElementCreateApplication(pid) };
    if app_raw.is_null() {
        return None;
    }
    let _app = unsafe { CFType::wrap_under_create_rule(app_raw as CFTypeRef) };
    unsafe { AXUIElementSetMessagingTimeout(app_raw, 0.6) };
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(app_raw, x as f32, y as f32, &mut out) };
    if err != 0 || out.is_null() {
        return None;
    }
    let el = unsafe { CFType::wrap_under_create_rule(out) };
    Some((string_attr(&el, "AXRole").unwrap_or_default(), label_of(&el)))
}

pub struct Focus {
    pub role: String,
    pub label: String,
    pub value: String,
    pub editable: bool,
}

/// What currently has keyboard focus in `pid`, and whether text can be typed into it.
pub fn focus_info(pid: i32) -> Option<Focus> {
    let app_raw = unsafe { AXUIElementCreateApplication(pid) };
    if app_raw.is_null() {
        return None;
    }
    let app = unsafe { CFType::wrap_under_create_rule(app_raw as CFTypeRef) };
    unsafe { AXUIElementSetMessagingTimeout(app_raw, 0.6) };
    unsafe {
        AXUIElementSetAttributeValue(
            app_raw,
            CFString::from_static_string("AXManualAccessibility").as_concrete_TypeRef(),
            CFBoolean::true_value().as_CFTypeRef(),
        );
    }
    let focused = attr(&app, "AXFocusedUIElement")?;
    let mut settable: u8 = 0;
    unsafe {
        AXUIElementIsAttributeSettable(
            focused.as_CFTypeRef() as AXUIElementRef,
            CFString::from_static_string("AXValue").as_concrete_TypeRef(),
            &mut settable,
        );
    }
    let role = string_attr(&focused, "AXRole").unwrap_or_default();
    let editable = settable != 0
        || matches!(role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField");
    Some(Focus {
        role,
        label: label_of(&focused),
        value: string_attr(&focused, "AXValue").unwrap_or_default().chars().take(160).collect(),
        editable,
    })
}

/// One-line description of the focus, appended to click / press results so the
/// model works from facts instead of assumptions.
pub fn focus_summary(pid: i32) -> String {
    match focus_info(pid) {
        Some(f) if f.editable => {
            let name = if f.label.is_empty() { String::new() } else { format!(" \"{}\"", f.label) };
            if f.value.is_empty() {
                format!("Focused: editable field{name}, currently empty.")
            } else {
                format!("Focused: editable field{name}, currently containing \"{}\".", f.value)
            }
        }
        Some(f) => format!(
            "Nothing editable is focused (focus is on {} \"{}\"). To type, click or press_element the answer field first.",
            f.role.trim_start_matches("AX").to_lowercase(),
            f.label
        ),
        None => "Focus unknown (could not read it).".to_string(),
    }
}
