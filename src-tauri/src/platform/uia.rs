// UI Automation (Windows' accessibility tree) for Agent Mode. Same API as the macOS ax.rs:
// list the clickable controls of the app the user is working in, press one by id, read the
// focused field. Roles are reported with the same "AX…" names the shared agent code expects.

use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::core::BOOL;
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;

use super::windows::{all_top_level_windows, is_visible_uncloaked, main_display_bounds_physical, primary_scale, target_window, window_pid};

struct Held {
    el: IUIAutomationElement,
    role: &'static str,
    label: String,
    /// Logical points, like platform::to_screen_point.
    center: (f64, f64),
}
// UIA objects are free-threaded once the thread is in the MTA, which every thread here is.
unsafe impl Send for Held {}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());

thread_local! {
    static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn automation() -> Option<IUIAutomation> {
    COM_READY.with(|ready| {
        if !ready.get() {
            // Ok(S_FALSE) / RPC_E_CHANGED_MODE are both fine: COM is usable either way.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            ready.set(true);
        }
    });
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok() }
}

fn role_of(control_type: i32) -> &'static str {
    match control_type {
        50000 => "AXButton",
        50002 => "AXCheckBox",
        50003 => "AXComboBox",
        50004 => "AXTextField",
        50005 => "AXLink",
        50007 | 50029 => "AXListItem",
        50011 => "AXMenuItem",
        50013 => "AXRadioButton",
        50015 => "AXSlider",
        50016 => "AXTextField", // spinner
        50019 => "AXTab",
        50024 => "AXTreeItem",
        50030 => "AXTextArea", // document
        50031 => "AXPopUpButton",
        _ => "AXGroup",
    }
}

/// Controls worth listing: things a person would click or type into.
const LISTED_TYPES: &[i32] = &[50000, 50002, 50003, 50004, 50005, 50007, 50011, 50013, 50015, 50016, 50019, 50024, 50029, 50031];

fn is_text_role(role: &str) -> bool {
    matches!(role, "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField")
}

fn short_role(role: &str) -> &str {
    role.strip_prefix("AX").unwrap_or(role)
}

fn bstr(s: windows::core::Result<windows::core::BSTR>) -> String {
    s.map(|b| b.to_string()).unwrap_or_default()
}

fn label_of(el: &IUIAutomationElement) -> String {
    let name = bstr(unsafe { el.CurrentName() });
    let label = if !name.trim().is_empty() {
        name
    } else {
        let help = bstr(unsafe { el.CurrentHelpText() });
        if !help.trim().is_empty() { help } else { bstr(unsafe { el.CurrentAutomationId() }) }
    };
    label.replace(['\r', '\n'], " ").trim().chars().take(70).collect()
}

fn invoke_like(el: &IUIAutomationElement, role: &str) -> Result<String, String> {
    unsafe {
        if is_text_role(role) {
            return el.SetFocus().map(|_| "Focused the field.".to_string()).map_err(|_| "Couldn't focus that field.".to_string());
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            if p.Invoke().is_ok() {
                return Ok("Pressed.".to_string());
            }
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            if p.Toggle().is_ok() {
                return Ok("Toggled.".to_string());
            }
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            if p.Select().is_ok() {
                return Ok("Selected.".to_string());
            }
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            if p.Expand().is_ok() {
                return Ok("Expanded.".to_string());
            }
        }
    }
    Err("That element didn't accept a press. Try clicking its coordinates instead.".to_string())
}

