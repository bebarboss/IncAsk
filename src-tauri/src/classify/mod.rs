//! Classification job (SPEC §6.4): cache pass → batches of one service → N workers with
//! 429 backoff and temporary halving of concurrency → results written per batch → progress
//! every 500 ms. Pause / resume / cancel; a run left unfinished (app closed) resumes from the
//! tickets that still have no classification.
//!
//! The LLM is passed in as a function (`LlmFn`) so the whole job can be tested without a Gateway.

pub mod cache;
pub mod parse;
pub mod prompt;

use crate::errors::{AppError, AppResult};
use crate::llm::{self, ChatMessage, Completion};
use crate::taxonomy::{self, Values};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use parse::Answer;
use prompt::Cat;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub type LlmFuture = Pin<Box<dyn Future<Output = AppResult<Completion>> + Send>>;
/// (system prompt, user message) → completion
pub type LlmFn = Arc<dyn Fn(String, String) -> LlmFuture + Send + Sync>;

/// Models whose Gateway answered 400 to `response_format` (SPEC §3): asked without it from then on.
static NO_JSON_MODE: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// The real LLM: the company Gateway through `llm::complete`, temperature 0, JSON mode when the
/// model supports it. The key lives inside this closure only.
pub fn gateway_llm(url: String, key: String, model: String) -> LlmFn {
    Arc::new(move |system: String, user: String| {
        let (url, key, model) = (url.clone(), key.clone(), model.clone());
        Box::pin(async move {
            let messages = [ChatMessage::new("system", system), ChatMessage::new("user", user)];
            let json = !NO_JSON_MODE.lock().contains(&model);
            let req = |json_mode| llm::Request { url: &url, key: &key, model: &model, messages: &messages, max_tokens: None, json_mode, timeout: Duration::from_secs(180) };
            match llm::complete(&req(json)).await {
                Err(e) if json && e.status == Some(400) => {
                    NO_JSON_MODE.lock().insert(model.clone());
                    llm::complete(&req(false)).await
                }
                r => r,
            }
        })
    })
}

// ---------------------------------------------------------------- progress

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub ticket_no: String,
    pub service: String,
    pub text: String,
    pub category: String,
    pub low: bool,
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub run_id: String,
    pub project_id: String,
    pub file_name: String,
    pub pattern_name: Option<String>,
    /// running | paused | done | cancelled | failed
    pub status: String,
    pub total: usize,
    pub done: usize,
    pub ai: usize,
    pub cached: usize,
    pub low: usize,
    pub error: usize,
    pub eta_sec: Option<u64>,
    pub concurrency: usize,
    pub recent: Vec<RecentItem>,
    /// why the job paused or failed (Gateway down, key rejected …)
    pub message: Option<String>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost: Option<f64>,
}

pub trait Sink: Send + Sync {
    fn progress(&self, p: &Progress);
    fn finished(&self, p: &Progress);
}

pub struct Shared {
    pub progress: Mutex<Progress>,
    pub paused: AtomicBool,
    pub cancelled: AtomicBool,
    limit: AtomicUsize,
    fatal: Mutex<Option<AppError>>,
}

impl Shared {
    pub fn new(p: Progress) -> Arc<Shared> {
        let c = p.concurrency;
        Arc::new(Shared { progress: Mutex::new(p), paused: AtomicBool::new(false), cancelled: AtomicBool::new(false), limit: AtomicUsize::new(c), fatal: Mutex::new(None) })
    }
    pub fn snapshot(&self) -> Progress {
        self.progress.lock().clone()
    }
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        self.progress.lock().status = "paused".into();
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        let mut p = self.progress.lock();
        p.status = "running".into();
        p.message = None;
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn is_active(&self) -> bool {
        matches!(self.progress.lock().status.as_str(), "running" | "paused")
    }
}

