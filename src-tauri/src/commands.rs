//! Tauri commands — the only surface the frontend can reach.
//! Gateway calls, file access and the API key live exclusively on this side.
//! Step 1: app info, settings, Gateway/key and connection test (ported from DocAsk's commands).

use crate::config::{self, GatewayInfo, Settings};
use crate::db::projects::{Project, Registry};
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
    pub projects: Mutex<Registry>,
    pub status: Mutex<GatewayStatus>,
}

impl AppState {
    pub fn new() -> AppResult<Self> {
        std::fs::create_dir_all(config::data_dir())?;
        std::fs::create_dir_all(config::projects_dir())?;
        Ok(Self {
            settings: Mutex::new(Settings::load()),
            projects: Mutex::new(Registry::load(&config::projects_dir())?),
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
    let next = merge_settings(&cur, settings);
    next.save()?;
    *cur = next.clone();
    Ok(next)
}

/// What the frontend may change through `save_settings`: everything but the Gateway URL and
/// the connection-test bookkeeping. Choosing a model other than the one last tested clears the result.
pub fn merge_settings(cur: &Settings, incoming: Settings) -> Settings {
    let keep = cur.last_test_model.as_deref() == Some(incoming.model.trim());
    Settings {
        gateway_url: cur.gateway_url.clone(),
        last_test_at: if keep { cur.last_test_at } else { None },
        last_test_ok: if keep { cur.last_test_ok } else { None },
        last_test_model: if keep { cur.last_test_model.clone() } else { None },
        ..incoming
    }
    .sanitize()
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
            s.last_test_model = None;
            s.save()?;
        }
    }
    Ok(gateway_info(&state))
}

#[tauri::command]
pub fn reset_gateway_url(state: S<'_>) -> AppResult<GatewayInfo> {
    set_gateway_url(state, config::DEFAULT_GATEWAY_URL.into())
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
        s.last_test_model = None;
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
        s.last_test_model = Some(r.model.clone());
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

// ------------------------------------------------------------------ projects

#[tauri::command]
pub fn list_projects(state: S<'_>) -> Vec<Project> {
    state.projects.lock().list()
}

#[tauri::command]
pub fn create_project(state: S<'_>, name: String, color: Option<String>) -> AppResult<Project> {
    state.projects.lock().create(&name, color.as_deref())
}

#[tauri::command]
pub fn update_project(state: S<'_>, id: String, name: Option<String>, color: Option<String>) -> AppResult<Project> {
    state.projects.lock().update(&id, name.as_deref(), color.as_deref())
}

/// Deletes the project file. If it was the last-opened project, app.json forgets it.
#[tauri::command]
pub fn delete_project(state: S<'_>, id: String) -> AppResult<()> {
    state.projects.lock().delete(&id)?;
    let mut s = state.settings.lock();
    if s.last_project_id.as_deref() == Some(id.as_str()) {
        s.last_project_id = None;
        s.save()?;
    }
    Ok(())
}

fn open_project(state: &AppState, id: &str) -> AppResult<rusqlite::Connection> {
    let path = {
        let reg = state.projects.lock();
        reg.get(id)?;
        reg.db_path(id)?
    };
    crate::db::open(&path)
}

// ------------------------------------------------------------------ services + categories (SPEC §7)

use crate::taxonomy::{self, ColumnSpec, ImportPreview, RowInput, Service, TaxonomyRow};

#[tauri::command]
pub fn list_services(state: S<'_>, project_id: String) -> AppResult<Vec<Service>> {
    taxonomy::list_services(&open_project(&state, &project_id)?)
}

#[tauri::command]
pub fn project_months(state: S<'_>, project_id: String) -> AppResult<Vec<String>> {
    taxonomy::project_months(&open_project(&state, &project_id)?)
}

#[tauri::command]
pub fn list_taxonomy(state: S<'_>, project_id: String, service_id: String) -> AppResult<Vec<TaxonomyRow>> {
    taxonomy::list_taxonomy(&open_project(&state, &project_id)?, &service_id)
}

#[tauri::command]
pub fn create_service(state: S<'_>, project_id: String, name: String, color: Option<String>, columns: Vec<String>) -> AppResult<Service> {
    taxonomy::create_service(&open_project(&state, &project_id)?, &name, color.as_deref(), &columns)
}

#[tauri::command]
pub fn update_service(state: S<'_>, project_id: String, id: String, name: Option<String>, color: Option<String>) -> AppResult<Service> {
    taxonomy::update_service(&mut open_project(&state, &project_id)?, &id, name.as_deref(), color.as_deref())
}

#[tauri::command]
pub fn delete_service(state: S<'_>, project_id: String, id: String) -> AppResult<()> {
    taxonomy::delete_service(&open_project(&state, &project_id)?, &id)
}

#[tauri::command]
pub fn set_service_columns(state: S<'_>, project_id: String, id: String, columns: Vec<ColumnSpec>) -> AppResult<Service> {
    taxonomy::set_columns(&mut open_project(&state, &project_id)?, &id, &columns)
}

#[tauri::command]
pub fn save_taxonomy_row(state: S<'_>, project_id: String, service_id: String, row: RowInput) -> AppResult<TaxonomyRow> {
    taxonomy::save_row(&mut open_project(&state, &project_id)?, &service_id, &row)
}

#[tauri::command]
pub fn taxonomy_row_usage(state: S<'_>, project_id: String, row_id: String) -> AppResult<usize> {
    Ok(taxonomy::row_usage(&open_project(&state, &project_id)?, &row_id)?.len())
}

#[tauri::command]
pub fn delete_taxonomy_row(state: S<'_>, project_id: String, row_id: String, move_to: Option<String>) -> AppResult<usize> {
    taxonomy::delete_row(&mut open_project(&state, &project_id)?, &row_id, move_to.as_deref())
}

#[tauri::command]
pub fn preview_taxonomy_import(state: S<'_>, project_id: String, path: String, service: Option<String>) -> AppResult<ImportPreview> {
    taxonomy::preview_import(&open_project(&state, &project_id)?, std::path::Path::new(&path), service.as_deref())
}

#[tauri::command]
pub fn apply_taxonomy_import(state: S<'_>, project_id: String, path: String, service: Option<String>) -> AppResult<Vec<Service>> {
    taxonomy::apply_import(&mut open_project(&state, &project_id)?, std::path::Path::new(&path), service.as_deref())
}

#[tauri::command]
pub fn save_taxonomy_template(path: String) -> AppResult<()> {
    taxonomy::write_template(std::path::Path::new(&path))
}

// ------------------------------------------------------------------ ticket import (SPEC §5)

use crate::ingest::{self, dates::DateOrder, patterns::{self, Pattern, Role, RoleMap}};

#[tauri::command]
pub fn import_preview(state: S<'_>, project_id: String, path: String, sheet: Option<String>) -> AppResult<ingest::Preview> {
    ingest::preview(&open_project(&state, &project_id)?, std::path::Path::new(&path), sheet.as_deref())
}

#[tauri::command]
pub fn import_analyze(state: S<'_>, project_id: String, path: String, sheet: Option<String>, roles: Vec<Role>, date_order: Option<DateOrder>) -> AppResult<ingest::Summary> {
    let conn = open_project(&state, &project_id)?;
    let p = ingest::load(std::path::Path::new(&path), sheet.as_deref())?;
    ingest::analyze(&conn, &p, &roles, date_order)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn import_commit(
    state: S<'_>,
    project_id: String,
    path: String,
    sheet: Option<String>,
    roles: Vec<Role>,
    date_order: Option<DateOrder>,
    replace: bool,
    pattern_name: Option<String>,
) -> AppResult<ingest::ImportResult> {
    let mut conn = open_project(&state, &project_id)?;
    let p = ingest::load(std::path::Path::new(&path), sheet.as_deref())?;
    let opts = ingest::CommitOptions { roles: &roles, date_order, replace, pattern_name: pattern_name.as_deref().filter(|n| !n.trim().is_empty()) };
    ingest::commit(&mut conn, &p, &opts)
}

#[tauri::command]
pub fn list_patterns(state: S<'_>, project_id: String) -> AppResult<Vec<Pattern>> {
    patterns::list(&open_project(&state, &project_id)?)
}

#[tauri::command]
pub fn update_pattern(state: S<'_>, project_id: String, id: String, name: Option<String>, roles: Option<Vec<Role>>) -> AppResult<Pattern> {
    let conn = open_project(&state, &project_id)?;
    let p = patterns::get(&conn, &id)?;
    let map = roles.map(|r| RoleMap::from_roles(&p.headers, &r));
    patterns::update(&conn, &id, name.as_deref(), map.as_ref())
}

#[tauri::command]
pub fn delete_pattern(state: S<'_>, project_id: String, id: String) -> AppResult<()> {
    patterns::delete(&open_project(&state, &project_id)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_settings_cannot_change_gateway_url_or_test_result() {
        let cur = Settings {
            gateway_url: "https://gw.example".into(),
            last_test_at: Some(1),
            last_test_ok: Some(true),
            last_test_model: Some("godev1".into()),
            ..Settings::default()
        };
        let incoming = Settings {
            gateway_url: "https://evil.example".into(),
            last_test_ok: Some(false),
            theme: "dark".into(),
            ..cur.clone()
        };
        let s = merge_settings(&cur, incoming);
        assert_eq!(s.gateway_url, "https://gw.example");
        assert_eq!(s.last_test_ok, Some(true));
        assert_eq!(s.theme, "dark");
    }

    #[test]
    fn changing_the_model_clears_the_last_test() {
        let cur = Settings { model: "godev1".into(), last_test_at: Some(1), last_test_ok: Some(true), last_test_model: Some("godev1".into()), ..Settings::default() };
        let s = merge_settings(&cur, Settings { model: "gothink1".into(), ..cur.clone() });
        assert_eq!(s.model, "gothink1");
        assert_eq!((s.last_test_at, s.last_test_ok), (None, None));
    }

    #[test]
    fn saving_the_model_that_was_just_tested_keeps_the_result() {
        // setup tests gothink1 while app.json still says godev1, then saves gothink1
        let cur = Settings { model: "godev1".into(), last_test_at: Some(5), last_test_ok: Some(true), last_test_model: Some("gothink1".into()), ..Settings::default() };
        let s = merge_settings(&cur, Settings { model: "gothink1".into(), ..cur.clone() });
        assert_eq!((s.last_test_at, s.last_test_ok), (Some(5), Some(true)));
    }
}
