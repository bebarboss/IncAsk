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
    /// classification jobs of this session, by project id
    pub jobs: Mutex<std::collections::HashMap<String, std::sync::Arc<crate::classify::Shared>>>,
    /// a .incask passed on the command line at start (double-click)
    pub pending_open: Mutex<Option<String>>,
    pub projects: Mutex<Registry>,
    pub status: Mutex<GatewayStatus>,
}

impl AppState {
    pub fn new() -> AppResult<Self> {
        std::fs::create_dir_all(config::data_dir())?;
        std::fs::create_dir_all(config::projects_dir())?;
        Ok(Self {
            settings: Mutex::new(Settings::load()),
            jobs: Mutex::new(std::collections::HashMap::new()),
            pending_open: Mutex::new(incask_arg(std::env::args())),
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
pub fn preview_taxonomy_import(state: S<'_>, project_id: String, path: String, service: Option<String>, roles: Option<Vec<String>>) -> AppResult<ImportPreview> {
    taxonomy::preview_import(&open_project(&state, &project_id)?, std::path::Path::new(&path), service.as_deref(), roles.as_deref())
}

#[tauri::command]
pub fn apply_taxonomy_import(state: S<'_>, project_id: String, path: String, service: Option<String>, roles: Option<Vec<String>>) -> AppResult<Vec<Service>> {
    taxonomy::apply_import(&mut open_project(&state, &project_id)?, std::path::Path::new(&path), service.as_deref(), roles.as_deref())
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

// ------------------------------------------------------------------ classification (SPEC §6)

use crate::classify::{self, JobConfig, Progress, Shared, TrialResult};
use std::sync::Arc;

struct TauriSink {
    app: AppHandle,
}

impl classify::Sink for TauriSink {
    fn progress(&self, p: &Progress) {
        let _ = self.app.emit("classify://progress", p);
    }
    fn finished(&self, p: &Progress) {
        if p.status == "done" {
            use tauri_plugin_notification::NotificationExt;
            let _ = self.app.notification().builder().title("IncAsk").body(format!("จัดหมวดเสร็จ {} แถว · ไม่มั่นใจ {}", p.done, p.low)).show();
        }
    }
}

fn job_config(state: &AppState, conn: &rusqlite::Connection) -> JobConfig {
    let s = state.settings.lock().clone();
    JobConfig {
        model: s.model,
        batch_size: s.batch_size as usize,
        concurrency: s.concurrency as usize,
        low_threshold: crate::db::low_threshold(conn),
        backoff_base: std::time::Duration::from_secs(2),
        restore_after: std::time::Duration::from_secs(60),
    }
}

/// Start (or continue) the project's classification job in the background.
fn spawn_job(app: &AppHandle, project_id: &str, import_id: Option<String>, kind: &str, resume_run: Option<Progress>) -> AppResult<Progress> {
    let state = app.state::<AppState>();
    if let Some(j) = state.jobs.lock().get(project_id) {
        if j.is_active() {
            return Err(AppError::new("job_running", "มีงานจัดหมวดของโปรเจกต์นี้อยู่แล้ว — หยุดหรือรอให้เสร็จก่อน"));
        }
    }
    let key = secrets::require_key()?;
    let conn = open_project(&state, project_id)?;
    let cfg = job_config(&state, &conn);
    let url = state.settings.lock().chat_url();
    let (file_name, pattern_name): (String, Option<String>) = match &import_id {
        Some(id) => conn
            .query_row(
                "SELECT COALESCE(i.file_name,''), p.name FROM imports i LEFT JOIN report_patterns p ON p.id = i.pattern_id WHERE i.id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_default(),
        None => (if kind == "reclassify" { "จัดใหม่".into() } else { String::new() }, None),
    };
    let mut p = resume_run.unwrap_or(Progress {
        run_id: format!("run-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
        project_id: project_id.to_string(),
        file_name,
        pattern_name,
        status: "running".into(),
        total: 0,
        done: 0,
        ai: 0,
        cached: 0,
        low: 0,
        error: 0,
        eta_sec: None,
        concurrency: cfg.concurrency,
        recent: vec![],
        message: None,
        tokens_in: 0,
        tokens_out: 0,
        cost: None,
    });
    p.status = "running".into();
    p.message = None;
    p.concurrency = cfg.concurrency;
    let shared = Shared::new(p);
    state.jobs.lock().insert(project_id.to_string(), shared.clone());
    let job = classify::Job {
        conn: Arc::new(Mutex::new(conn)),
        shared: shared.clone(),
        llm: classify::gateway_llm(url, key, cfg.model.clone()),
        cfg,
        sink: Arc::new(TauriSink { app: app.clone() }),
        import_id,
        kind: kind.to_string(),
    };
    tauri::async_runtime::spawn(classify::run(job));
    Ok(shared.snapshot())
}

#[tauri::command]
pub fn start_classify(app: AppHandle, project_id: String, import_id: Option<String>) -> AppResult<Progress> {
    spawn_job(&app, &project_id, import_id, "full", None)
}

/// The running job, else the project's last run (an unfinished one shows as paused).
#[tauri::command]
pub fn classify_status(state: S<'_>, project_id: String) -> AppResult<Option<Progress>> {
    if let Some(j) = state.jobs.lock().get(&project_id) {
        return Ok(Some(j.snapshot()));
    }
    classify::last_run(&open_project(&state, &project_id)?, &project_id)
}

#[tauri::command]
pub fn pause_classify(app: AppHandle, project_id: String) -> AppResult<()> {
    if let Some(j) = app.state::<AppState>().jobs.lock().get(&project_id) {
        j.pause();
        let _ = app.emit("classify://progress", j.snapshot());
    }
    Ok(())
}

/// Un-pause a job of this session, or continue an unfinished run from an earlier session.
#[tauri::command]
pub fn resume_classify(app: AppHandle, project_id: String) -> AppResult<Progress> {
    let state = app.state::<AppState>();
    let live = state.jobs.lock().get(&project_id).cloned();
    if let Some(j) = live.filter(|j| j.is_active()) {
        secrets::require_key()?;
        j.resume();
        let _ = app.emit("classify://progress", j.snapshot());
        return Ok(j.snapshot());
    }
    let conn = open_project(&state, &project_id)?;
    let resume = classify::last_run(&conn, &project_id)?.filter(|p| p.status == "paused");
    let import_id: Option<String> = match &resume {
        Some(p) => conn.query_row("SELECT import_id FROM runs WHERE id = ?1", [&p.run_id], |r| r.get(0)).unwrap_or(None),
        None => None,
    };
    drop(conn);
    spawn_job(&app, &project_id, import_id, "full", resume)
}

#[tauri::command]
pub fn cancel_classify(state: S<'_>, project_id: String) -> AppResult<()> {
    if let Some(j) = state.jobs.lock().get(&project_id) {
        j.cancel();
        return Ok(());
    }
    // an unfinished run from an earlier session: just close it
    let conn = open_project(&state, &project_id)?;
    conn.execute("UPDATE runs SET status = 'cancelled', finished_at = datetime('now') WHERE status IN ('running','paused')", [])?;
    Ok(())
}

/// "จัดใหม่": clear the chosen tickets' results and classify them again. Rows edited by a person
/// are kept unless include_human.
#[tauri::command]
pub fn reclassify(app: AppHandle, project_id: String, ticket_ids: Option<Vec<String>>, low_only: bool, include_human: bool) -> AppResult<Progress> {
    let state = app.state::<AppState>();
    {
        let conn = open_project(&state, &project_id)?;
        let thr = crate::db::low_threshold(&conn);
        let human = if include_human { "" } else { " AND source != 'human'" };
        match ticket_ids {
            Some(ids) => {
                let mut st = conn.prepare(&format!("DELETE FROM classifications WHERE ticket_id = ?1 AND source != 'unknown_service'{human}"))?;
                for id in ids {
                    st.execute([id])?;
                }
            }
            None if low_only => {
                conn.execute(&format!("DELETE FROM classifications WHERE (confidence < ?1 OR source = 'error') AND source != 'unknown_service'{human}"), [thr])?;
            }
            None => return Err(AppError::new("invalid", "เลือกแถวที่จะจัดใหม่ก่อน")),
        }
    }
    spawn_job(&app, &project_id, None, "reclassify", None)
}

/// "ลองจัด 20 แถว": 20 rows of the file spread over its services, classified but not saved.
#[tauri::command]
pub async fn classify_trial(app: AppHandle, project_id: String, path: String, sheet: Option<String>, roles: Vec<Role>, date_order: Option<DateOrder>) -> AppResult<TrialResult> {
    let key = secrets::require_key()?;
    let (services, sample, cfg, url) = {
        let state = app.state::<AppState>();
        let conn = open_project(&state, &project_id)?;
        let services = classify::load_services(&conn)?;
        let p = ingest::load(std::path::Path::new(&path), sheet.as_deref())?;
        let (order, _) = ingest::date_order_for(&p, &roles, date_order)?;
        let (recs, _) = ingest::build_records(&p, &roles, order)?;
        let mut by: Vec<(String, Vec<(String, String)>)> = vec![];
        for r in recs.into_iter().filter(|r| services.contains_key(&r.service)) {
            match by.iter_mut().find(|g| g.0 == r.service) {
                Some(g) => g.1.push((r.ticket_no, r.problem_text)),
                None => by.push((r.service.clone(), vec![(r.ticket_no, r.problem_text)])),
            }
        }
        // take rows from across the file, not just its first lines
        for g in by.iter_mut() {
            let step = (g.1.len() / 20).max(1);
            g.1 = g.1.iter().step_by(step).cloned().collect();
        }
        if by.is_empty() {
            return Err(AppError::new("no_rows", "ไม่มีแถวของเซอร์วิสที่มีหมวดหมู่ให้ลองจัด"));
        }
        let sample: Vec<(String, String, String)> = classify::spread(&by, 20).into_iter().map(|(s, (no, t))| (s, no, t)).collect();
        let cfg = job_config(&state, &conn);
        let url = state.settings.lock().chat_url();
        (services, sample, cfg, url)
    };
    let llm = classify::gateway_llm(url, key, cfg.model.clone());
    Ok(classify::trial(&llm, &services, sample, &cfg).await)
}

#[tauri::command]
pub fn get_pref(state: S<'_>, project_id: String, key: String) -> AppResult<Option<String>> {
    crate::db::get_pref(&open_project(&state, &project_id)?, &key)
}

#[tauri::command]
pub fn set_pref(state: S<'_>, project_id: String, key: String, value: String) -> AppResult<()> {
    crate::db::set_pref(&open_project(&state, &project_id)?, &key, &value)
}

// ------------------------------------------------------------------ results (SPEC §8)

#[tauri::command]
pub fn query_results(state: S<'_>, project_id: String, query: crate::results::Query) -> AppResult<crate::results::Page> {
    crate::results::query(&open_project(&state, &project_id)?, &query)
}

#[tauri::command]
pub fn source_columns(state: S<'_>, project_id: String) -> AppResult<Vec<String>> {
    crate::results::source_columns(&open_project(&state, &project_id)?)
}

/// Edit ต้นเหตุ (user | program | unclear) of one or more classified tickets.
#[tauri::command]
pub fn set_cause(state: S<'_>, project_id: String, ticket_ids: Vec<String>, cause: String) -> AppResult<usize> {
    let user = state.settings.lock().user_name.clone();
    crate::results::set_cause(&mut open_project(&state, &project_id)?, &ticket_ids, &cause, &user)
}

/// Edit the category of one or more tickets (same service). Saved as `human` by the user's name.
#[tauri::command]
pub fn set_category(state: S<'_>, project_id: String, ticket_ids: Vec<String>, fields: crate::taxonomy::Values) -> AppResult<usize> {
    let user = state.settings.lock().user_name.clone();
    crate::results::set_category(&mut open_project(&state, &project_id)?, &ticket_ids, &fields, &user)
}

// ------------------------------------------------------------------ summary / pivot (SPEC §9)

use crate::pivot::{self, Charts, Drill, PivotResult, SavedView};

#[tauri::command]
pub fn pivot_query(state: S<'_>, project_id: String, config: pivot::Config) -> AppResult<PivotResult> {
    pivot::pivot(&open_project(&state, &project_id)?, &config)
}

#[tauri::command]
pub fn pivot_drill(state: S<'_>, project_id: String, config: pivot::Config, cell: pivot::Cell, limit: usize) -> AppResult<Drill> {
    pivot::drill(&open_project(&state, &project_id)?, &config, &cell, limit)
}

#[tauri::command]
pub fn pivot_charts(state: S<'_>, project_id: String, from: String, to: String, filters: Vec<pivot::Filter>) -> AppResult<Charts> {
    pivot::charts(&open_project(&state, &project_id)?, &from, &to, &filters)
}

#[tauri::command]
pub fn pivot_values(state: S<'_>, project_id: String, field: String, from: String, to: String) -> AppResult<Vec<String>> {
    pivot::field_values(&open_project(&state, &project_id)?, &field, &from, &to)
}

#[tauri::command]
pub fn list_views(state: S<'_>, project_id: String) -> AppResult<Vec<SavedView>> {
    pivot::list_views(&open_project(&state, &project_id)?)
}

#[tauri::command]
pub fn save_view(state: S<'_>, project_id: String, id: Option<String>, name: String, config: serde_json::Value) -> AppResult<SavedView> {
    pivot::save_view(&open_project(&state, &project_id)?, id.as_deref(), &name, &config)
}

#[tauri::command]
pub fn delete_view(state: S<'_>, project_id: String, id: String) -> AppResult<()> {
    pivot::delete_view(&open_project(&state, &project_id)?, &id)
}

// ------------------------------------------------------------------ export / .incask (SPEC §10)

use crate::export::{self, incask, Scope};

fn project_meta(state: &AppState, project_id: &str) -> AppResult<(String, String)> {
    let p = state.projects.lock().get(project_id)?;
    Ok((p.name, p.color))
}

#[tauri::command]
pub fn export_default_name(state: S<'_>, project_id: String, scope: Scope, ext: String) -> AppResult<String> {
    let (name, _) = project_meta(&state, &project_id)?;
    Ok(export::default_file_name(&name, &scope, &ext))
}

#[tauri::command]
pub fn export_csv(state: S<'_>, project_id: String, scope: Scope, path: String) -> AppResult<usize> {
    let conn = open_project(&state, &project_id)?;
    // the source-file columns the user added to the results table
    let src_cols: Vec<String> = crate::db::get_pref(&conn, "results_columns")?
        .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
        .and_then(|v| v.get("srcCols").cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    export::csv_export::export(&conn, &scope, &src_cols, std::path::Path::new(&path))
}

#[tauri::command]
pub fn export_incask(app: AppHandle, project_id: String, scope: Scope, path: String) -> AppResult<incask::Manifest> {
    let state = app.state::<AppState>();
    let (name, color) = project_meta(&state, &project_id)?;
    let conn = open_project(&state, &project_id)?;
    incask::export(&conn, &scope, &name, &color, &app.package_info().version.to_string(), std::path::Path::new(&path))
}

/// The report page built from `report/` (bundled resource; `src-tauri/resources` when running from source).
fn report_template(app: &AppHandle) -> AppResult<String> {
    let mut candidates = vec![];
    if let Ok(r) = app.path().resource_dir() {
        candidates.push(r.join("resources").join("report.html"));
        candidates.push(r.join("report.html"));
    }
    candidates.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("report.html"));
    for c in candidates {
        if let Ok(t) = std::fs::read_to_string(&c) {
            if t.contains("id=\"incask-data\"") {
                return Ok(t);
            }
        }
    }
    Err(AppError::new("report", "ไม่พบแม่แบบรายงาน HTML — รัน npm run build:report แล้วลองใหม่"))
}

#[tauri::command]
pub fn export_html(app: AppHandle, project_id: String, scope: Scope, path: String) -> AppResult<usize> {
    let state = app.state::<AppState>();
    let (name, color) = project_meta(&state, &project_id)?;
    let conn = open_project(&state, &project_id)?;
    export::html::export(&conn, &scope, (&name, &color), &report_template(&app)?, std::path::Path::new(&path))
}

/// Show an exported file in Explorer.
#[tauri::command]
pub fn reveal_file(app: AppHandle, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(&path).map_err(|e| AppError::new("open", format!("เปิดโฟลเดอร์ไม่ได้: {e}")))
}

#[tauri::command]
pub fn inspect_incask(state: S<'_>, path: String, project_id: Option<String>) -> AppResult<incask::Inspect> {
    let target = match project_id {
        Some(id) => Some(open_project(&state, &id)?),
        None => None,
    };
    incask::inspect(std::path::Path::new(&path), target.as_ref())
}

#[tauri::command]
pub fn import_incask(state: S<'_>, path: String, name: Option<String>) -> AppResult<Project> {
    incask::import_new(&mut state.projects.lock(), std::path::Path::new(&path), name.as_deref())
}

#[tauri::command]
pub fn merge_incask(state: S<'_>, project_id: String, path: String, take_theirs: bool) -> AppResult<incask::MergeResult> {
    incask::merge(&mut open_project(&state, &project_id)?, std::path::Path::new(&path), take_theirs)
}

/// A `.incask` the app was started with (double-click in Explorer), handed over once.
#[tauri::command]
pub fn pending_open_file(state: S<'_>) -> Option<String> {
    state.pending_open.lock().take()
}

/// The first `.incask` path among command-line arguments.
pub fn incask_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| a.to_lowercase().ends_with(".incask"))
}

// ------------------------------------------------------------------ config backup (SPEC §12)

/// `project_ids` = None → every project.
#[tauri::command]
pub fn export_config(state: S<'_>, project_ids: Option<Vec<String>>, path: String) -> AppResult<usize> {
    crate::config_backup::export(&state.projects.lock(), project_ids.as_deref(), std::path::Path::new(&path))
}

#[tauri::command]
pub fn config_diff(state: S<'_>, path: String) -> AppResult<Vec<crate::config_backup::ProjectDiff>> {
    let file = crate::config_backup::read(std::path::Path::new(&path))?;
    crate::config_backup::diff(&state.projects.lock(), &file)
}

#[tauri::command]
pub fn config_apply(state: S<'_>, path: String) -> AppResult<Vec<crate::config_backup::ProjectDiff>> {
    let file = crate::config_backup::read(std::path::Path::new(&path))?;
    crate::config_backup::apply(&mut state.projects.lock(), &file)
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