#[derive(Debug, Clone)]
pub struct JobConfig {
    pub model: String,
    pub batch_size: usize,
    pub concurrency: usize,
    pub low_threshold: f64,
    /// first 429 wait (2 s in the app, a few ms in tests)
    pub backoff_base: Duration,
    /// how long concurrency stays halved after a 429
    pub restore_after: Duration,
}

// ---------------------------------------------------------------- per-service context

pub struct ServiceCtx {
    pub name: String,
    pub columns: Vec<String>,
    pub version: i64,
    pub cats: Vec<Cat>,
    pub codes: HashSet<String>,
    pub few_shot: Vec<(String, String)>,
}

impl ServiceCtx {
    pub fn cat(&self, code: &str) -> Option<&Cat> {
        self.cats.iter().find(|c| c.code == code)
    }
    pub fn code_of(&self, fields: &Values) -> Option<String> {
        self.cats.iter().find(|c| self.columns.iter().all(|col| c.values.get(col) == fields.get(col))).map(|c| c.code.clone())
    }
}

/// Services that can be classified (they have at least one category), by name.
pub fn load_services(conn: &Connection) -> AppResult<HashMap<String, ServiceCtx>> {
    let mut out = HashMap::new();
    for s in taxonomy::list_services(conn)? {
        let rows = taxonomy::list_taxonomy(conn, &s.id)?;
        if rows.is_empty() {
            continue;
        }
        let cats: Vec<Cat> = rows.iter().map(Cat::from_row).collect();
        let mut ctx = ServiceCtx { name: s.name.clone(), columns: s.columns.clone(), version: s.taxonomy_version, codes: cats.iter().map(|c| c.code.clone()).collect(), cats, few_shot: vec![] };
        // up to 5 latest human corrections of this service, as "text → code"
        let mut st = conn.prepare(
            "SELECT t.problem_text, c.fields_json FROM classifications c JOIN tickets t ON t.id = c.ticket_id
             WHERE c.source = 'human' AND t.service = ?1 ORDER BY c.updated_at DESC LIMIT 30",
        )?;
        let rows = st.query_map([&s.name], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        for r in rows {
            let (text, f) = r?;
            if let Some(code) = f.and_then(|j| serde_json::from_str::<Values>(&j).ok()).and_then(|v| ctx.code_of(&v)) {
                ctx.few_shot.push((text, code));
            }
            if ctx.few_shot.len() >= 5 {
                break;
            }
        }
        out.insert(s.name, ctx);
    }
    Ok(out)
}

// ---------------------------------------------------------------- one batch

pub struct Item {
    pub ticket_id: String,
    pub ticket_no: String,
    pub text: String,
    pub cache_key: String,
}

pub struct BatchOutcome {
    /// item index → answer
    pub answers: HashMap<usize, Answer>,
    pub errors: Vec<usize>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost: Option<f64>,
}

fn jitter_ms() -> u64 {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0) as u64;
    (n ^ (n >> 7)) % 1000
}

/// Wait before retry `attempt` (0-based): base·2^attempt, at most 60 s, plus up to 1 s jitter.
pub fn backoff(base: Duration, attempt: u32) -> Duration {
    let d = base.saturating_mul(1 << attempt.min(10)).min(Duration::from_secs(60));
    let j = if base >= Duration::from_millis(500) { jitter_ms() } else { 0 };
    d + Duration::from_millis(j)
}

/// One LLM call with up to 5 retries on 429 / 5xx. `on_429` is told each time a 429 arrives.
async fn call_with_retry(llm: &LlmFn, system: &str, user: &str, base: Duration, on_429: &(dyn Fn() + Send + Sync)) -> AppResult<Completion> {
    let mut attempt = 0;
    loop {
        match llm(system.to_string(), user.to_string()).await {
            Ok(c) => return Ok(c),
            Err(e) => {
                let retryable = matches!(e.status, Some(429) | Some(500..=599));
                if !retryable || attempt >= 5 {
                    return Err(e);
                }
                if e.status == Some(429) {
                    on_429();
                }
                tokio::time::sleep(backoff(base, attempt)).await;
                attempt += 1;
            }
        }
    }
}

