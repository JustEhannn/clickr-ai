// src-tauri/src/auth.rs
// Clickr session management: PKCE sign-in against Supabase Auth's REST API,
// refresh token kept in the OS keychain, access token kept in memory only.
//
// FILL IN before building: SUPABASE_URL and SUPABASE_ANON_KEY below.
// The anon key is public by design (it's what ships in every Supabase
// frontend); it is not the service role key from the Edge Function.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const SUPABASE_URL: &str = "https://xoebvsthsmrnuusduzfg.supabase.co";
pub(crate) const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhvZWJ2c3Roc21ybnV1c2R1emZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyMjQ3NTcsImV4cCI6MjEwNTgwMDc1N30.RjErbaAI-QC9qQPP2pzu6tdVyoPgX3LiFnWP2C0p5-A"; // public "anon" key: safe to ship, protected by row-level security
const REDIRECT_TO: &str = "clickr://auth-callback";
/// Sign-in happens on the website; it hands the session back through clickr://auth-callback?handoff=…
const WEB_LOGIN_URL: &str = "https://www.clickrai.com/login";
const KEYCHAIN_SERVICE: &str = "net.getclickr.app"; // must match tauri.conf.json identifier

/// The one thing every window is allowed to know about the signed-in user.
/// Never includes tokens — those stay in Rust.
#[derive(Clone, Serialize, Deserialize)]
pub struct PublicSession {
    pub email: Option<String>,
    pub user_id: Option<String>,
    pub signed_in: bool,
}

impl PublicSession {
    fn signed_out() -> Self {
        Self { email: None, signed_in: false, user_id: None }
    }
}

struct Session {
    access_token: String,
    refresh_token: String,
    email: Option<String>,
    user_id: String,
}

/// Managed app state. `pending_verifier` bridges the two halves of one PKCE
/// flow (browser round-trip in between), so it only ever holds one flow at
/// a time — starting a second sign-in cancels an in-flight one.
pub struct AuthState {
    session: Mutex<Option<Session>>,
    pending_verifier: Mutex<Option<String>>,
}


/// Synchronous check used by toggle_window (not async) to decide whether
/// to show the main panel or redirect to sign-in.
pub fn is_signed_in(app: &AppHandle) -> bool {
    app.state::<AuthState>().session.lock().unwrap().is_some()
}

impl AuthState {
    pub fn new() -> Self {
        Self { session: Mutex::new(None), pending_verifier: Mutex::new(None) }
    }
}

fn keychain_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, "supabase_refresh_token").map_err(|e| e.to_string())
}

// ---- PKCE ------------------------------------------------------------

fn generate_pkce_pair() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());

    (verifier, challenge)
}

// ---- Supabase REST calls ----------------------------------------------

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    user: SupabaseUser,
}

#[derive(Deserialize)]
struct SupabaseUser {
    id: String,
    email: Option<String>,
}

async fn exchange_code(auth_code: &str, code_verifier: &str) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{SUPABASE_URL}/auth/v1/token?grant_type=pkce"))
        .header("apikey", SUPABASE_ANON_KEY)
        .json(&serde_json::json!({ "auth_code": auth_code, "code_verifier": code_verifier }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the sign-in service. Check your connection.".to_string())?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        eprintln!("PKCE exchange failed: {body}");
        return Err("That sign-in link didn't work. Please try again.".to_string());
    }

    res.json::<TokenResponse>()
        .await
        .map_err(|_| "Got an unexpected response from the sign-in service.".to_string())
}

async fn refresh_session(refresh_token: &str) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token"))
        .header("apikey", SUPABASE_ANON_KEY)
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the sign-in service.".to_string())?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        eprintln!("Token refresh failed: {body}");
        return Err("Your session has expired. Please sign in again.".to_string());
    }

    res.json::<TokenResponse>()
        .await
        .map_err(|_| "Got an unexpected response from the sign-in service.".to_string())
}

/// Persists a fresh session in memory + keychain, then tells every window.
fn apply_session(app: &AppHandle, state: &State<AuthState>, tok: TokenResponse) -> PublicSession {
    let entry = keychain_entry();
    if let Ok(entry) = entry {
        let _ = entry.set_password(&tok.refresh_token);
    }

    let public = PublicSession {
        email: tok.user.email.clone(),
        user_id: Some(tok.user.id.clone()),
        signed_in: true,
    };

    *state.session.lock().unwrap() = Some(Session {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        email: tok.user.email,
        user_id: tok.user.id,
    });

    let _ = app.emit("session-updated", public.clone());
    public
}

