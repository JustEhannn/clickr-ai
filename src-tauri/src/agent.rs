// Agent Mode (Pro+): the model plans one tool call at a time on the server
// (`agent` Edge Function); this module executes those calls locally.
// Everything here is deliberately conservative: file tools are confined to the
// user's home directory, secrets folders are off limits, and the frontend asks
// for approval before any action that changes state.

use crate::auth;
use serde_json::{json, Value};
use std::path::{Component, PathBuf};
use tauri::{AppHandle, Emitter};

/// The agent looks at a sharper screenshot than normal chat so small targets are readable.
pub const AGENT_SCREEN_DIMENSION: u32 = 2000;
/// True once the agent has typed something since the last submit-style action.
/// Used to refuse "Submit" on an answer nobody entered.
static TYPED_SINCE_SUBMIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Buttons that submit an answer (as opposed to "Next", which needs no answer).
fn is_submit_label(role: &str, label: &str) -> bool {
    let l = label.to_lowercase();
    let button_like = matches!(role, "AXButton" | "AXLink" | "AXMenuItem" | "AXDefaultButton" | "AXInput");
    button_like
        && ["submit", "check", "answer", "done", "enter", "send", "grade", "finish", "ok"]
            .iter()
            .any(|w| l.split(|c: char| !c.is_alphanumeric()).any(|word| word == *w))
}

#[cfg(target_os = "macos")]
fn focus_note() -> String {
    crate::platform::frontmost_pid().map(crate::platform::ax::focus_summary).unwrap_or_default()
}
#[cfg(not(target_os = "macos"))]
fn focus_note() -> String {
    String::new()
}

const MAX_FILE_BYTES: usize = 200 * 1024;
const DENIED_COMPONENTS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".docker", "Library", "Keychains", ".Trash"];

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|h| h.canonicalize().ok())
        .ok_or_else(|| "Couldn't locate your home folder.".to_string())
}

/// Expands `~`, makes the path absolute, resolves symlinks on the part that
/// exists, and refuses anything outside $HOME or inside a secrets folder.
fn resolve(raw: &str) -> Result<PathBuf, String> {
    let home = home()?;
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else if raw == "~" {
        home.clone()
    } else {
        PathBuf::from(raw)
    };
    if !expanded.is_absolute() {
        return Err("Use an absolute path or one starting with ~/".to_string());
    }

    // Canonicalise the deepest existing ancestor, then re-append the rest.
    let mut existing = expanded.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(n) => tail.push(n.to_os_string()),
            None => return Err("Invalid path.".to_string()),
        }
        existing.pop();
    }
    let mut full = existing.canonicalize().map_err(|e| e.to_string())?;
    for part in tail.into_iter().rev() {
        if part == ".." {
            return Err("`..` isn't allowed in new paths.".to_string());
        }
        full.push(part);
    }

    let rel = full.strip_prefix(&home).map_err(|_| "Clickr can only touch files inside your home folder.".to_string())?;
    for c in rel.components() {
        if let Component::Normal(n) = c {
            if DENIED_COMPONENTS.iter().any(|d| n == std::ffi::OsStr::new(d)) {
                return Err("That location is protected.".to_string());
            }
        }
    }
    Ok(full)
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(|v| v.as_str()).ok_or_else(|| format!("Missing `{key}`."))
}

fn num_arg(args: &Value, key: &str) -> Result<f64, String> {
    args.get(key).and_then(|v| v.as_f64()).ok_or_else(|| format!("Missing `{key}`."))
}

#[tauri::command]
pub fn request_accessibility() -> bool {
    crate::platform::request_accessibility()
}

#[tauri::command]
pub fn check_accessibility() -> bool {
    crate::platform::accessibility_trusted()
}

/// True for tools that look at the screen afterwards (so the loop attaches a fresh screenshot).
fn is_screen_tool(name: &str) -> bool {
    matches!(name, "click" | "type_text" | "press_key" | "scroll" | "wait" | "open_url" | "open_app" | "press_element")
}

#[tauri::command]
pub fn agent_tool_needs_screen(name: String) -> bool {
    is_screen_tool(&name)
}

/// Executes one tool call and returns a short text result for the model.
#[tauri::command]
pub async fn agent_exec(app: AppHandle, name: String, args: Value, background: Option<bool>) -> Result<String, String> {
    // `background` = experimental "never touch my real mouse" mode; default is system input.
    let real = !background.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || exec_blocking(&app, &name, &args, real))
        .await
        .map_err(|e| format!("Action failed: {e}"))?
}