/// Ask for one batch; missing/invalid rows are asked again once, then reported as errors.
pub async fn ask_batch(llm: &LlmFn, svc: &ServiceCtx, items: &[Item], base: Duration, on_429: &(dyn Fn() + Send + Sync)) -> AppResult<BatchOutcome> {
    let system = prompt::system_prompt(&svc.name, &svc.columns, &svc.cats, &svc.few_shot);
    let ids: Vec<String> = (1..=items.len()).map(|i| format!("r{i}")).collect();
    let mut out = BatchOutcome { answers: HashMap::new(), errors: vec![], tokens_in: 0, tokens_out: 0, cost: None };
    let mut ask: Vec<String> = ids.clone();
    for round in 0..2 {
        let msg: Vec<(String, String)> = ask.iter().map(|id| (id.clone(), items[id[1..].parse::<usize>().unwrap_or(1) - 1].text.clone())).collect();
        let c = call_with_retry(llm, &system, &prompt::user_message(&msg), base, on_429).await?;
        out.tokens_in += c.prompt_tokens;
        out.tokens_out += c.completion_tokens;
        if let Some(cost) = c.cost {
            *out.cost.get_or_insert(0.0) += cost;
        }
        let (answers, missing) = parse::parse_reply(&c.content, &ask, &svc.codes);
        for a in answers {
            let idx = a.id[1..].parse::<usize>().unwrap_or(1) - 1;
            out.answers.insert(idx, a);
        }
        if missing.is_empty() {
            break;
        }
        if round == 1 {
            out.errors = missing.iter().map(|id| id[1..].parse::<usize>().unwrap_or(1) - 1).collect();
        }
        ask = missing;
    }
    Ok(out)
}

// ---------------------------------------------------------------- writing

#[allow(clippy::too_many_arguments)]
fn write_answer(conn: &Connection, ticket_id: &str, fields: Option<&str>, conf: f64, reason: &str, cause: Option<&str>, source: &str, model: &str, version: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO classifications(ticket_id, fields_json, ai_fields_json, confidence, reason, source, model, taxonomy_version, updated_at, edited_by, cause, ai_cause)
         VALUES(?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), NULL, ?8, ?8)
         ON CONFLICT(ticket_id) DO UPDATE SET fields_json = excluded.fields_json, ai_fields_json = excluded.ai_fields_json,
           confidence = excluded.confidence, reason = excluded.reason, source = excluded.source, model = excluded.model,
           taxonomy_version = excluded.taxonomy_version, updated_at = excluded.updated_at, edited_by = NULL,
           cause = excluded.cause, ai_cause = excluded.ai_cause",
        params![ticket_id, fields, conf, reason, source, model, version, cause],
    )?;
    Ok(())
}

fn write_error(conn: &Connection, ticket_id: &str, model: &str, version: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO classifications(ticket_id, fields_json, ai_fields_json, confidence, reason, source, model, taxonomy_version, updated_at)
         VALUES(?1, NULL, NULL, NULL, 'AI ตอบไม่ถูกรูปแบบ 2 ครั้ง', 'error', ?2, ?3, datetime('now'))
         ON CONFLICT(ticket_id) DO UPDATE SET fields_json = NULL, ai_fields_json = NULL, confidence = NULL, cause = NULL, ai_cause = NULL,
           reason = excluded.reason, source = 'error', model = excluded.model, taxonomy_version = excluded.taxonomy_version, updated_at = excluded.updated_at",
        params![ticket_id, model, version],
    )?;
    Ok(())
}

