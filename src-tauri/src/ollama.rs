// src-tauri/src/ollama.rs
// Clickr's brain is a free open model running on this computer through Ollama (https://ollama.com).
// This file: finding/installing/starting Ollama, downloading models, and talking to the model.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const HOST: &str = "http://127.0.0.1:11434";
const MAC_DOWNLOAD: &str = "https://ollama.com/download/Ollama-darwin.zip";

#[derive(Serialize, Deserialize, Default)]
struct Config {
    model: Option<String>,
}

pub fn active_model(app: &AppHandle) -> Option<String> {
    crate::local::load::<Config>(app, "config.json").model
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn app_path() -> Option<String> {
    ["/Applications/Ollama.app", &format!("{}/Applications/Ollama.app", std::env::var("HOME").unwrap_or_default())]
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string())
}

fn cli_installed() -> bool {
    ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"].iter().any(|p| std::path::Path::new(p).exists())
}

async fn installed_models() -> Option<Vec<Value>> {
    let res = client().get(format!("{HOST}/api/tags")).timeout(std::time::Duration::from_secs(2)).send().await.ok()?;
    let v: Value = res.json().await.ok()?;
    Some(v.get("models").and_then(|m| m.as_array()).cloned().unwrap_or_default())
}

/// What the setup screen needs: is Ollama installed, is it running, which models are downloaded, which one is chosen.
#[tauri::command]
pub async fn ollama_status(app: AppHandle) -> Value {
    let models = installed_models().await;
    json!({
        "installed": models.is_some() || app_path().is_some() || cli_installed(),
        "running": models.is_some(),
        "models": models.unwrap_or_default().iter().map(|m| json!({
            "name": m.get("name").and_then(|n| n.as_str()).unwrap_or(""),
            "size": m.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
        })).collect::<Vec<_>>(),
        "active": active_model(&app),
    })
}

/// Installed memory in GB, so the setup screen can warn when a model is too big.
#[tauri::command]
pub fn system_ram_gb() -> u64 {
    #[cfg(target_os = "macos")]
    if let Ok(o) = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
        if let Ok(b) = String::from_utf8_lossy(&o.stdout).trim().parse::<u64>() {
            return b / (1024 * 1024 * 1024);
        }
    }
    0
}

#[tauri::command]
pub fn ollama_set_model(app: AppHandle, model: String) -> Result<(), String> {
    crate::local::save(&app, "config.json", &Config { model: Some(model) })
}

/// Starts Ollama (the menu-bar app on a Mac, `ollama serve` elsewhere) and waits until it answers.
#[tauri::command]
pub async fn ollama_start() -> Result<(), String> {
    if installed_models().await.is_some() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let launched = match app_path() {
            Some(p) => std::process::Command::new("open").arg(p).status().map(|s| s.success()).unwrap_or(false),
            None => false,
        };
        if !launched {
            let bin = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"].into_iter().find(|p| std::path::Path::new(p).exists());
            match bin {
                Some(b) => {
                    std::process::Command::new(b).arg("serve").spawn().map_err(|e| e.to_string())?;
                }
                None => return Err("Ollama isn't installed yet.".into()),
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    std::process::Command::new("ollama").arg("serve").spawn().map_err(|_| "Ollama isn't installed yet.".to_string())?;

    for _ in 0..40 {
        tokio_sleep(500).await;
        if installed_models().await.is_some() {
            return Ok(());
        }
    }
    Err("Ollama didn't start. Open the Ollama app once, then try again.".into())
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await.ok();
}

/// Downloads Ollama from ollama.com and puts it in Applications (macOS). Emits `ollama-install` progress.
#[tauri::command]
pub async fn ollama_install(app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Err("Install Ollama from https://ollama.com/download, then come back.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let emit = |phase: &str, done: u64, total: u64| {
            let _ = app.emit("ollama-install", json!({ "phase": phase, "done": done, "total": total }));
        };
        let tmp = std::env::temp_dir().join("clickr-ollama");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let zip = tmp.join("Ollama-darwin.zip");

        let res = client().get(MAC_DOWNLOAD).send().await.map_err(|_| "Couldn't reach ollama.com. Check your internet connection.".to_string())?;
        if !res.status().is_success() {
            return Err(format!("ollama.com answered {}. Try again later.", res.status()));
        }
        let total = res.content_length().unwrap_or(0);
        let mut file = std::fs::File::create(&zip).map_err(|e| e.to_string())?;
        let mut done = 0u64;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "The download was interrupted.".to_string())?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            emit("download", done, total);
        }
        drop(file);

        emit("install", 0, 0);
        // /Applications if we may write there, otherwise the user's own Applications folder.
        let home_apps = format!("{}/Applications", std::env::var("HOME").unwrap_or_default());
        let target = if std::fs::metadata("/Applications").map(|m| !m.permissions().readonly()).unwrap_or(false)
            && std::process::Command::new("test").args(["-w", "/Applications"]).status().map(|s| s.success()).unwrap_or(false)
        {
            "/Applications".to_string()
        } else {
            let _ = std::fs::create_dir_all(&home_apps);
            home_apps
        };
        let ok = std::process::Command::new("ditto").args(["-x", "-k"]).arg(&zip).arg(&target).status().map(|s| s.success()).unwrap_or(false);
        let _ = std::fs::remove_dir_all(&tmp);
        if !ok {
            return Err("Couldn't unpack Ollama. Install it from https://ollama.com/download instead.".into());
        }
        // Downloaded apps are quarantined; this is the app the user just asked us to install.
        let _ = std::process::Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(format!("{target}/Ollama.app")).status();
        emit("done", 0, 0);
        Ok(())
    }
}