/// Tells the cursor overlay what the agent is doing so the user can watch it.
fn cursor_event(app: &AppHandle, kind: &str, x: f64, y: f64, label: &str) {
    let _ = app.emit("agent-cursor", json!({ "kind": kind, "x": x, "y": y, "label": label }));
}

fn exec_blocking(app: &AppHandle, name: &str, args: &Value, real: bool) -> Result<String, String> {
    use crate::platform;
    match name {
        "click" => {
            let x = num_arg(args, "x")?;
            let y = num_arg(args, "y")?;
            let right = args.get("button").and_then(|v| v.as_str()) == Some("right");
            let double = args.get("double").and_then(|v| v.as_bool()).unwrap_or(false);
            let (sx, sy) = platform::to_screen_point(x, y);
            let (ox, oy, _, _) = platform::main_display_bounds();

            // What is actually under that point? Refuse to hit Submit on an empty answer.
            #[cfg(target_os = "macos")]
            let under = platform::pid_at_point(sx, sy).and_then(|pid| platform::ax::element_at(pid, sx, sy));
            #[cfg(not(target_os = "macos"))]
            let under: Option<(String, String)> = None;
            if let Some((role, label)) = &under {
                if is_submit_label(role, label) && !TYPED_SINCE_SUBMIT.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(format!(
                        "Refused: that point is the \"{label}\" button, but nothing has been typed since the last submit. Enter the answer first (click the answer field, then type_text)."
                    ));
                }
                if is_submit_label(role, label) {
                    TYPED_SINCE_SUBMIT.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
            // Glide the on-screen agent cursor to the target first, then click.
            cursor_event(app, "move", sx - ox, sy - oy, "");
            std::thread::sleep(std::time::Duration::from_millis(380));
            cursor_event(app, "click", sx - ox, sy - oy, "");
            platform::mouse_click(x, y, right, double, real)?;
            std::thread::sleep(std::time::Duration::from_millis(250));
            let what = match &under {
                Some((role, label)) if !label.is_empty() => format!(" on {} \"{label}\"", role.trim_start_matches("AX").to_lowercase()),
                Some((role, _)) if !role.is_empty() => format!(" on a {}", role.trim_start_matches("AX").to_lowercase()),
                _ => String::new(),
            };
            Ok(format!("Clicked{what}. {}", focus_note()))
        }
        "type_text" => {
            let text = str_arg(args, "text")?;
            let preview: String = text.chars().take(24).collect();

            // Optionally focus a listed field first, in the same step.
            #[cfg(target_os = "macos")]
            if let Some(id) = args.get("into_id").and_then(|v| v.as_f64()) {
                platform::ax::press_element(id as usize)?;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }

            // Never type blind: something editable must have focus.
            #[cfg(target_os = "macos")]
            if let Some(pid) = platform::frontmost_pid() {
                if let Some(f) = platform::ax::focus_info(pid) {
                    if !f.editable {
                        return Err(format!(
                            "Nothing was typed: no text field is focused (focus is on {} \"{}\"). Click the answer field or press_element it first, check the result says it is focused, then type.",
                            f.role.trim_start_matches("AX").to_lowercase(),
                            f.label
                        ));
                    }
                }
            }

            cursor_event(app, "label", -1.0, -1.0, &format!("Typing “{preview}”"));
            platform::type_text(text, real)?;
            TYPED_SINCE_SUBMIT.store(true, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(180));
            // Read the field back so the model knows whether the text actually landed.
            #[cfg(target_os = "macos")]
            {
                if let Some(pid) = platform::frontmost_pid() {
                    return Ok(match platform::ax::focused_value(pid) {
                        Some(v) if !v.is_empty() => format!("Typed. The focused field now contains: \"{v}\""),
                        Some(_) => "Typed, but the focused field still looks empty — it may not have focus. Press_element on the field, then try again.".to_string(),
                        None => "Typed. (Couldn't read the field back; check the screenshot.)".to_string(),
                    });
                }
            }
            Ok("Typed.".to_string())
        }
        "press_key" => {
            let mods: Vec<String> = args
                .get("modifiers")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let key = str_arg(args, "key")?;

            // Return in an empty answer box would submit nothing (or the wrong thing).
            if matches!(key.to_lowercase().as_str(), "return" | "enter")
                && !TYPED_SINCE_SUBMIT.load(std::sync::atomic::Ordering::SeqCst)
            {
                #[cfg(target_os = "macos")]
                if let Some(f) = platform::frontmost_pid().and_then(platform::ax::focus_info) {
                    if f.editable && f.value.is_empty() {
                        return Err("Refused: the focused field is empty and nothing has been typed, so Return would submit nothing. Enter the answer first.".to_string());
                    }
                }
            }
            if matches!(key.to_lowercase().as_str(), "return" | "enter") {
                TYPED_SINCE_SUBMIT.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            cursor_event(app, "label", -1.0, -1.0, &format!("{}{}", mods.join("+") + if mods.is_empty() { "" } else { "+" }, key));
            platform::press_key(key, &mods, real)?;
            // Enter usually submits: give the page time to update before the next screenshot.
            let submits = matches!(key.to_lowercase().as_str(), "return" | "enter");
            std::thread::sleep(std::time::Duration::from_millis(if submits { 900 } else { 150 }));
            Ok("Key pressed.".to_string())
        }
        "scroll" => {
            let amount = num_arg(args, "amount")? as i32;
            cursor_event(app, "label", -1.0, -1.0, if amount >= 0 { "Scrolling down" } else { "Scrolling up" });
            platform::scroll(amount, real)?;
            std::thread::sleep(std::time::Duration::from_millis(150));
            Ok("Scrolled.".to_string())
        }
        "list_ui_elements" => {
            #[cfg(target_os = "macos")]
            {
                if !platform::accessibility_trusted() {
                    return Err("Accessibility permission is required.".to_string());
                }
                let pid = platform::frontmost_pid().ok_or("Couldn't find the frontmost app.")?;
                return Ok(platform::ax::list_elements(pid, platform::main_display_bounds()));
            }
            #[cfg(not(target_os = "macos"))]
            Err("Not available on this platform.".to_string())
        }
        "press_element" => {
            #[cfg(target_os = "macos")]
            {
                if !platform::accessibility_trusted() {
                    return Err("Accessibility permission is required.".to_string());
                }
                let id = num_arg(args, "id")? as usize;
                if let Some((role, label)) = platform::ax::element_info(id) {
                    if is_submit_label(&role, &label) {
                        if !TYPED_SINCE_SUBMIT.load(std::sync::atomic::Ordering::SeqCst) {
                            return Err(format!(
                                "Refused: \"{label}\" submits an answer, but nothing has been typed since the last submit. Enter the answer first."
                            ));
                        }
                        TYPED_SINCE_SUBMIT.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                }
                if let Some((gx, gy)) = platform::ax::element_center(id) {
                    let (ox, oy, _, _) = platform::main_display_bounds();
                    cursor_event(app, "move", gx - ox, gy - oy, "");
                    std::thread::sleep(std::time::Duration::from_millis(380));
                    cursor_event(app, "click", gx - ox, gy - oy, "");
                }
                let result = platform::ax::press_element(id)?;
                std::thread::sleep(std::time::Duration::from_millis(250));
                return Ok(format!("{result} {}", focus_note()));
            }
            #[cfg(not(target_os = "macos"))]
            Err("Not available on this platform.".to_string())
        }
        "wait" => {
            let secs = num_arg(args, "seconds")?.clamp(0.0, 10.0);
            std::thread::sleep(std::time::Duration::from_millis((secs * 1000.0) as u64));
            Ok(format!("Waited {secs} s."))
        }
        "open_url" => {
            let url = str_arg(args, "url")?;
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err("Only http(s) URLs can be opened.".to_string());
            }
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(1000));
            Ok(format!("Opened {url}"))
        }
        "open_app" => {
            let app = str_arg(args, "name")?;
            if app.starts_with('-') || app.contains('/') || app.len() > 80 {
                return Err("Invalid app name.".to_string());
            }
            let status = std::process::Command::new("open").arg("-a").arg(app).status().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(format!("Couldn't open {app}."));
            }
            std::thread::sleep(std::time::Duration::from_millis(800));
            Ok(format!("Opened {app}."))
        }
        "list_files" => {
            let dir = resolve(str_arg(args, "path")?)?;
            let mut out = Vec::new();
            for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.take(200) {
                let entry = entry.map_err(|e| e.to_string())?;
                let meta = entry.metadata().map_err(|e| e.to_string())?;
                let kind = if meta.is_dir() { "dir" } else { "file" };
                out.push(format!("{kind}\t{}\t{}", meta.len(), entry.file_name().to_string_lossy()));
            }
            Ok(if out.is_empty() { "(empty)".to_string() } else { out.join("\n") })
        }
        "read_file" => {
            let path = resolve(str_arg(args, "path")?)?;
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.len() as usize > MAX_FILE_BYTES {
                return Err("File is larger than 200 KB.".to_string());
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            String::from_utf8(bytes).map_err(|_| "That isn't a text file.".to_string())
        }
        "write_file" => {
            let path = resolve(str_arg(args, "path")?)?;
            let content = str_arg(args, "content")?;
            if content.len() > MAX_FILE_BYTES {
                return Err("Content is larger than 200 KB.".to_string());
            }
            std::fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(format!("Wrote {} bytes to {}", content.len(), path.display()))
        }
        "make_dir" => {
            let path = resolve(str_arg(args, "path")?)?;
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            Ok(format!("Created {}", path.display()))
        }
        "move_file" => {
            let from = resolve(str_arg(args, "from")?)?;
            let to = resolve(str_arg(args, "to")?)?;
            if to.exists() {
                return Err("Destination already exists.".to_string());
            }
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
            Ok(format!("Moved to {}", to.display()))
        }
        "trash_file" => {
            let path = resolve(str_arg(args, "path")?)?;
            let status = std::process::Command::new("osascript")
                .args([
                    "-e", "on run argv",
                    "-e", "tell application \"Finder\" to delete (POSIX file (item 1 of argv))",
                    "-e", "end run",
                ])
                .arg(&path)
                .status()
                .map_err(|e| e.to_string())?;
            if status.success() { Ok(format!("Moved {} to the Trash.", path.display())) } else { Err("Couldn't move it to the Trash.".to_string()) }
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

async fn call_agent(token: &str, body: &Value) -> Result<(u16, Value), String> {
    let res = reqwest::Client::new()
        .post(format!("{}/functions/v1/agent", auth::SUPABASE_URL))
        .header("apikey", auth::SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .json(body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|_| "Clickr couldn't reach the server. Check your connection.".to_string())?;
    let status = res.status().as_u16();
    let val: Value = res.json().await.unwrap_or(Value::Null);
    Ok((status, val))
}

/// One planning step. Returns `{type:"call",name,args,note?}` or `{type:"final",answer}`.
#[tauri::command]
pub async fn agent_step(
    app: AppHandle,
    goal: String,
    context: Option<String>,
    history: Vec<Value>,
    screenshot_base64: Option<String>,
    reasoning: Option<bool>,
) -> Result<Value, String> {
    let mut token = auth::get_access_token(&app).await.map_err(|_| "Sign in to use Agent Mode.".to_string())?;

    let screenshot = match screenshot_base64 {
        Some(s) => {
            let (mime, data) = crate::prepare_image_for_upload_max(&s, AGENT_SCREEN_DIMENSION)?;
            Some(json!({ "mime": mime, "data": data }))
        }
        None => None,
    };

    let mut body = json!({
        "goal": goal,
        "context": context.unwrap_or_default(),
        "history": history,
        "reasoning": reasoning.unwrap_or(false),
    });
    if let Some(s) = screenshot {
        body["screenshot"] = s;
    }

    let (mut status, mut val) = call_agent(&token, &body).await?;
    if status == 401 {
        token = auth::force_refresh(&app).await.map_err(|_| "Please sign in again.".to_string())?;
        (status, val) = call_agent(&token, &body).await?;
    }

    match status {
        200 => Ok(val),
        403 => Err(if val.get("error").and_then(|e| e.as_str()) == Some("agent_not_available") {
            "agent_not_available".to_string()
        } else {
            "plan_required".to_string()
        }),
        429 => Err("limit_reached".to_string()),
        _ => Err(val
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("The agent hit a snag. Please try again.")
            .to_string()),
    }
}


static CURSOR_WANTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Shows the transparent, click-through overlay that draws the agent's cursor.
#[tauri::command]
pub fn agent_cursor_show(app: AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    CURSOR_WANTED.store(true, std::sync::atomic::Ordering::SeqCst);
    TYPED_SINCE_SUBMIT.store(false, std::sync::atomic::Ordering::SeqCst);
    if app.get_webview_window("cursor").is_some() {
        return Ok(());
    }
    let (x, y, w, h) = crate::platform::main_display_bounds();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        // If the run already ended before this ran, don't create a window nobody will close.
        if !CURSOR_WANTED.load(std::sync::atomic::Ordering::SeqCst) || handle.get_webview_window("cursor").is_some() {
            return;
        }
        let built = WebviewWindowBuilder::new(&handle, "cursor", WebviewUrl::App("index.html?window=cursor".into()))
            .title("Clickr Cursor")
            .position(x, y)
            .inner_size(w, h)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .focused(false)
            .build();
        match built {
            Ok(window) => {
                let _ = window.set_ignore_cursor_events(true);
                #[cfg(target_os = "macos")]
                crate::platform::disable_window_shadow(&window);
            }
            Err(e) => eprintln!("Failed to build cursor window: {e}"),
        }
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_cursor_hide(app: AppHandle) {
    use tauri::Manager;
    CURSOR_WANTED.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("cursor") {
        let _ = window.close();
    }
}