pub fn save_run(conn: &Connection, p: &Progress, import_id: Option<&str>, kind: &str, model: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO runs(id, import_id, kind, started_at, model, status, rows_total, rows_done, rows_cached, rows_low, rows_error, tokens_in, tokens_out, cost)
         VALUES(?1, ?2, ?3, datetime('now'), ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, rows_total = excluded.rows_total, rows_done = excluded.rows_done,
           rows_cached = excluded.rows_cached, rows_low = excluded.rows_low, rows_error = excluded.rows_error, tokens_in = excluded.tokens_in,
           tokens_out = excluded.tokens_out, cost = excluded.cost,
           finished_at = CASE WHEN excluded.status IN ('done','cancelled','failed') THEN datetime('now') ELSE NULL END",
        params![p.run_id, import_id, kind, model, p.status, p.total as i64, p.done as i64, p.cached as i64, p.low as i64, p.error as i64, p.tokens_in as i64, p.tokens_out as i64, p.cost],
    )?;
    Ok(())
}

/// The latest run of a project as a Progress (for the classify page after a restart).
/// A run still marked running belongs to a closed app → reported as paused.
pub fn last_run(conn: &Connection, project_id: &str) -> AppResult<Option<Progress>> {
    let row = conn
        .query_row(
            "SELECT r.id, r.status, r.rows_total, r.rows_done, r.rows_cached, r.rows_low, r.rows_error, r.tokens_in, r.tokens_out, r.cost,
                    COALESCE(i.file_name, ''), p.name, r.kind
             FROM runs r LEFT JOIN imports i ON i.id = r.import_id LEFT JOIN report_patterns p ON p.id = i.pattern_id
             WHERE r.kind != 'trial20' ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1",
            [],
            |r| {
                let status: String = r.get(1)?;
                let kind: String = r.get(12)?;
                let file: String = r.get(10)?;
                Ok(Progress {
                    run_id: r.get(0)?,
                    project_id: project_id.to_string(),
                    file_name: if kind == "reclassify" && file.is_empty() { "จัดใหม่".into() } else { file },
                    pattern_name: r.get(11)?,
                    status: if status == "running" { "paused".into() } else { status },
                    total: r.get::<_, i64>(2)? as usize,
                    done: r.get::<_, i64>(3)? as usize,
                    ai: (r.get::<_, i64>(3)? - r.get::<_, i64>(4)? - r.get::<_, i64>(6)?).max(0) as usize,
                    cached: r.get::<_, i64>(4)? as usize,
                    low: r.get::<_, i64>(5)? as usize,
                    error: r.get::<_, i64>(6)? as usize,
                    eta_sec: None,
                    concurrency: 0,
                    recent: vec![],
                    message: None,
                    tokens_in: r.get::<_, i64>(7)? as u64,
                    tokens_out: r.get::<_, i64>(8)? as u64,
                    cost: r.get(9)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Tickets that still need the LLM: never classified, or flagged unknown_service whose service
/// now exists. Rows of services without categories are left for later.
pub fn pending(conn: &Connection, services: &HashMap<String, ServiceCtx>) -> AppResult<Vec<(String, String, String, String)>> {
    let mut st = conn.prepare(
        "SELECT t.id, t.ticket_no, t.service, t.problem_text FROM tickets t LEFT JOIN classifications c ON c.ticket_id = t.id
         WHERE c.ticket_id IS NULL OR c.source = 'unknown_service' ORDER BY t.date, t.ticket_no",
    )?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    let mut out = vec![];
    for r in rows {
        let r = r?;
        if services.contains_key(&r.2) {
            out.push(r);
        }
    }
    Ok(out)
}

fn short(text: &str) -> String {
    let t: String = text.chars().take(160).collect();
    if text.chars().count() > 160 { format!("{t}…") } else { t }
}

fn push_recent(p: &mut Progress, item: RecentItem) {
    p.recent.insert(0, item);
    p.recent.truncate(8);
}

// ---------------------------------------------------------------- the job

pub struct Job {
    pub conn: Arc<Mutex<Connection>>,
    pub shared: Arc<Shared>,
    pub cfg: JobConfig,
    pub llm: LlmFn,
    pub sink: Arc<dyn Sink>,
    pub import_id: Option<String>,
    pub kind: String,
}

struct Batch {
    service: String,
    items: Vec<Item>,
}

type Plan = (Arc<HashMap<String, ServiceCtx>>, VecDeque<Batch>);

pub async fn run(job: Job) {
    let Job { conn, shared, cfg, llm, sink, import_id, kind } = job;
    let started = Instant::now();
    // ---- plan + cache pass
    let plan: AppResult<Plan> = (|| {
        let c = conn.lock();
        let services = load_services(&c)?;
        let todo = pending(&c, &services)?;
        let mut by_service: HashMap<String, Vec<Item>> = HashMap::new();
        {
            let mut p = shared.progress.lock();
            p.total = p.done + todo.len();
        }
        for (ticket_id, ticket_no, service, text) in todo {
            let svc = &services[&service];
            let key = cache::key(&service, &text, svc.version, &cfg.model);
            if let Some(hit) = cache::get(&c, &key)? {
                let conf = hit.confidence.unwrap_or(0.0);
                write_answer(&c, &ticket_id, hit.fields_json.as_deref(), conf, hit.reason.as_deref().unwrap_or(""), hit.cause.as_deref(), "cache", &cfg.model, svc.version)?;
                let label = hit.fields_json.as_deref().and_then(|j| serde_json::from_str::<Values>(j).ok()).map(|v| svc.columns.iter().map(|c| v.get(c).cloned().unwrap_or_default()).collect::<Vec<_>>().join(" › ")).unwrap_or_else(|| "—".into());
                let mut p = shared.progress.lock();
                p.done += 1;
                p.cached += 1;
                let low = conf < cfg.low_threshold;
                if low {
                    p.low += 1;
                }
                push_recent(&mut p, RecentItem { ticket_no, service: service.clone(), text: short(&text), category: label, low, cached: true });
                continue;
            }
            by_service.entry(service).or_default().push(Item { ticket_id, ticket_no, text, cache_key: key });
        }
        let mut q = VecDeque::new();
        let mut names: Vec<String> = by_service.keys().cloned().collect();
        names.sort();
        for name in names {
            let mut items = by_service.remove(&name).unwrap_or_default();
            while !items.is_empty() {
                let rest = items.split_off(items.len().min(cfg.batch_size.max(1)));
                q.push_back(Batch { service: name.clone(), items });
                items = rest;
            }
        }
        save_run(&c, &shared.progress.lock(), import_id.as_deref(), &kind, &cfg.model)?;
        Ok((Arc::new(services), q))
    })();
    let (services, queue) = match plan {
        Ok(x) => x,
        Err(e) => {
            let mut p = shared.progress.lock();
            p.status = "failed".into();
            p.message = Some(e.message);
            let snap = p.clone();
            drop(p);
            let _ = save_run(&conn.lock(), &snap, import_id.as_deref(), &kind, &cfg.model);
            sink.finished(&snap);
            return;
        }
    };
    let queue = Arc::new(Mutex::new(queue));
    let done_at_start = shared.progress.lock().done;

    // ---- progress emitter
    let emitter = {
        let (shared, sink) = (shared.clone(), sink.clone());
        tokio::spawn(async move {
            let mut last: Option<Progress> = None;
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let p = shared.snapshot();
                if last.as_ref() != Some(&p) {
                    sink.progress(&p);
                    last = Some(p);
                }
            }
        })
    };

    // ---- workers
    let mut handles = vec![];
    for worker in 0..cfg.concurrency.max(1) {
        let (shared, queue, llm, conn, services, cfg) = (shared.clone(), queue.clone(), llm.clone(), conn.clone(), services.clone(), cfg.clone());
        let (import_id, kind) = (import_id.clone(), kind.clone());
        handles.push(tokio::spawn(async move {
            loop {
                if shared.cancelled.load(Ordering::SeqCst) {
                    break;
                }
                if shared.paused.load(Ordering::SeqCst) || worker >= shared.limit.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
                let Some(batch) = queue.lock().pop_front() else { break };
                let svc = &services[&batch.service];
                let on_429 = {
                    let shared = shared.clone();
                    let (full, restore) = (cfg.concurrency, cfg.restore_after);
                    move || {
                        let cur = shared.limit.load(Ordering::SeqCst);
                        shared.limit.store((cur / 2).max(1), Ordering::SeqCst);
                        let shared = shared.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(restore).await;
                            shared.limit.store(full, Ordering::SeqCst);
                        });
                    }
                };
                match ask_batch(&llm, svc, &batch.items, cfg.backoff_base, &on_429).await {
                    Ok(out) => {
                        let c = conn.lock();
                        let mut p = shared.progress.lock();
                        p.tokens_in += out.tokens_in;
                        p.tokens_out += out.tokens_out;
                        if let Some(cost) = out.cost {
                            *p.cost.get_or_insert(0.0) += cost;
                        }
                        for (i, item) in batch.items.iter().enumerate() {
                            if let Some(a) = out.answers.get(&i) {
                                let cat = a.code.as_deref().and_then(|code| svc.cat(code));
                                let fields = cat.map(|c| serde_json::to_string(&c.values).unwrap_or_default());
                                let ok = write_answer(&c, &item.ticket_id, fields.as_deref(), a.confidence, &a.reason, a.cause.as_deref(), "ai", &cfg.model, svc.version)
                                    .and_then(|_| cache::put(&c, &item.cache_key, fields.as_deref(), a.confidence, &a.reason, a.cause.as_deref()));
                                if ok.is_err() {
                                    p.error += 1;
                                    p.done += 1;
                                    continue;
                                }
                                let low = a.confidence < cfg.low_threshold;
                                p.ai += 1;
                                p.done += 1;
                                if low {
                                    p.low += 1;
                                }
                                let label = cat.map(|c| c.label(&svc.columns)).unwrap_or_else(|| "—".into());
                                push_recent(&mut p, RecentItem { ticket_no: item.ticket_no.clone(), service: svc.name.clone(), text: short(&item.text), category: label, low, cached: false });
                            } else {
                                let _ = write_error(&c, &item.ticket_id, &cfg.model, svc.version);
                                p.error += 1;
                                p.done += 1;
                            }
                        }
                        let elapsed = started.elapsed().as_secs_f64();
                        let rate = (p.done - done_at_start) as f64 / elapsed.max(0.1);
                        p.eta_sec = (rate > 0.0).then(|| ((p.total - p.done) as f64 / rate).round() as u64);
                        let snap = p.clone();
                        drop(p);
                        let _ = save_run(&c, &snap, import_id.as_deref(), &kind, &cfg.model);
                    }
                    Err(e) => {
                        // Gateway down / key rejected / quota exhausted: keep the batch, pause the job
                        // and say why — the user resumes once it's fixed. Nothing is marked as error.
                        queue.lock().push_front(batch);
                        if !shared.paused.swap(true, Ordering::SeqCst) {
                            let mut p = shared.progress.lock();
                            p.status = "paused".into();
                            p.message = Some(e.message.clone());
                            *shared.fatal.lock() = Some(e);
                        }
                    }
                }
            }
        }));
    }
    // a paused job keeps its workers parked until resumed or cancelled
    for h in handles {
        let _ = h.await;
    }
    emitter.abort();
    let snap = {
        let mut p = shared.progress.lock();
        p.status = if shared.cancelled.load(Ordering::SeqCst) { "cancelled".into() } else { "done".into() };
        p.eta_sec = Some(0);
        p.clone()
    };
    let _ = save_run(&conn.lock(), &snap, import_id.as_deref(), &kind, &cfg.model);
    sink.progress(&snap);
    sink.finished(&snap);
}

// ---------------------------------------------------------------- trial (ลองจัด 20 แถว)

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialItem {
    pub ticket_no: String,
    pub service: String,
    pub text: String,
    pub category: Option<String>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    /// ต้นเหตุ: user | program | unclear
    pub cause: Option<String>,
    pub low: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialResult {
    pub items: Vec<TrialItem>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost: Option<f64>,
    pub elapsed_ms: u64,
}

/// Up to `n` records spread over the services (round-robin), so every service is tried.
pub fn spread<T: Clone>(by_service: &[(String, Vec<T>)], n: usize) -> Vec<(String, T)> {
    let mut out = vec![];
    let mut i = 0;
    while out.len() < n {
        let mut any = false;
        for (s, items) in by_service {
            if let Some(x) = items.get(i) {
                out.push((s.clone(), x.clone()));
                any = true;
                if out.len() == n {
                    break;
                }
            }
        }
        if !any {
            break;
        }
        i += 1;
    }
    out
}

/// Classify a sample without writing anything (SPEC §6.4 "ลองจัด 20 แถว").
pub async fn trial(llm: &LlmFn, services: &HashMap<String, ServiceCtx>, sample: Vec<(String, String, String)>, cfg: &JobConfig) -> TrialResult {
    let t = Instant::now();
    let mut res = TrialResult { items: vec![], tokens_in: 0, tokens_out: 0, cost: None, elapsed_ms: 0 };
    let mut groups: Vec<(String, Vec<(String, String)>)> = vec![];
    for (service, ticket_no, text) in sample {
        match groups.iter_mut().find(|g| g.0 == service) {
            Some(g) => g.1.push((ticket_no, text)),
            None => groups.push((service, vec![(ticket_no, text)])),
        }
    }
    let noop = || {};
    for (service, items) in groups {
        let svc = &services[&service];
        for chunk in items.chunks(cfg.batch_size.max(1)) {
            let batch: Vec<Item> = chunk.iter().map(|(no, text)| Item { ticket_id: String::new(), ticket_no: no.clone(), text: text.clone(), cache_key: String::new() }).collect();
            match ask_batch(llm, svc, &batch, cfg.backoff_base, &noop).await {
                Ok(out) => {
                    res.tokens_in += out.tokens_in;
                    res.tokens_out += out.tokens_out;
                    if let Some(c) = out.cost {
                        *res.cost.get_or_insert(0.0) += c;
                    }
                    for (i, item) in batch.iter().enumerate() {
                        let a = out.answers.get(&i);
                        res.items.push(TrialItem {
                            ticket_no: item.ticket_no.clone(),
                            service: service.clone(),
                            text: short(&item.text),
                            category: a.and_then(|a| a.code.as_deref()).and_then(|c| svc.cat(c)).map(|c| c.label(&svc.columns)),
                            confidence: a.map(|a| a.confidence),
                            reason: a.map(|a| a.reason.clone()),
                            cause: a.and_then(|a| a.cause.clone()),
                            low: a.is_none_or_low(cfg.low_threshold),
                            error: a.is_none().then(|| "AI ตอบไม่ถูกรูปแบบ".to_string()),
                        });
                    }
                }
                Err(e) => {
                    for item in &batch {
                        res.items.push(TrialItem { ticket_no: item.ticket_no.clone(), service: service.clone(), text: short(&item.text), category: None, confidence: None, reason: None, cause: None, low: true, error: Some(e.message.clone()) });
                    }
                }
            }
        }
    }
    res.elapsed_ms = t.elapsed().as_millis() as u64;
    res
}

trait LowExt {
    fn is_none_or_low(&self, threshold: f64) -> bool;
}
impl LowExt for Option<&Answer> {
    fn is_none_or_low(&self, threshold: f64) -> bool {
        self.map_or(true, |a| a.confidence < threshold)
    }
}

#[cfg(test)]
mod tests;