/// Downloads a model through Ollama. Emits `ollama-pull` { model, status, completed, total }.
#[tauri::command]
pub async fn ollama_pull(app: AppHandle, model: String) -> Result<(), String> {
    let res = client()
        .post(format!("{HOST}/api/pull"))
        .json(&json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|_| "Ollama isn't running.".to_string())?;
    if !res.status().is_success() {
        let t = res.text().await.unwrap_or_default();
        return Err(error_text(&t).unwrap_or_else(|| "Ollama couldn't download that model.".into()));
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = res.bytes_stream();
    let mut finished = false;
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(|_| "The download was interrupted. Try again to resume.".to_string())?);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
            if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                return Err(e.to_string());
            }
            let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
            finished |= status == "success";
            let _ = app.emit(
                "ollama-pull",
                json!({
                    "model": model,
                    "status": status,
                    "completed": v.get("completed").and_then(|n| n.as_u64()).unwrap_or(0),
                    "total": v.get("total").and_then(|n| n.as_u64()).unwrap_or(0),
                }),
            );
        }
    }
    if finished { Ok(()) } else { Err("The download didn't finish. Try again to resume.".into()) }
}

fn error_text(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body).ok()?.get("error")?.as_str().map(|s| s.to_string())
}

#[derive(Serialize)]
pub struct AskError {
    pub kind: String, // "setup_needed" | "bad_image" | "network" | "unknown"
    pub message: String,
    pub retry_after_seconds: Option<i64>,
}

fn setup_error(msg: &str) -> AskError {
    AskError { kind: "setup_needed".into(), message: msg.into(), retry_after_seconds: None }
}

/// Why the AI can't answer right now (None = ready).
pub async fn readiness(app: &AppHandle) -> Option<String> {
    let Some(models) = installed_models().await else {
        return Some(if app_path().is_some() || cli_installed() { "Ollama isn't running.".into() } else { "Ollama isn't installed yet.".into() });
    };
    let Some(active) = active_model(app) else { return Some("Choose an AI model to download.".into()) };
    if !models.iter().any(|m| m.get("name").and_then(|n| n.as_str()) == Some(active.as_str())) {
        return Some("The chosen AI model isn't downloaded yet.".into());
    }
    None
}

#[tauri::command]
pub async fn check_ai(app: AppHandle) -> Result<(), String> {
    match readiness(&app).await {
        None => Ok(()),
        Some(m) => Err(m),
    }
}

/// One chat call to the local model. Streams text pieces as `ask-delta` when `stream_id` is set.
/// Returns the whole reply message ({ content, tool_calls? }).
pub async fn chat(app: &AppHandle, messages: Value, tools: Option<Value>, stream_id: Option<&str>) -> Result<Value, AskError> {
    if let Some(why) = readiness(app).await {
        return Err(setup_error(&why));
    }
    let model = active_model(app).unwrap_or_default();

    // Thinking models spend minutes "thinking" silently, so ask them not to. Models without
    // that feature reject the flag, so retry once without it.
    for think in [Some(false), None] {
        let mut body = json!({ "model": model, "messages": messages, "stream": true, "options": { "num_ctx": 8192 } });
        if let Some(t) = &tools {
            body["tools"] = t.clone();
        }
        if let Some(t) = think {
            body["think"] = json!(t);
        }
        let res = client().post(format!("{HOST}/api/chat")).json(&body).send().await.map_err(|_| setup_error("Ollama isn't running."))?;
        if !res.status().is_success() {
            let t = res.text().await.unwrap_or_default();
            let msg = error_text(&t).unwrap_or_else(|| "The AI model returned an error.".into());
            if think.is_some() && msg.to_lowercase().contains("think") {
                continue;
            }
            if msg.contains("not found") {
                return Err(setup_error("The chosen AI model isn't downloaded yet."));
            }
            return Err(AskError { kind: "unknown".into(), message: msg, retry_after_seconds: None });
        }

        let mut content = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AskError {
                kind: "network".into(),
                message: "The AI stopped answering. Is Ollama still running?".into(),
                retry_after_seconds: None,
            })?;
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
                if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                    return Err(AskError { kind: "unknown".into(), message: e.to_string(), retry_after_seconds: None });
                }
                let m = v.get("message");
                if let Some(t) = m.and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                    if !t.is_empty() {
                        content.push_str(t);
                        if let Some(id) = stream_id {
                            let _ = app.emit("ask-delta", json!({ "id": id, "text": t }));
                        }
                    }
                }
                if let Some(calls) = m.and_then(|m| m.get("tool_calls")).and_then(|c| c.as_array()) {
                    tool_calls.extend(calls.iter().cloned());
                }
            }
        }
        return Ok(json!({ "content": content, "tool_calls": tool_calls }));
    }
    Err(AskError { kind: "unknown".into(), message: "The AI model returned an error.".into(), retry_after_seconds: None })
}
