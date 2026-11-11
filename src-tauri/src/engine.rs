// src-tauri/src/engine.rs
// Clickr's brain is a free open model running on this computer. The engine is llama.cpp's
// `llama-server`, downloaded once into the app's own folder (nothing to install, no other app to keep
// open). Models are GGUF files from Hugging Face. The server starts when you ask something and stops
// after a few idle minutes or when Clickr quits.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// Pinned: a build we know works. Bump it deliberately after testing.
const LLAMA_BUILD: &str = "b12292";
const IDLE_MINUTES: u64 = 10;

struct Server {
    child: Child,
    tag: String,
    port: u16,
    last_used: Instant,
}
static SERVER: Mutex<Option<Server>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Default)]
struct Config {
    model: Option<String>,
}

pub fn active_model(app: &AppHandle) -> Option<String> {
    crate::local::load::<Config>(app, "config.json").model
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent("Clickr-AI").connect_timeout(Duration::from_secs(20)).build().unwrap_or_default()
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn model_dir(app: &AppHandle, tag: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("models").join(tag.replace(':', "__")))
}

fn engine_bin(app: &AppHandle) -> Option<PathBuf> {
    let p = data_dir(app).ok()?.join("engine").join(format!("llama-{LLAMA_BUILD}")).join("llama-server");
    p.exists().then_some(p)
}

async fn sleep_ms(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await.ok();
}

/// What the setup screen needs: is the engine downloaded, which models are downloaded, which is chosen.
#[tauri::command]
pub fn ai_status(app: AppHandle) -> Value {
    let mut models = Vec::new();
    if let Ok(dir) = data_dir(&app).map(|d| d.join("models")) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = e.path();
            let Ok(meta) = std::fs::metadata(path.join("model.gguf")) else { continue };
            let mm = std::fs::metadata(path.join("mmproj.gguf")).map(|m| m.len()).unwrap_or(0);
            models.push(json!({ "name": e.file_name().to_string_lossy().replace("__", ":"), "size": meta.len() + mm }));
        }
    }
    json!({ "engine": engine_bin(&app).is_some(), "models": models, "active": active_model(&app) })
}

/// Installed memory in GB, so the setup screen can warn when a model is too big.
#[tauri::command]
pub fn system_ram_gb() -> u64 {
    #[cfg(target_os = "macos")]
    if let Ok(o) = Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
        if let Ok(b) = String::from_utf8_lossy(&o.stdout).trim().parse::<u64>() {
            return b / (1024 * 1024 * 1024);
        }
    }
    0
}

#[tauri::command]
pub fn ai_set_model(app: AppHandle, model: String) -> Result<(), String> {
    crate::local::save(&app, "config.json", &Config { model: Some(model) })
}

/// Streams a file to disk (via a .part file) and reports cumulative progress as `ai-pull`.
async fn download(app: &AppHandle, url: &str, dest: &PathBuf, phase: &str, tag: &str, base: u64, total: u64) -> Result<u64, String> {
    let res = client().get(url).send().await.map_err(|_| "Couldn't reach the download server. Check your internet connection.".to_string())?;
    if !res.status().is_success() {
        return Err(format!("The download server answered {}. Try again later.", res.status()));
    }
    let total = if total > 0 { total } else { base + res.content_length().unwrap_or(0) };
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut done = 0u64;
    let mut last = Instant::now();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The download was interrupted. Press the button again to retry.".to_string())?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(200) {
            last = Instant::now();
            let _ = app.emit("ai-pull", json!({ "phase": phase, "tag": tag, "completed": base + done, "total": total }));
        }
    }
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    let _ = app.emit("ai-pull", json!({ "phase": phase, "tag": tag, "completed": base + done, "total": total }));
    Ok(done)
}

/// Downloads the llama.cpp engine (about 17 MB) into the app's folder.
async fn install_engine(app: &AppHandle, tag: &str) -> Result<(), String> {
    if engine_bin(app).is_some() {
        return Ok(());
    }
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => return Err(format!("This computer type ({other}) isn't supported yet.")),
    };
    #[cfg(not(target_os = "macos"))]
    return Err("The AI engine download is only set up for macOS so far.".into());

    let dir = data_dir(app)?.join("engine");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tgz = dir.join("engine.tar.gz");
    let url = format!("https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/llama-{LLAMA_BUILD}-bin-macos-{arch}.tar.gz");
    download(app, &url, &tgz, "engine", tag, 0, 0).await?;
    let ok = Command::new("tar").arg("-xzf").arg(&tgz).arg("-C").arg(&dir).status().map(|s| s.success()).unwrap_or(false);
    let _ = std::fs::remove_file(&tgz);
    if !ok || engine_bin(app).is_none() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("Couldn't unpack the AI engine. Try again.".into());
    }
    Ok(())
}

