// src-tauri/src/cli.rs
// Optional: answer with the user's own Claude or ChatGPT subscription by running the official `claude` /
// `codex` command-line programs they already installed and logged in to. Clickr never sees a password
// or key; it only runs the program (without API-key variables, so the subscription is what gets used)
// and reads its answer. The screen and questions go to Anthropic / OpenAI for these models.
//
// Claude is tested. Codex follows the codex CLI's documented flags and is NOT tested yet.

use crate::engine::AskError;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Claude,
    Codex,
}

impl Kind {
    /// "claude:opus" -> (Claude, "opus"); anything else is a local model.
    pub fn parse(tag: &str) -> Option<(Kind, String)> {
        let (k, m) = tag.split_once(':')?;
        match k {
            "claude" => Some((Kind::Claude, m.to_string())),
            "codex" => Some((Kind::Codex, m.to_string())),
            _ => None,
        }
    }
    fn program(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Codex => "codex",
        }
    }
}

/// GUI apps don't get the shell's PATH, so look in the usual places, then ask a login shell.
fn find_cli(name: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(String::from).into_iter().chain(
        [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", "bin"].map(|d| format!("{home}/{d}")),
    );
    for d in dirs {
        let p = PathBuf::from(d).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    let out = Command::new("/bin/zsh").args(["-lc", &format!("command -v {name}")]).output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().to_string();
    (!path.is_empty() && PathBuf::from(&path).is_file()).then(|| PathBuf::from(path))
}

/// A command that uses the subscription login, not an API key that might be set on this Mac.
fn command(bin: &PathBuf, app: &AppHandle) -> Command {
    let mut c = Command::new(bin);
    for k in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"] {
        c.env_remove(k);
    }
    // Run in an empty folder so no project files or settings are picked up.
    let cwd = app.path().app_data_dir().map(|d| d.join("cli-cwd")).unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&cwd);
    c.current_dir(cwd).stdin(Stdio::null());
    c
}

/// Installed / logged in, for the setup screen. Cached briefly because it starts programs.
pub fn status(app: &AppHandle) -> Value {
    static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
    if let Some((at, v)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(20) {
            return v.clone();
        }
    }
    let one = |kind: Kind| -> Value {
        let Some(bin) = find_cli(kind.program()) else { return json!({ "installed": false, "loggedIn": false }) };
        let logged_in = match kind {
            Kind::Claude => command(&bin, app)
                .args(["auth", "status"])
                .output()
                .ok()
                .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
                .and_then(|v| v["loggedIn"].as_bool())
                .unwrap_or(false),
            Kind::Codex => command(&bin, app).args(["login", "status"]).output().map(|o| o.status.success()).unwrap_or(false),
        };
        json!({ "installed": true, "loggedIn": logged_in })
    };
    let v = json!({ "claude": one(Kind::Claude), "codex": one(Kind::Codex) });
    *CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    v
}

pub fn ready(app: &AppHandle, kind: Kind) -> Option<String> {
    let s = status(app);
    let s = &s[kind.program()];
    if s["installed"] != true {
        return Some(format!("{} isn't installed on this Mac.", if kind == Kind::Claude { "Claude Code" } else { "Codex" }));
    }
    if s["loggedIn"] != true {
        return Some(format!("Log in first: run `{} {}` in Terminal.", kind.program(), if kind == Kind::Claude { "auth login" } else { "login" }));
    }
    None
}

struct Flat {
    system: String,
    prompt: String,
    images: Vec<(String, String)>, // (mime, base64)
}

/// OpenAI-style messages -> one system prompt, one text transcript and the images.
fn flatten(messages: &Value) -> Flat {
    let mut system = String::new();
    let mut lines: Vec<String> = Vec::new();
    let mut images = Vec::new();
    let mut user_turns = 0;
    for m in messages.as_array().into_iter().flatten() {
        match m["role"].as_str().unwrap_or("") {
            "system" => system = m["content"].as_str().unwrap_or("").to_string(),
            "user" => {
                user_turns += 1;
                let mut text = String::new();
                match &m["content"] {
                    Value::String(s) => text = s.clone(),
                    Value::Array(parts) => {
                        for p in parts {
                            if let Some(t) = p["text"].as_str() {
                                text.push_str(t);
                            } else if let Some(u) = p["image_url"]["url"].as_str() {
                                if let Some((mime, data)) = u.strip_prefix("data:").and_then(|r| r.split_once(";base64,")) {
                                    images.push((mime.to_string(), data.to_string()));
                                }
                            }
                        }
                    }
                    _ => {}
                }
                lines.push(text);
            }
            "assistant" => {
                if let Some(t) = m["content"].as_str().filter(|t| !t.is_empty()) {
                    lines.push(format!("(You said) {t}"));
                }
                for c in m["tool_calls"].as_array().into_iter().flatten() {
                    lines.push(format!("(You called) {}({})", c["function"]["name"].as_str().unwrap_or(""), c["function"]["arguments"].as_str().unwrap_or("{}")));
                }
            }
            "tool" => lines.push(format!("(Result) {}", m["content"].as_str().unwrap_or(""))),
            _ => {}
        }
    }
    let _ = user_turns;
    if images.len() > 2 {
        images.drain(..images.len() - 2); // only the newest screens matter
    }
    Flat { system, prompt: lines.join("\n\n"), images }
}

