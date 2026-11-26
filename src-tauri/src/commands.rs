//! Tauri commands — the only surface the frontend can reach.
//! Gateway calls, file access and the API key live exclusively on this side.
//! Step 1: app info, settings, Gateway/key and connection test (ported from DocAsk's commands).

use crate::config::{self, GatewayInfo, Settings};
use crate::errors::{AppError, AppResult};
use crate::gateway_test::{self, TestResult};
use crate::{llm, secrets};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub state: String, // unknown | ok | unreachable | error
    pub message: Option<String>,
    pub checked_at: i64,
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub status: Mutex<GatewayStatus>,
}

impl AppState {
    pub fn new() -> AppResult<Self> {
        std::fs::create_dir_all(config::data_dir())?;
        std::fs::create_dir_all(config::projects_dir())?;
        Ok(Self {
            settings: Mutex::new(Settings::load()),
            status: Mutex::new(GatewayStatus { state: "unknown".into(), message: None, checked_at: 0 }),
        })
    }
}

type S<'a> = State<'a, AppState>;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ------------------------------------------------------------------ app / settings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
    mock: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo { version: app.package_info().version.to_string(), data_dir: config::data_dir().to_string_lossy().into_owned(), mock: false }
}

#[tauri::command]
pub fn get_settings(state: S<'_>) -> Settings {
    state.settings.lock().clone()
}

/// Saves everything except the Gateway URL (changed only through `set_gateway_url`, which validates
/// it) and the test bookkeeping (written only by `test_gateway`).
#[tauri::command]
pub fn save_settings(state: S<'_>, settings: Settings) -> AppResult<Settings> {
    let mut cur = state.settings.lock();
    let next = Settings {
        gateway_url: cur.gateway_url.clone(),
        last_test_at: cur.last_test_at,
        last_test_ok: cur.last_test_ok,
        ..settings
    }
    .sanitize();
    next.save()?;
    *cur = next.clone();
    Ok(next)
}

// ------------------------------------------------------------------ gateway + key

fn gateway_info(state: &AppState) -> GatewayInfo {
    let s = state.settings.lock().clone();
    let (has_key, key_last4) = secrets::key_status();
    GatewayInfo {
        group_name: config::GROUP_NAME.into(),
        url: s.gateway_base(),
        default_url: config::DEFAULT_GATEWAY_URL.into(),
        has_key,
        key_last4,
        model: s.model,
        last_test_at: s.last_test_at,
        last_test_ok: s.last_test_ok,
    }
}

#[tauri::command]
pub fn get_gateway(state: S<'_>) -> GatewayInfo {
    gateway_info(&state)
}

#[tauri::command]
pub fn set_gateway_url(state: S<'_>, url: String) -> AppResult<GatewayInfo> {
    let base = config::validate_gateway_url(&url)?;
    {
        let mut s = state.settings.lock();
        if s.gateway_url != base {
            s.gateway_url = base;
            s.last_test_at = None;
            s.last_test_ok = None;
            s.save()?;
        }
    }
    Ok(gateway_info(&state))
}

/// The key goes straight to Windows Credential Manager; only "has key" + last 4 come back.
#[tauri::command]
pub fn save_api_key(state: S<'_>, key: String) -> AppResult<GatewayInfo> {
    secrets::set_key(&key)?;
    drop(key);
    {
        let mut s = state.settings.lock();
        s.last_test_at = None;
        s.last_test_ok = None;
        s.save()?;
    }
    Ok(gateway_info(&state))
}

#[tauri::command]
pub fn remove_api_key(state: S<'_>) -> AppResult<GatewayInfo> {
    secrets::delete_key()?;
    *state.status.lock() = GatewayStatus { state: "unknown".into(), message: None, checked_at: now_ms() };
    Ok(gateway_info(&state))
}

async fn do_check(app: &AppHandle) -> GatewayStatus {
    let state = app.state::<AppState>();
    let base = state.settings.lock().gateway_base();
    let st = match secrets::get_key() {
        Ok(Some(key)) => match llm::list_models(&base, &key).await {
            Ok(_) => GatewayStatus { state: "ok".into(), message: None, checked_at: now_ms() },
            Err(e) if e.is_unreachable() => GatewayStatus { state: "unreachable".into(), message: Some(e.message), checked_at: now_ms() },
            Err(e) => GatewayStatus { state: "error".into(), message: Some(e.message), checked_at: now_ms() },
        },
        Ok(None) => GatewayStatus { state: "error".into(), message: Some(AppError::no_key().message), checked_at: now_ms() },
        Err(e) => GatewayStatus { state: "error".into(), message: Some(e.message), checked_at: now_ms() },
    };
    *state.status.lock() = st.clone();
    let _ = app.emit("gateway-status", st.clone());
    st
}

#[tauri::command]
pub async fn check_gateway(app: AppHandle) -> AppResult<GatewayStatus> {
    Ok(do_check(&app).await)
}

/// Cached for 25 s so pages can poll it cheaply.
#[tauri::command]
pub async fn gateway_status(app: AppHandle) -> AppResult<GatewayStatus> {
    let cached = app.state::<AppState>().status.lock().clone();
    if now_ms() - cached.checked_at < 25_000 {
        return Ok(cached);
    }
    Ok(do_check(&app).await)
}

/// Model ids from the Gateway (`/v1/models`); DocAsk's default list when the Gateway lists none.
#[tauri::command]
pub async fn gateway_models(app: AppHandle) -> AppResult<Vec<String>> {
    let base = app.state::<AppState>().settings.lock().gateway_base();
    let key = secrets::require_key()?;
    let mut ids = llm::list_models(&base, &key).await?;
    if ids.is_empty() {
        ids = config::MODEL_IDS.iter().map(|s| s.to_string()).collect();
    }
    Ok(ids)
}

/// "Reply exactly: GOSOFT LITELLM OK" against one model (default: the model in Settings).
#[tauri::command]
pub async fn test_gateway(app: AppHandle, model: Option<String>) -> AppResult<TestResult> {
    let key = secrets::require_key()?;
    let (url, model) = {
        let s = app.state::<AppState>().settings.lock().clone();
        (s.chat_url(), model.filter(|m| !m.trim().is_empty()).unwrap_or(s.model))
    };
    let r = gateway_test::test_model(&url, &model, &key).await;
    let state = app.state::<AppState>();
    {
        let mut s = state.settings.lock();
        s.last_test_at = Some(now_ms());
        s.last_test_ok = Some(r.ok);
        s.save()?;
    }
    let (st, msg) = if r.ok {
        ("ok", None)
    } else if r.unreachable {
        ("unreachable", r.error.clone())
    } else {
        ("error", r.error.clone())
    };
    let status = GatewayStatus { state: st.into(), message: msg, checked_at: now_ms() };
    *state.status.lock() = status.clone();
    let _ = app.emit("gateway-status", status);
    Ok(r)
}

/// Usage/budget for the current key (LiteLLM `/key/info`). `Ok(None)` = the Gateway doesn't report it.
#[tauri::command]
pub async fn gateway_key_usage(app: AppHandle) -> AppResult<Option<llm::KeyUsage>> {
    let base = app.state::<AppState>().settings.lock().gateway_base();
    let key = secrets::require_key()?;
    llm::key_info(&base, &key).await
}