/// Picks the files to download for a Hugging Face GGUF repo: a 4-bit model, plus the vision projector if any.
fn pick_files(siblings: &[(String, u64)]) -> Option<((String, u64), Option<(String, u64)>)> {
    let top: Vec<&(String, u64)> = siblings.iter().filter(|(n, _)| !n.contains('/') && n.ends_with(".gguf")).collect();
    let model = ["-Q4_K_M.gguf", "UD-Q4_K_M.gguf", "Q4_K_M", "Q4_0"]
        .iter()
        .find_map(|pat| top.iter().find(|(n, _)| !n.contains("mmproj") && n.contains(pat) && (*pat != "-Q4_K_M.gguf" || !n.contains("UD-"))))?;
    let mm = ["mmproj-F16.gguf", "mmproj-BF16.gguf", "mmproj"].iter().find_map(|pat| top.iter().find(|(n, _)| n.contains(pat)));
    Some(((model.0.clone(), model.1), mm.map(|m| (m.0.clone(), m.1))))
}

/// Downloads a model (and the engine, the first time). `repo` is the Hugging Face GGUF repository.
#[tauri::command]
pub async fn ai_download_model(app: AppHandle, tag: String, repo: String) -> Result<(), String> {
    install_engine(&app, &tag).await?;

    let info: Value = client()
        .get(format!("https://huggingface.co/api/models/{repo}?blobs=true"))
        .send()
        .await
        .map_err(|_| "Couldn't reach huggingface.co. Check your internet connection.".to_string())?
        .json()
        .await
        .map_err(|_| "Couldn't read the model list from huggingface.co.".to_string())?;
    let siblings: Vec<(String, u64)> = info["siblings"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| Some((s["rfilename"].as_str()?.to_string(), s["size"].as_u64().unwrap_or(0)))).collect())
        .unwrap_or_default();
    let (model, mmproj) = pick_files(&siblings).ok_or("That model has no download we can use.")?;

    let dir = model_dir(&app, &tag)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let total = model.1 + mmproj.as_ref().map(|m| m.1).unwrap_or(0);
    let url = |f: &str| format!("https://huggingface.co/{repo}/resolve/main/{f}");

    let mut base = 0;
    if let Some((name, size)) = &mmproj {
        base += download(&app, &url(name), &dir.join("mmproj.gguf"), "model", &tag, 0, total).await.map_err(|e| { let _ = std::fs::remove_dir_all(&dir); e })?;
        let _ = size;
    }
    download(&app, &url(&model.0), &dir.join("model.gguf"), "model", &tag, base, total).await.map_err(|e| { let _ = std::fs::remove_dir_all(&dir); e })?;
    Ok(())
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

fn unknown(msg: impl Into<String>) -> AskError {
    AskError { kind: "unknown".into(), message: msg.into(), retry_after_seconds: None }
}

/// Why the AI can't answer right now (None = ready).
pub fn readiness(app: &AppHandle) -> Option<String> {
    if engine_bin(app).is_none() {
        return Some("The AI engine isn't downloaded yet.".into());
    }
    let Some(active) = active_model(app) else { return Some("Choose an AI model to download.".into()) };
    match model_dir(app, &active) {
        Ok(d) if d.join("model.gguf").exists() => None,
        _ => Some("The chosen AI model isn't downloaded yet.".into()),
    }
}

#[tauri::command]
pub fn check_ai(app: AppHandle) -> Result<(), String> {
    match readiness(&app) {
        None => Ok(()),
        Some(m) => Err(m),
    }
}