/// Describes the tools in words and as a JSON schema the program must answer with.
fn tool_instructions(tools: &Value) -> (String, Value) {
    let mut names = Vec::new();
    let mut desc = String::from("\n\nYou act by choosing tools. Reply ONLY with a JSON object: `calls` is the list of tool calls to run now (at most 4, empty when the goal is done), `note` is one short sentence about what you see and do, and `final` is the short summary, used ONLY when the whole goal is finished or truly impossible. Never put a progress update or a request to continue in `final`: if there is more to do, return the next `calls`. The tools always work; if a result is an error or says skipped, look at the screen and try again. Tools:\n");
    for t in tools.as_array().into_iter().flatten() {
        let f = &t["function"];
        let name = f["name"].as_str().unwrap_or("");
        names.push(json!(name));
        desc.push_str(&format!("- {name}: {} Arguments: {}\n", f["description"].as_str().unwrap_or(""), f["parameters"]["properties"]));
    }
    let schema = json!({
        "type": "object",
        "properties": {
            "note": { "type": "string" },
            "calls": { "type": "array", "maxItems": 4, "items": { "type": "object",
                "properties": { "name": { "type": "string", "enum": names }, "args": { "type": "object" } },
                "required": ["name", "args"] } },
            "final": { "type": "string" },
        },
        "required": ["calls"],
    });
    (desc, schema)
}

/// The reply in the engine's shape: `{ content, tool_calls: [{ function: { name, arguments } }] }`.
fn to_reply(structured: Option<Value>, text: String) -> Value {
    let Some(v) = structured.filter(|v| v.is_object()) else { return json!({ "content": text, "tool_calls": [] }) };
    let calls: Vec<Value> = v["calls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| json!({ "function": { "name": c["name"], "arguments": c["args"].to_string() } }))
        .collect();
    let content = v["final"].as_str().filter(|s| !s.is_empty()).or(v["note"].as_str()).unwrap_or("");
    json!({ "content": content, "tool_calls": calls })
}

fn err(msg: impl Into<String>) -> AskError {
    AskError { kind: "unknown".into(), message: msg.into(), retry_after_seconds: None }
}

/// Runs the program until it exits, killing it if it takes too long.
fn run_with_watchdog(mut child: std::process::Child) -> (std::process::Child, Arc<AtomicBool>) {
    let done = Arc::new(AtomicBool::new(false));
    let (d, pid) = (done.clone(), child.id());
    std::thread::spawn(move || {
        let start = Instant::now();
        while !d.load(Ordering::Relaxed) {
            if start.elapsed() > TIMEOUT {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
    let _ = &mut child;
    (child, done)
}

pub async fn chat(app: &AppHandle, tag: &str, messages: Value, tools: Option<Value>, stream_id: Option<&str>) -> Result<Value, AskError> {
    let (kind, model) = Kind::parse(tag).ok_or_else(|| err("Unknown model."))?;
    if let Some(why) = ready(app, kind) {
        return Err(AskError { kind: "setup_needed".into(), message: why, retry_after_seconds: None });
    }
    let bin = find_cli(kind.program()).ok_or_else(|| err("The program went missing."))?;
    let mut flat = flatten(&messages);
    let mut schema = None;
    if let Some(t) = &tools {
        let (desc, s) = tool_instructions(t);
        flat.system.push_str(&desc);
        schema = Some(s);
    }
    let (app2, stream_id) = (app.clone(), stream_id.map(String::from));
    tauri::async_runtime::spawn_blocking(move || match kind {
        Kind::Claude => run_claude(&app2, &bin, &model, flat, schema, stream_id.as_deref()),
        Kind::Codex => run_codex(&app2, &bin, &model, flat, schema, stream_id.as_deref()),
    })
    .await
    .map_err(|e| err(e.to_string()))?
}

fn run_claude(app: &AppHandle, bin: &PathBuf, model: &str, flat: Flat, schema: Option<Value>, stream_id: Option<&str>) -> Result<Value, AskError> {
    let mut cmd = command(bin, app);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose"])
        .args(["--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"])
        .args(["--model", model, "--system-prompt", &flat.system])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(s) = &schema {
        cmd.args(["--json-schema", &s.to_string()]);
    }
    let mut content = vec![json!({ "type": "text", "text": flat.prompt })];
    for (mime, data) in &flat.images {
        content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": data } }));
    }
    let input = json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string();

    let child = cmd.spawn().map_err(|e| err(format!("Couldn't start Claude: {e}")))?;
    let (mut child, done) = run_with_watchdog(child);
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin, "{input}");
    }
    let stdout = child.stdout.take().ok_or_else(|| err("No output from Claude."))?;
    let mut text = String::new();
    let mut result: Option<Value> = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match v["type"].as_str() {
            Some("stream_event") => {
                if let Some(t) = v["event"]["delta"]["text"].as_str() {
                    text.push_str(t);
                    if let Some(id) = stream_id {
                        let _ = app.emit("ask-delta", json!({ "id": id, "text": t }));
                    }
                }
            }
            Some("result") => result = Some(v),
            _ => {}
        }
    }
    let status = child.wait();
    done.store(true, Ordering::Relaxed);
    let Some(r) = result else {
        let mut e = String::new();
        if let Some(mut s) = child.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut s, &mut e);
        }
        let e: String = e.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(err(format!("Claude didn't answer ({}).\n{e}", status.map(|s| s.to_string()).unwrap_or_default())));
    };
    if r["is_error"] == true {
        let m = r["result"].as_str().unwrap_or("Claude returned an error.");
        return Err(err(if m.to_lowercase().contains("limit") { format!("{m}\n\nYour Claude subscription limit may be used up for now.") } else { m.to_string() }));
    }
    if text.is_empty() {
        text = r["result"].as_str().unwrap_or("").to_string();
    }
    Ok(to_reply(schema.map(|_| r["structured_output"].clone()), text))
}