fn clear_session(app: &AppHandle, state: &State<AuthState>) {
    if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    *state.session.lock().unwrap() = None;
    let _ = app.emit("session-updated", PublicSession::signed_out());
}

// ---- Commands (called from the frontend) -------------------------------


#[derive(Serialize, Deserialize)]
pub struct SubscriptionInfo {
    pub tier: String,
    pub status: String,
    pub billing_cycle: Option<String>,
    pub current_period_end: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LinkedIdentity {
    pub id: String,
    pub provider: String,
}

#[tauri::command]
pub async fn get_linked_providers(app: AppHandle) -> Result<Vec<LinkedIdentity>, String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;

    #[derive(Deserialize)]
    struct UserResponse {
        identities: Vec<LinkedIdentity>,
    }

    let client = reqwest::Client::new();
    let res = client
        .get(format!("{SUPABASE_URL}/auth/v1/user"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;

    if !res.status().is_success() {
        return Err("Couldn't load account info.".to_string());
    }

    let parsed: UserResponse = res.json().await.map_err(|_| "Unexpected response.".to_string())?;
    Ok(parsed.identities)
}

#[tauri::command]
pub async fn start_link_google(app: AppHandle, state: State<'_, AuthState>) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let (verifier, challenge) = generate_pkce_pair();
    *state.pending_verifier.lock().unwrap() = Some(verifier);

    let client = reqwest::Client::new();
    let res = client
        .get(format!(
            "{SUPABASE_URL}/auth/v1/user/identities/authorize?provider=google&redirect_to={redirect}&code_challenge={challenge}&code_challenge_method=s256&skip_http_redirect=true",
            redirect = urlencoding::encode(REDIRECT_TO),
            challenge = challenge,
        ))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the sign-in service.".to_string())?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        eprintln!("link identity authorize failed: {body}");
        return Err("Couldn't start linking. Make sure manual linking is enabled in Supabase.".to_string());
    }

    #[derive(Deserialize)]
    struct AuthorizeResponse {
        url: String,
    }
    let parsed: AuthorizeResponse = res.json().await.map_err(|_| "Unexpected response.".to_string())?;

    tauri_plugin_opener::open_url(parsed.url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn unlink_provider(app: AppHandle, identity_id: String) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;

    let client = reqwest::Client::new();
    let res = client
        .delete(format!("{SUPABASE_URL}/auth/v1/user/identities/{identity_id}"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        eprintln!("unlink failed: {body}");
        return Err("Couldn't unlink that account. You may need at least one sign-in method remaining.".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn get_subscription(app: AppHandle) -> Result<SubscriptionInfo, String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;

    let client = reqwest::Client::new();
    let res = client
        .get(format!(
            "{SUPABASE_URL}/rest/v1/subscriptions?select=tier,status,billing_cycle,current_period_end"
        ))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;

    if !res.status().is_success() {
        return Err("Couldn't load your plan.".to_string());
    }

    let rows: Vec<SubscriptionInfo> = res
        .json()
        .await
        .map_err(|_| "Got an unexpected response.".to_string())?;

    rows.into_iter()
        .next()
        .ok_or_else(|| "No subscription found.".to_string())
}

/// Opens the website's sign-in page. The page signs the user in (password or Google)
/// and sends them back here via a deep link. Only a hash (the PKCE challenge) of the
/// secret we keep in memory is shared, so a stolen link is useless on its own.
#[tauri::command]
pub fn start_web_sign_in(state: State<AuthState>) -> Result<(), String> {
    let (verifier, challenge) = generate_pkce_pair();
    *state.pending_verifier.lock().unwrap() = Some(verifier);

    let url = format!("{WEB_LOGIN_URL}?client=app&challenge={challenge}");
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Trades the website's one-time code (plus our secret) for a session.
async fn exchange_handoff(code: &str, verifier: &str) -> Result<TokenResponse, String> {
    let res = reqwest::Client::new()
        .post(format!("{SUPABASE_URL}/functions/v1/app-auth-exchange"))
        .header("apikey", SUPABASE_ANON_KEY)
        .json(&serde_json::json!({ "code": code, "verifier": verifier }))
        .send()
        .await
        .map_err(|_| "Couldn't reach Clickr. Check your connection and try again.".to_string())?;

    if !res.status().is_success() {
        let v: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
        return Err(v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("That sign-in link didn't work. Please try again.")
            .to_string());
    }
    res.json::<TokenResponse>()
        .await
        .map_err(|_| "Got an unexpected response while signing in.".to_string())
}

/// Called by the deep-link handler in lib.rs when `clickr://auth-callback?code=...` arrives.
pub async fn handle_auth_callback(app: &AppHandle, url: &str) {
    let Ok(parsed) = url::Url::parse(url) else { return };

    // New: sign-in handed over from the website.
    if let Some(handoff) = parsed.query_pairs().find(|(k, _)| k == "handoff").map(|(_, v)| v.to_string()) {
        let state = app.state::<AuthState>();
        let verifier = state.pending_verifier.lock().unwrap().take();
        let Some(verifier) = verifier else {
            let _ = app.emit("session-error", "Press the sign-in button in Clickr first, then finish in your browser.".to_string());
            return;
        };
        match exchange_handoff(&handoff, &verifier).await {
            Ok(tok) => {
                apply_session(app, &state, tok);
            }
            Err(e) => {
                eprintln!("Handoff exchange failed: {e}");
                let _ = app.emit("session-error", e);
            }
        }
        return;
    }

    // Legacy PKCE code flow (still used when linking a Google account from Settings).
    let code = parsed.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string());
    let Some(code) = code else {
        eprintln!("Deep link had no `code` param: {url}");
        return;
    };

    let state = app.state::<AuthState>();
    let verifier = state.pending_verifier.lock().unwrap().take();
    let Some(verifier) = verifier else {
        eprintln!("Received auth callback with no pending sign-in in progress.");
        return;
    };

    match exchange_code(&code, &verifier).await {
        Ok(tok) => {
            apply_session(app, &state, tok);
        }
        Err(e) => {
            eprintln!("Auth callback exchange failed: {e}");
            let _ = app.emit("session-error", e);
        }
    }
}

#[tauri::command]
pub fn sign_out(app: AppHandle, state: State<AuthState>) {
    clear_session(&app, &state);
    crate::open_signin_window(app);
}

#[tauri::command]
pub fn get_session(state: State<AuthState>) -> PublicSession {
    match &*state.session.lock().unwrap() {
        Some(s) => PublicSession { email: s.email.clone(), signed_in: true, user_id: Some(s.user_id.clone()) },
        None => PublicSession::signed_out(),
    }
}

/// Called once from `setup()`. Tries to restore a session from the keychain's
/// refresh token so the user isn't asked to sign in on every launch.
pub async fn restore_session_on_launch(app: AppHandle) {
    let refresh_token = keychain_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())).ok();

    if let Some(refresh_token) = refresh_token {
        let state = app.state::<AuthState>();
        match refresh_session(&refresh_token).await {
            Ok(tok) => {
                apply_session(&app, &state, tok);
            }
            Err(_) => {
                clear_session(&app, &state);
            }
        }
    }

    if !is_signed_in(&app) {
        crate::open_signin_window(app.clone());
    }
}

/// Returns a valid access token for `ask_ai` to use, refreshing first if we
/// have a session. Returns Err if the user isn't signed in.
pub async fn get_access_token(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AuthState>();

    let token = {
        let guard = state.session.lock().unwrap();
        match &*guard {
            Some(s) => s.access_token.clone(),
            None => return Err("not_signed_in".to_string()),
        }
    };

    // Access tokens last about an hour. Refresh a little BEFORE expiry so every feature
    // (plan lookups, memory, history sync, device checks) keeps working, not just the ones
    // that happen to retry after a 401.
    if jwt_seconds_left(&token).map(|s| s < 90).unwrap_or(false) {
        // One refresh at a time: refresh tokens rotate, so parallel refreshes would clash.
        let _guard = REFRESH_LOCK.lock().await;
        let current = {
            let guard = state.session.lock().unwrap();
            guard.as_ref().map(|s| s.access_token.clone())
        };
        match current {
            None => return Err("not_signed_in".to_string()),
            // Someone else already refreshed while we waited.
            Some(t) if jwt_seconds_left(&t).map(|s| s >= 90).unwrap_or(true) => return Ok(t),
            Some(_) => return force_refresh(app).await,
        }
    }

    Ok(token)
}

/// Seconds until a JWT expires, read from its `exp` claim (None if it can't be read).
fn jwt_seconds_left(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let exp = v.get("exp")?.as_i64()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(exp - now)
}

static REFRESH_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

/// Called by ask_ai after a 401 from the backend, to refresh once and retry.
pub async fn force_refresh(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AuthState>();
    let refresh_token = {
        let guard = state.session.lock().unwrap();
        match &*guard {
            Some(s) => s.refresh_token.clone(),
            None => return Err("not_signed_in".to_string()),
        }
    };

    match refresh_session(&refresh_token).await {
        Ok(tok) => {
            let access_token = tok.access_token.clone();
            apply_session(app, &state, tok);
            Ok(access_token)
        }
        Err(_) => {
            clear_session(app, &state);
            Err("not_signed_in".to_string())
        }
    }
}
// ---- Custom AI models (Pro+) -------------------------------------------
// Stored in the `custom_models` table (see supabase/migrations/003_custom_models.sql).
// RLS limits rows to their owner, and the insert policy requires a Pro+ plan,
// so the tier gate is enforced in the database, not just in the UI.
// The api_key is never sent back to the frontend.

#[derive(Serialize, Deserialize, Clone)]
pub struct CustomModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model_id: String,
    pub base_url: Option<String>,
}

#[tauri::command]
pub async fn list_custom_models(app: AppHandle) -> Result<Vec<CustomModel>, String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let res = reqwest::Client::new()
        .get(format!(
            "{SUPABASE_URL}/rest/v1/custom_models?select=id,name,provider,model_id,base_url&order=created_at.asc"
        ))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;

    if !res.status().is_success() {
        return Err("Couldn't load your models.".to_string());
    }
    res.json().await.map_err(|_| "Got an unexpected response.".to_string())
}

#[tauri::command]
pub async fn add_custom_model(
    app: AppHandle,
    name: String,
    provider: String,
    model_id: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<(), String> {
    if name.trim().is_empty() || model_id.trim().is_empty() || api_key.trim().is_empty() {
        return Err("Name, model ID and API key are all required.".to_string());
    }
    let (token, user_id) = {
        let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
        let state = app.state::<AuthState>();
        let uid = state.session.lock().unwrap().as_ref().map(|s| s.user_id.clone());
        (token, uid.ok_or_else(|| "not_signed_in".to_string())?)
    };

    let res = reqwest::Client::new()
        .post(format!("{SUPABASE_URL}/rest/v1/custom_models"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .header("Prefer", "return=minimal")
        .json(&serde_json::json!({
            "user_id": user_id,
            "name": name.trim(),
            "provider": provider,
            "model_id": model_id.trim(),
            "api_key": api_key.trim(),
            "base_url": base_url.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()),
        }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;

    if res.status().is_success() {
        return Ok(());
    }
    let status = res.status().as_u16();
    eprintln!("add_custom_model failed ({status}): {}", res.text().await.unwrap_or_default());
    if status == 401 || status == 403 {
        Err("Custom models are available on Pro+.".to_string())
    } else {
        Err("Couldn't save that model.".to_string())
    }
}

#[tauri::command]
pub async fn delete_custom_model(app: AppHandle, id: String) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let res = reqwest::Client::new()
        .delete(format!("{SUPABASE_URL}/rest/v1/custom_models?id=eq.{}", urlencoding::encode(&id)))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if res.status().is_success() { Ok(()) } else { Err("Couldn't remove that model.".to_string()) }
}

// ---- Memory & device registry (Pro / Free) -------------------------------
// Tables: user_memories, user_devices (see supabase/migrations/004_memory_devices.sql).

#[derive(Serialize, Deserialize, Clone)]
pub struct Memory {
    pub id: String,
    pub content: String,
}

async fn authed_get(app: &AppHandle, path: &str) -> Result<reqwest::Response, String> {
    let token = get_access_token(app).await.map_err(|_| "not_signed_in".to_string())?;
    reqwest::Client::new()
        .get(format!("{SUPABASE_URL}/rest/v1/{path}"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())
}

pub(crate) fn current_user_id(app: &AppHandle) -> Result<String, String> {
    app.state::<AuthState>()
        .session
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.user_id.clone())
        .ok_or_else(|| "not_signed_in".to_string())
}

#[tauri::command]
pub async fn list_memories(app: AppHandle) -> Result<Vec<Memory>, String> {
    let res = authed_get(&app, "user_memories?select=id,content&order=created_at.asc").await?;
    if !res.status().is_success() {
        return Err("Couldn't load your memories.".to_string());
    }
    res.json().await.map_err(|_| "Got an unexpected response.".to_string())
}

#[tauri::command]
pub async fn add_memory(app: AppHandle, content: String) -> Result<(), String> {
    let content = content.trim().chars().take(500).collect::<String>();
    if content.is_empty() {
        return Err("Memory can't be empty.".to_string());
    }
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let user_id = current_user_id(&app)?;
    let res = reqwest::Client::new()
        .post(format!("{SUPABASE_URL}/rest/v1/user_memories"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .header("Prefer", "return=minimal")
        .json(&serde_json::json!({ "user_id": user_id, "content": content }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        eprintln!("add_memory failed: {}", res.text().await.unwrap_or_default());
        Err("Memory is available on Pro.".to_string())
    }
}

#[tauri::command]
pub async fn delete_memory(app: AppHandle, id: String) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let res = reqwest::Client::new()
        .delete(format!("{SUPABASE_URL}/rest/v1/user_memories?id=eq.{}", urlencoding::encode(&id)))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if res.status().is_success() { Ok(()) } else { Err("Couldn't remove that memory.".to_string()) }
}

/// Registers this machine for the signed-in account and reports whether it is
/// allowed on `tier`. Free accounts get ONE device (the first registered);
/// Pro and Pro+ are unlimited. `device_id` is generated once per install by
/// the frontend.
#[tauri::command]
pub async fn register_device(app: AppHandle, device_id: String, tier: String) -> Result<bool, String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let user_id = current_user_id(&app)?;
    let client = reqwest::Client::new();

    let res = authed_get(&app, "user_devices?select=device_id&order=created_at.asc").await?;
    if !res.status().is_success() {
        // Fail open: a registry outage shouldn't lock people out of the app.
        return Ok(true);
    }
    #[derive(Deserialize)]
    struct Row { device_id: String }
    let rows: Vec<Row> = res.json().await.unwrap_or_default();

    if !rows.iter().any(|r| r.device_id == device_id) {
        if tier == "free" && !rows.is_empty() {
            return Ok(false);
        }
        let _ = client
            .post(format!("{SUPABASE_URL}/rest/v1/user_devices"))
            .header("apikey", SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {token}"))
            .header("Prefer", "return=minimal")
            .json(&serde_json::json!({ "user_id": user_id, "device_id": device_id }))
            .send()
            .await;
        return Ok(true);
    }

    // Free: only the first registered device stays valid (e.g. after a downgrade).
    if tier == "free" && rows.first().map(|r| r.device_id.as_str()) != Some(device_id.as_str()) {
        return Ok(false);
    }
    Ok(true)
}

// ---- Conversation history sync (Pro) -------------------------------------

#[tauri::command]
pub async fn pull_history(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let res = authed_get(&app, "chat_history?select=data&order=updated_at.desc&limit=30").await?;
    if !res.status().is_success() {
        return Err("Couldn't load synced history.".to_string());
    }
    #[derive(Deserialize)]
    struct Row { data: serde_json::Value }
    let rows: Vec<Row> = res.json().await.map_err(|_| "Unexpected response.".to_string())?;
    Ok(rows.into_iter().map(|r| r.data).collect())
}

/// Upserts conversations. Each entry must have string `id` and numeric `updatedAt`.
#[tauri::command]
pub async fn push_history(app: AppHandle, entries: Vec<serde_json::Value>) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let user_id = current_user_id(&app)?;
    let rows: Vec<serde_json::Value> = entries
        .into_iter()
        .filter_map(|e| {
            let id = e.get("id")?.as_str()?.to_string();
            let updated_at = e.get("updatedAt")?.as_i64()?;
            Some(serde_json::json!({ "user_id": user_id, "id": id, "data": e, "updated_at": updated_at }))
        })
        .collect();

    let res = reqwest::Client::new()
        .post(format!("{SUPABASE_URL}/rest/v1/chat_history?on_conflict=user_id,id"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .header("Prefer", "resolution=merge-duplicates,return=minimal")
        .json(&rows)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if res.status().is_success() { Ok(()) } else { Err("Couldn't sync history.".to_string()) }
}

#[tauri::command]
pub async fn clear_synced_history(app: AppHandle) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let user_id = current_user_id(&app)?;
    reqwest::Client::new()
        .delete(format!("{SUPABASE_URL}/rest/v1/chat_history?user_id=eq.{user_id}"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    Ok(())
}

/// "Use Clickr here instead": removes this account's other registered devices
/// and registers this one. Free accounts are allowed one device at a time.
#[tauri::command]
pub async fn take_over_device(app: AppHandle, device_id: String) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let user_id = current_user_id(&app)?;
    let client = reqwest::Client::new();

    let del = client
        .delete(format!(
            "{SUPABASE_URL}/rest/v1/user_devices?user_id=eq.{user_id}&device_id=neq.{}",
            urlencoding::encode(&device_id)
        ))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if !del.status().is_success() {
        return Err("Couldn't sign out the other device. Please try again.".to_string());
    }

    // Insert is a no-op if this device is already registered.
    let _ = client
        .post(format!("{SUPABASE_URL}/rest/v1/user_devices?on_conflict=user_id,device_id"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .header("Prefer", "resolution=ignore-duplicates,return=minimal")
        .json(&serde_json::json!({ "user_id": user_id, "device_id": device_id }))
        .send()
        .await;
    Ok(())
}

/// Whether Agent Mode is switched on for this account (staged rollout).
#[tauri::command]
pub async fn agent_access(app: AppHandle) -> Result<bool, String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let res = reqwest::Client::new()
        .post(format!("{SUPABASE_URL}/rest/v1/rpc/has_agent_access"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if !res.status().is_success() {
        return Ok(false);
    }
    Ok(res.json::<bool>().await.unwrap_or(false))
}

#[tauri::command]
pub async fn join_agent_waitlist(app: AppHandle) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let user_id = current_user_id(&app)?;
    let _ = reqwest::Client::new()
        .post(format!("{SUPABASE_URL}/rest/v1/agent_waitlist?on_conflict=user_id"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .header("Prefer", "resolution=ignore-duplicates,return=minimal")
        .json(&serde_json::json!({ "user_id": user_id }))
        .send()
        .await;
    Ok(())
}

// ---- Bug reports ---------------------------------------------------------------

/// Sends a bug report. The server takes the reporter's identity from the token.
#[tauri::command]
pub async fn submit_bug_report(app: AppHandle, message: String, context: serde_json::Value) -> Result<(), String> {
    let mut token = get_access_token(&app).await.map_err(|_| "Please sign in again.".to_string())?;
    for attempt in 0..2 {
        let res = reqwest::Client::new()
            .post(format!("{SUPABASE_URL}/functions/v1/submit-bug-report"))
            .header("apikey", SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({ "message": message, "context": context }))
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| "Couldn't reach Clickr. Check your connection and try again.".to_string())?;

        if res.status().as_u16() == 401 && attempt == 0 {
            token = force_refresh(&app).await.map_err(|_| "Please sign in again.".to_string())?;
            continue;
        }
        if res.status().is_success() {
            return Ok(());
        }
        let v: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
        return Err(v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Couldn't send your report. Please try again.")
            .to_string());
    }
    Err("Please sign in again.".to_string())
}

/// Removes one synced conversation (the "delete" button in chat history).
#[tauri::command]
pub async fn delete_synced_chat(app: AppHandle, id: String) -> Result<(), String> {
    let token = get_access_token(&app).await.map_err(|_| "not_signed_in".to_string())?;
    let user_id = current_user_id(&app)?;
    reqwest::Client::new()
        .delete(format!(
            "{SUPABASE_URL}/rest/v1/chat_history?user_id=eq.{user_id}&id=eq.{}",
            urlencoding::encode(&id)
        ))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    Ok(())
}