fn kill_server() {
    if let Some(mut s) = SERVER.lock().unwrap().take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// Called when Clickr quits so no model keeps running (and holding memory) in the background.
pub fn shutdown() {
    kill_server();
}

/// Frees the model's memory after a few idle minutes; the next question reloads it.
pub fn start_idle_reaper() {
    tauri::async_runtime::spawn(async {
        loop {
            sleep_ms(30_000).await;
            let idle = SERVER.lock().unwrap().as_ref().map(|s| s.last_used.elapsed() > Duration::from_secs(IDLE_MINUTES * 60)).unwrap_or(false);
            if idle {
                kill_server();
            }
        }
    });
}

fn alive() -> Option<(String, u16)> {
    let mut g = SERVER.lock().unwrap();
    let s = g.as_mut()?;
    if s.child.try_wait().ok().flatten().is_some() {
        *g = None;
        return None;
    }
    s.last_used = Instant::now();
    Some((s.tag.clone(), s.port))
}

/// Starts llama-server for the chosen model if it isn't running yet and waits until it answers.
async fn ensure_server(app: &AppHandle) -> Result<u16, AskError> {
    if let Some(why) = readiness(app) {
        return Err(setup_error(&why));
    }
    let tag = active_model(app).unwrap_or_default();
    if let Some((running, port)) = alive() {
        if running == tag {
            return Ok(port);
        }
        kill_server();
    }

    let bin = engine_bin(app).ok_or_else(|| setup_error("The AI engine isn't downloaded yet."))?;
    let dir = model_dir(app, &tag).map_err(unknown)?;
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| unknown(e.to_string()))?;
    let log_path = data_dir(app).map_err(unknown)?.join("engine.log");
    let log = std::fs::File::create(&log_path).map_err(|e| unknown(e.to_string()))?;
    let ctx = if system_ram_gb() >= 24 { "16384" } else { "8192" };

    let mut cmd = Command::new(&bin);
    cmd.current_dir(bin.parent().unwrap_or(&dir))
        .arg("-m").arg(dir.join("model.gguf"))
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "-c", ctx, "-np", "1", "--jinja", "-ngl", "99"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| unknown(e.to_string()))?))
        .stderr(Stdio::from(log));
    if dir.join("mmproj.gguf").exists() {
        cmd.arg("--mmproj").arg(dir.join("mmproj.gguf"));
    }
    let child = cmd.spawn().map_err(|e| unknown(format!("Couldn't start the AI engine: {e}")))?;
    *SERVER.lock().unwrap() = Some(Server { child, tag: tag.clone(), port, last_used: Instant::now() });

    // Loading a big model can take a while.
    for _ in 0..600 {
        sleep_ms(500).await;
        if alive().is_none() {
            let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
            let tail: String = tail.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(unknown(format!("The AI engine stopped while loading the model.\n\n{tail}")));
        }
        if let Ok(r) = client().get(format!("http://127.0.0.1:{port}/health")).timeout(Duration::from_secs(2)).send().await {
            if r.status().is_success() {
                return Ok(port);
            }
        }
    }
    kill_server();
    Err(unknown("The AI model took too long to load. It may be too big for this computer: try a smaller one."))
}

/// One chat call to the local model (OpenAI-style messages). Streams text pieces as `ask-delta` when
/// `stream_id` is set. Returns `{ content, tool_calls: [{ function: { name, arguments } }] }`.
pub async fn chat(app: &AppHandle, messages: Value, tools: Option<Value>, stream_id: Option<&str>) -> Result<Value, AskError> {
    let port = ensure_server(app).await?;
    let stream = stream_id.is_some();
    let mut body = json!({
        "model": "local",
        "messages": messages,
        "stream": stream,
        // Thinking models can "think" for minutes before answering; keep replies quick.
        "chat_template_kwargs": { "enable_thinking": false },
    });
    if let Some(t) = tools {
        body["tools"] = t;
    }
    let lost = |_| AskError { kind: "network".into(), message: "The AI engine stopped answering. Try again.".into(), retry_after_seconds: None };
    let res = client().post(format!("http://127.0.0.1:{port}/v1/chat/completions")).json(&body).send().await.map_err(lost)?;
    if !res.status().is_success() {
        let t = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&t).ok().and_then(|v| v["error"]["message"].as_str().map(String::from));
        return Err(unknown(msg.unwrap_or_else(|| "The AI model returned an error.".into())));
    }

    if !stream {
        let v: Value = res.json().await.map_err(lost)?;
        let m = &v["choices"][0]["message"];
        let calls: Vec<Value> = m["tool_calls"].as_array().cloned().unwrap_or_default();
        return Ok(json!({ "content": m["content"].as_str().unwrap_or(""), "tool_calls": calls }));
    }

    let id = stream_id.unwrap_or_default();
    let mut content = String::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut bytes = res.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        buf.extend_from_slice(&chunk.map_err(lost)?);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { continue };
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                if !t.is_empty() {
                    content.push_str(t);
                    let _ = app.emit("ask-delta", json!({ "id": id, "text": t }));
                }
            }
        }
    }
    Ok(json!({ "content": content, "tool_calls": [] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_plain_q4_then_ud_q4_and_skips_subfolders() {
        let f = |names: &[&str]| names.iter().map(|n| (n.to_string(), 1)).collect::<Vec<_>>();
        let a = pick_files(&f(&["M-UD-Q4_K_M.gguf", "M-Q4_K_M.gguf", "mmproj-BF16.gguf", "mmproj-F16.gguf", "MTP/x-Q4_0.gguf"])).unwrap();
        assert_eq!(a.0 .0, "M-Q4_K_M.gguf");
        assert_eq!(a.1.unwrap().0, "mmproj-F16.gguf");
        let b = pick_files(&f(&["M-UD-Q4_K_M.gguf", "M-UD-IQ4_XS.gguf", "mmproj-BF16.gguf"])).unwrap();
        assert_eq!(b.0 .0, "M-UD-Q4_K_M.gguf");
        assert_eq!(b.1.unwrap().0, "mmproj-BF16.gguf");
        assert!(pick_files(&f(&["README.md"])).is_none());
    }
}