/// UNTESTED: follows `codex exec`'s documented flags (stdin prompt, -i images, --output-schema, -o result file).
fn run_codex(app: &AppHandle, bin: &PathBuf, model: &str, flat: Flat, schema: Option<Value>, stream_id: Option<&str>) -> Result<Value, AskError> {
    let dir = std::env::temp_dir().join(format!("clickr-codex-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| err(e.to_string()))?;
    let out = dir.join("answer.txt");
    let mut cmd = command(bin, app);
    cmd.args(["exec", "--skip-git-repo-check", "-s", "read-only", "-o"]).arg(&out);
    if model != "default" {
        cmd.args(["-m", model]);
    }
    for (i, (mime, data)) in flat.images.iter().enumerate() {
        use base64::{engine::general_purpose, Engine as _};
        let ext = if mime.contains("png") { "png" } else { "jpg" };
        let p = dir.join(format!("img{i}.{ext}"));
        std::fs::write(&p, general_purpose::STANDARD.decode(data).unwrap_or_default()).map_err(|e| err(e.to_string()))?;
        cmd.arg("-i").arg(p);
    }
    if let Some(s) = &schema {
        let p = dir.join("schema.json");
        std::fs::write(&p, s.to_string()).map_err(|e| err(e.to_string()))?;
        cmd.arg("--output-schema").arg(p);
    }
    cmd.arg("-").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| err(format!("Couldn't start Codex: {e}")))?;
    let (mut child, done) = run_with_watchdog(child);
    if let Some(mut stdin) = child.stdin.take() {
        let _ = write!(stdin, "{}\n\n{}", flat.system, flat.prompt);
    }
    let output = child.wait_with_output();
    done.store(true, Ordering::Relaxed);
    let answer = std::fs::read_to_string(&out).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    if answer.trim().is_empty() {
        let e = output.map(|o| String::from_utf8_lossy(&o.stderr).lines().rev().take(4).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        return Err(err(format!("Codex didn't answer.\n{e}")));
    }
    if let Some(id) = stream_id {
        let _ = app.emit("ask-delta", json!({ "id": id, "text": answer }));
    }
    let structured = schema.and_then(|_| serde_json::from_str::<Value>(answer.trim()).ok());
    Ok(to_reply(structured, answer))
}
