// src-tauri/src/local.rs
// Everything Clickr remembers lives on this computer: there are no accounts and no servers.
// The names below are the commands the UI already calls; each is now a tiny local operation.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
pub struct PublicSession {
    pub email: Option<String>,
    pub user_id: Option<String>,
    pub signed_in: bool,
}

#[tauri::command]
pub fn get_session() -> PublicSession {
    PublicSession { email: Some("local".into()), user_id: Some("local".into()), signed_in: true }
}

/// Reads a JSON file from the app's data folder (missing or broken file = default).
pub fn load<T: for<'de> Deserialize<'de> + Default>(app: &AppHandle, name: &str) -> T {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join(name)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save<T: Serialize>(app: &AppHandle, name: &str, value: &T) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(name), json).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Memory {
    pub id: String,
    pub content: String,
}

#[tauri::command]
pub fn list_memories(app: AppHandle) -> Vec<Memory> {
    load(&app, "memories.json")
}

#[tauri::command]
pub fn add_memory(app: AppHandle, content: String) -> Result<(), String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("Nothing to remember.".into());
    }
    let mut all: Vec<Memory> = load(&app, "memories.json");
    let id = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    all.push(Memory { id, content });
    save(&app, "memories.json", &all)
}

#[tauri::command]
pub fn delete_memory(app: AppHandle, id: String) -> Result<(), String> {
    let mut all: Vec<Memory> = load(&app, "memories.json");
    all.retain(|m| m.id != id);
    save(&app, "memories.json", &all)
}