/// Lists the interactive elements of `pid`'s visible windows, in reading order, each with an id
/// for `press_element` and a position on the agent's 0-1000 grid.
pub fn list_elements(pid: i32, _display: (f64, f64, f64, f64)) -> String {
    let Some(uia) = automation() else {
        return "Couldn't read that app's interface.".to_string();
    };
    let (pw, ph) = main_display_bounds_physical();
    let scale = primary_scale();
    let started = Instant::now();

    // Windows of that app: the main window plus any popups/dialogs/menus it has open.
    let mut roots = Vec::new();
    if let Some(t) = target_window() {
        if window_pid(t) as i32 == pid {
            roots.push(t);
        }
    }
    for h in all_top_level_windows() {
        if window_pid(h) as i32 == pid && is_visible_uncloaked(h) && !roots.contains(&h) && roots.len() < 6 {
            roots.push(h);
        }
    }

    let condition = unsafe {
        let any_type: windows::core::Result<IUIAutomationCondition> = LISTED_TYPES
            .iter()
            .filter_map(|t| uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(*t)).ok())
            .reduce(|a, b| uia.CreateOrCondition(&a, &b).unwrap_or(a))
            .ok_or_else(|| windows::core::Error::from_hresult(windows::core::HRESULT(-1)));
        let onscreen = uia.CreatePropertyCondition(UIA_IsOffscreenPropertyId, &VARIANT::from(false));
        match (any_type, onscreen) {
            (Ok(a), Ok(b)) => uia.CreateAndCondition(&a, &b).ok(),
            _ => None,
        }
    };
    let (Some(condition), Some(cache)) = (condition, unsafe { uia.CreateCacheRequest().ok() }) else {
        return "Couldn't read that app's interface.".to_string();
    };
    unsafe {
        let _ = cache.AddProperty(UIA_NamePropertyId);
        let _ = cache.AddProperty(UIA_ControlTypePropertyId);
        let _ = cache.AddProperty(UIA_BoundingRectanglePropertyId);
    }

    // (element, role, label, cx_physical, cy_physical)
    let mut found: Vec<(IUIAutomationElement, &'static str, String, f64, f64)> = Vec::new();
    for root in roots {
        if found.len() >= 250 || started.elapsed() > Duration::from_millis(3500) {
            break;
        }
        unsafe {
            let Ok(root_el) = uia.ElementFromHandle(windows::Win32::Foundation::HWND(root.0)) else { continue };
            let Ok(all) = root_el.FindAllBuildCache(TreeScope_Descendants, &condition, &cache) else { continue };
            let n = all.Length().unwrap_or(0);
            for i in 0..n {
                if found.len() >= 250 {
                    break;
                }
                let Ok(el) = all.GetElement(i) else { continue };
                let rect = el.CachedBoundingRectangle().unwrap_or_default();
                let (w, h) = ((rect.right - rect.left) as f64, (rect.bottom - rect.top) as f64);
                let (cx, cy) = (rect.left as f64 + w / 2.0, rect.top as f64 + h / 2.0);
                if w <= 1.0 || h <= 1.0 || cx < 0.0 || cy < 0.0 || cx > pw || cy > ph {
                    continue;
                }
                let role = role_of(el.CachedControlType().map(|c| c.0).unwrap_or(0));
                let mut label: String = bstr(el.CachedName()).replace(['\r', '\n'], " ").trim().chars().take(70).collect();
                if label.is_empty() {
                    label = label_of(&el);
                }
                found.push((el, role, label, cx, cy));
            }
        }
    }

    // Reading order (rows of ~14 points, then left to right) so "3rd tab" is countable.
    let mut order: Vec<usize> = (0..found.len()).collect();
    order.sort_by(|a, b| {
        let (ra, rb) = ((found[*a].4 / scale / 14.0).round(), (found[*b].4 / scale / 14.0).round());
        ra.partial_cmp(&rb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(found[*a].3.partial_cmp(&found[*b].3).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut held = Vec::with_capacity(found.len());
    let mut lines = Vec::new();
    for (new_id, old) in order.into_iter().enumerate() {
        let (el, role, label, cx, cy) = &found[old];
        let gx = (cx / pw * 1000.0).round();
        let gy = (cy / ph * 1000.0).round();
        let name = if label.is_empty() { "(no label)".to_string() } else { format!("\"{label}\"") };
        lines.push(format!("[{new_id}] {} {name} at x={gx}, y={gy}", short_role(role)));
        held.push(Held { el: el.clone(), role, label: label.clone(), center: (cx / scale, cy / scale) });
    }
    *HELD.lock().unwrap() = held;

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

/// Screen point (logical) of a listed element, for the cursor overlay.
pub fn element_center(id: usize) -> Option<(f64, f64)> {
    HELD.lock().unwrap().get(id).map(|h| h.center)
}

/// Presses (or focuses, for text fields) a listed element. No mouse involved.
pub fn press_element(id: usize) -> Result<String, String> {
    let _ = automation(); // makes sure COM is initialised on this thread
    let held = HELD.lock().unwrap();
    let h = held.get(id).ok_or("Unknown element id — call list_ui_elements again first.")?;
    invoke_like(&h.el, h.role)
}

/// Role and label of a listed element (for safety checks before pressing it).
pub fn element_info(id: usize) -> Option<(String, String)> {
    HELD.lock().unwrap().get(id).map(|h| (h.role.to_string(), h.label.clone()))
}

/// The control under a screen point (logical points): (role, label).
pub fn element_at(_pid: i32, x: f64, y: f64) -> Option<(String, String)> {
    let uia = automation()?;
    let s = primary_scale();
    let el = unsafe { uia.ElementFromPoint(POINT { x: (x * s) as i32, y: (y * s) as i32 }).ok()? };
    let role = role_of(unsafe { el.CurrentControlType() }.map(|c| c.0).unwrap_or(0));
    Some((role.to_string(), label_of(&el)))
}

pub struct Focus {
    pub role: String,
    pub label: String,
    pub value: String,
    pub editable: bool,
}

fn value_of(el: &IUIAutomationElement) -> (String, Option<bool>) {
    unsafe {
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            let v = bstr(p.CurrentValue());
            let read_only = p.CurrentIsReadOnly().map(|b: BOOL| b.as_bool()).ok();
            return (v, read_only);
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            if let Ok(range) = p.DocumentRange() {
                return (bstr(range.GetText(160)), None);
            }
        }
    }
    (String::new(), None)
}

/// What has keyboard focus in `pid`'s app, and whether it takes typed text.
pub fn focus_info(pid: i32) -> Option<Focus> {
    let uia = automation()?;
    let el = unsafe { uia.GetFocusedElement().ok()? };
    if unsafe { el.CurrentProcessId() }.unwrap_or(0) != pid {
        return None;
    }
    let ct = unsafe { el.CurrentControlType() }.map(|c| c.0).unwrap_or(0);
    let role = role_of(ct);
    let (value, read_only) = value_of(&el);
    let editable = match read_only {
        Some(ro) => !ro && (is_text_role(role) || ct == 50030 || ct == 50025 || ct == 50026),
        None => is_text_role(role),
    };
    Some(Focus {
        role: role.to_string(),
        label: label_of(&el),
        value: value.chars().take(160).collect(),
        editable,
    })
}

/// The text in the focused field, so the agent can confirm typing worked.
pub fn focused_value(pid: i32) -> Option<String> {
    let uia = automation()?;
    let el = unsafe { uia.GetFocusedElement().ok()? };
    if unsafe { el.CurrentProcessId() }.unwrap_or(0) != pid {
        return None;
    }
    Some(value_of(&el).0.chars().take(160).collect())
}

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
            short_role(&f.role).to_lowercase(),
            f.label
        ),
        None => "Focus unknown (could not read it).".to_string(),
    }
}
