//! สรุปวิเคราะห์รายหมวดด้วย AI: for each category with tickets in a period, the AI reads a sample of
//! their problem texts (only the columns chosen as ปัญหา — the same data classification sends) plus
//! the counts per week, and writes: summary, symptoms, likely root cause, how it was resolved and
//! how to reduce it. Results are saved per (service, category, period) and can be redone.

use crate::classify::{self, LlmFn};
use crate::errors::{AppError, AppResult};
use crate::export::Scope;
use crate::taxonomy::{self, Values};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Tickets shown to the AI per category, spread over the period.
pub const SAMPLE: usize = 50;
/// Characters kept from each ticket's text.
const TEXT_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Analysis {
    pub summary: String,
    pub symptoms: String,
    pub root_cause: String,
    pub resolution: String,
    pub prevention: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub service: String,
    pub values: Values,
    /// category path "a › b › c"
    pub label: String,
    pub from: String,
    pub to: String,
    /// tickets in the category and period when it was analysed
    pub tickets: u64,
    pub analysis: Analysis,
    pub model: String,
    pub created_at: String,
}

/// A category to analyse.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatKey {
    pub service: String,
    pub values: Values,
}

#[derive(Debug, Clone)]
pub struct Input {
    pub key: CatKey,
    pub label: String,
    pub cause: Option<String>,
    pub total: u64,
    /// ("Oct 2026 สัปดาห์ 1 (1–4)", n)
    pub weekly: Vec<(String, u64)>,
    /// (date, text)
    pub samples: Vec<(String, String)>,
}

/// Every category of the period that has tickets (largest first), or only `only`.
pub fn gather(conn: &Connection, scope: &Scope, only: Option<&[CatKey]>) -> AppResult<Vec<Input>> {
    let mut out = vec![];
    for svc in taxonomy::list_services(conn)? {
        if scope.service.as_deref().is_some_and(|s| !s.is_empty() && s != svc.name) {
            continue;
        }
        for row in taxonomy::list_taxonomy(conn, &svc.id)? {
            let key = CatKey { service: svc.name.clone(), values: row.values.clone() };
            if only.is_some_and(|o| !o.contains(&key)) {
                continue;
            }
            let json = serde_json::to_string(&row.values)?;
            let mut st = conn.prepare_cached(
                "SELECT t.date, t.problem_text FROM tickets t JOIN classifications c ON c.ticket_id = t.id
                 WHERE t.service = ?1 AND c.fields_json = ?2 AND t.month BETWEEN ?3 AND ?4 ORDER BY t.date, t.ticket_no",
            )?;
            let all: Vec<(String, String)> = st.query_map(params![svc.name, json, scope.from, scope.to], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            if all.is_empty() {
                continue;
            }
            let mut weekly: Vec<(String, u64)> = vec![];
            for (d, _) in &all {
                let w = week_label(d);
                match weekly.last_mut() {
                    Some((l, n)) if *l == w => *n += 1,
                    _ => weekly.push((w, 1)),
                }
            }
            let step = (all.len() as f64 / SAMPLE as f64).max(1.0);
            let samples = (0..all.len().min(SAMPLE))
                .map(|i| {
                    let (d, t) = &all[((i as f64) * step) as usize];
                    (d.clone(), t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(TEXT_CHARS).collect())
                })
                .collect();
            out.push(Input {
                label: svc.columns.iter().map(|c| row.values.get(c).cloned().unwrap_or_default()).collect::<Vec<_>>().join(" › "),
                cause: row.cause.clone(),
                total: all.len() as u64,
                weekly,
                samples,
                key,
            });
        }
    }
    out.sort_by_key(|i| std::cmp::Reverse(i.total));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatCount {
    pub service: String,
    pub values: Values,
    pub label: String,
    pub cause: Option<String>,
    pub count: u64,
}

/// Categories with tickets in the period, largest first (one GROUP BY, no ticket limit).
pub fn categories(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<CatCount>> {
    let mut st = conn.prepare(
        "SELECT t.service, c.fields_json, COUNT(*) FROM tickets t JOIN classifications c ON c.ticket_id = t.id
         WHERE t.month BETWEEN ?1 AND ?2 AND c.fields_json IS NOT NULL GROUP BY 1, 2",
    )?;
    let rows: Vec<(String, String, i64)> = st.query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    let services = taxonomy::list_services(conn)?;
    let mut out: Vec<CatCount> = vec![];
    for svc in &services {
        let tax = taxonomy::list_taxonomy(conn, &svc.id)?;
        for (s, j, n) in rows.iter().filter(|r| r.0 == svc.name) {
            let v: Values = serde_json::from_str(j).unwrap_or_default();
            let Some(row) = tax.iter().find(|r| svc.columns.iter().all(|c| r.values.get(c) == v.get(c))) else { continue };
            match out.iter_mut().find(|c| c.service == *s && c.values == row.values) {
                Some(c) => c.count += *n as u64,
                None => out.push(CatCount {
                    service: s.clone(),
                    label: svc.columns.iter().map(|c| row.values.get(c).cloned().unwrap_or_default()).collect::<Vec<_>>().join(" › "),
                    values: row.values.clone(),
                    cause: row.cause.clone(),
                    count: *n as u64,
                }),
            }
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.count));
    Ok(out)
}

/// "Oct 2026 สัปดาห์ 1 (1–4)" — weeks Monday first, cut at the month edge (as everywhere else).
fn week_label(date: &str) -> String {
    const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (Some(y), Some(m), Some(d)) = (date.get(0..4).and_then(|s| s.parse::<i32>().ok()), date.get(5..7).and_then(|s| s.parse::<u32>().ok()), date.get(8..10).and_then(|s| s.parse::<u32>().ok())) else {
        return date.to_string();
    };
    let weeks = crate::export::analysis::weeks_of(y, m.clamp(1, 12));
    let (i, (a, b)) = weeks.iter().enumerate().find(|(_, (a, b))| (*a..=*b).contains(&d)).map(|(i, w)| (i, *w)).unwrap_or((0, (1, 1)));
    format!("{} {y} สัปดาห์ {} ({a}–{b})", MON[(m.clamp(1, 12) - 1) as usize], i + 1)
}

pub fn system_prompt() -> String {
    "คุณเป็นนักวิเคราะห์ปัญหาของทีม Helpdesk อ่านทิกเก็ตตัวอย่างของหมวดเดียว แล้วสรุปเพื่อใช้ในที่ประชุมสรุปปัญหารายเดือน\n\
     ใช้เฉพาะข้อมูลที่อยู่ในทิกเก็ต ห้ามเดาเกินข้อมูล ถ้าข้อมูลไม่พอให้เขียนว่า \"ข้อมูลไม่พอ\"\n\
     ห้ามใส่ชื่อคน รหัสพนักงาน อีเมล เบอร์โทร หรือเลขทิกเก็ตในคำตอบ\n\
     เขียนภาษาไทย กระชับ แต่ละช่องไม่เกิน 3 ข้อ ขึ้นต้นข้อด้วย \"- \"\n\
     ตอบเป็น JSON เท่านั้น: {\"summary\":\"สรุป 1–2 ประโยค รวมแนวโน้มจากยอดรายสัปดาห์ถ้ามีจุดที่เด่น\",\
     \"symptoms\":\"อาการที่พบบ่อย\",\"root_cause\":\"สาเหตุที่น่าจะเป็น\",\
     \"resolution\":\"วิธีที่แก้ไขในทิกเก็ต หรือควรแก้\",\"prevention\":\"ข้อเสนอเพื่อลดจำนวนเคส\"}"
        .to_string()
}

#[derive(Serialize)]
struct Msg<'a> {
    category: &'a str,
    classification: &'a str,
    period: String,
    total_tickets: u64,
    weekly_counts: Vec<String>,
    tickets: Vec<String>,
}

pub fn user_message(i: &Input, scope: &Scope) -> String {
    let m = Msg {
        category: &i.label,
        classification: match i.cause.as_deref() {
            Some("user") => "ผู้ใช้ (User)",
            Some("program") => "โปรแกรม (Program/Software)",
            Some("unclear") => "ไม่ชัดเจน",
            _ => "ไม่ได้กำหนด",
        },
        period: format!("{} ถึง {}", scope.from, scope.to),
        total_tickets: i.total,
        weekly_counts: i.weekly.iter().map(|(w, n)| format!("{w}: {n}")).collect(),
        tickets: i.samples.iter().map(|(d, t)| format!("[{d}] {t}")).collect(),
    };
    serde_json::to_string(&m).unwrap_or_default()
}

/// The model's JSON → Analysis (snake_case or camelCase keys; arrays joined as "- " lines).
pub fn parse(text: &str) -> Option<Analysis> {
    let v = classify::parse::extract_json(text)?;
    let field = |names: &[&str]| -> String {
        names
            .iter()
            .find_map(|n| v.get(*n))
            .map(|x| match x {
                serde_json::Value::String(s) => s.trim().to_string(),
                serde_json::Value::Array(a) => a.iter().filter_map(|y| y.as_str()).map(|s| format!("- {}", s.trim().trim_start_matches("- "))).collect::<Vec<_>>().join("\n"),
                _ => String::new(),
            })
            .unwrap_or_default()
    };
    let a = Analysis {
        summary: field(&["summary"]),
        symptoms: field(&["symptoms"]),
        root_cause: field(&["root_cause", "rootCause"]),
        resolution: field(&["resolution"]),
        prevention: field(&["prevention"]),
    };
    (!a.summary.is_empty() || !a.root_cause.is_empty()).then_some(a)
}

/// Text for the Excel "สรุปหารือ" column.
pub fn as_note(a: &Analysis) -> String {
    let mut parts = vec![a.summary.clone()];
    for (h, v) in [("อาการ", &a.symptoms), ("สาเหตุ", &a.root_cause), ("การแก้ไข", &a.resolution), ("ข้อเสนอ", &a.prevention)] {
        if !v.trim().is_empty() {
            parts.push(format!("{h}:\n{}", v.trim()));
        }
    }
    parts.retain(|p| !p.trim().is_empty());
    parts.join("\n")
}

pub fn save(conn: &Connection, i: &Input, scope: &Scope, a: &Analysis, model: &str, tokens: (u64, u64)) -> AppResult<()> {
    conn.execute(
        "INSERT INTO insights(id, service, values_json, period_from, period_to, tickets, result_json, model, created_at, tokens_in, tokens_out)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?9, ?10)
         ON CONFLICT(service, values_json, period_from, period_to) DO UPDATE SET tickets = excluded.tickets, result_json = excluded.result_json,
           model = excluded.model, created_at = excluded.created_at, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out",
        params![
            format!("in-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            i.key.service,
            serde_json::to_string(&i.key.values)?,
            scope.from,
            scope.to,
            i.total as i64,
            serde_json::to_string(a)?,
            model,
            tokens.0 as i64,
            tokens.1 as i64
        ],
    )?;
    Ok(())
}

/// Saved analyses of a period (exactly that period), with the category path of today's table.
pub fn list(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<Insight>> {
    let services = taxonomy::list_services(conn)?;
    let mut st = conn.prepare(
        "SELECT service, values_json, period_from, period_to, tickets, result_json, COALESCE(model,''), COALESCE(created_at,'')
         FROM insights WHERE period_from = ?1 AND period_to = ?2 ORDER BY tickets DESC",
    )?;
    let rows = st.query_map(params![from, to], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?))
    })?;
    let mut out = vec![];
    for r in rows {
        let (service, vj, from, to, tickets, rj, model, created_at) = r?;
        let values: Values = serde_json::from_str(&vj).unwrap_or_default();
        let cols = services.iter().find(|s| s.name == service).map(|s| s.columns.clone()).unwrap_or_else(|| values.keys().cloned().collect());
        out.push(Insight {
            label: cols.iter().filter_map(|c| values.get(c).cloned()).collect::<Vec<_>>().join(" › "),
            service,
            values,
            from,
            to,
            tickets: tickets as u64,
            analysis: serde_json::from_str(&rj).unwrap_or_default(),
            model,
            created_at,
        });
    }
    Ok(out)
}

/// The note for a category in the Excel export: that exact period, else its latest analysis
/// (marked with the period it covers).
pub fn note_for(conn: &Connection, service: &str, values: &Values, from: &str, to: &str) -> AppResult<Option<String>> {
    let vj = serde_json::to_string(values)?;
    let mut st = conn.prepare_cached(
        "SELECT result_json, period_from, period_to FROM insights WHERE service = ?1 AND values_json = ?2
         ORDER BY (period_from = ?3 AND period_to = ?4) DESC, created_at DESC LIMIT 1",
    )?;
    let mut rows = st.query(params![service, vj, from, to])?;
    Ok(match rows.next()? {
        Some(r) => {
            let a: Analysis = serde_json::from_str(&r.get::<_, String>(0)?).unwrap_or_default();
            let (f, t): (String, String) = (r.get(1)?, r.get(2)?);
            let note = as_note(&a);
            Some(if f == from && t == to { note } else { format!("(วิเคราะห์ช่วง {f} ถึง {t})\n{note}") })
        }
        None => None,
    })
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub done: usize,
    pub failed: usize,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost: Option<f64>,
    /// "<category>: <message>" for each failure
    pub errors: Vec<String>,
}

/// Saves one answer: (input, analysis, (tokens in, tokens out)).
pub type SaveFn = Arc<dyn Fn(&Input, &Analysis, (u64, u64)) -> AppResult<()> + Send + Sync>;

/// Ask for every input, `concurrency` at a time; each answer is saved by `save_one` as it arrives.
/// `on_progress(done, total)` after each category. A key/quota/network error stops the rest.
pub async fn run(
    llm: LlmFn,
    inputs: Vec<Input>,
    scope: Scope,
    concurrency: usize,
    base: Duration,
    save_one: SaveFn,
    on_progress: Arc<dyn Fn(usize, usize) + Send + Sync>,
) -> RunResult {
    let total = inputs.len();
    let queue = Arc::new(parking_lot::Mutex::new(inputs.into_iter().collect::<std::collections::VecDeque<_>>()));
    let result = Arc::new(parking_lot::Mutex::new(RunResult::default()));
    let finished = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let system = system_prompt();
    let mut handles = vec![];
    for _ in 0..concurrency.clamp(1, 4) {
        let (queue, result, finished, stop, llm, scope, system, save_one, on_progress) =
            (queue.clone(), result.clone(), finished.clone(), stop.clone(), llm.clone(), scope.clone(), system.clone(), save_one.clone(), on_progress.clone());
        handles.push(tokio::spawn(async move {
            loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let Some(input) = queue.lock().pop_front() else { break };
                let noop = || {};
                let outcome = classify::call_with_retry(&llm, &system, &user_message(&input, &scope), base, &noop).await;
                {
                    let mut r = result.lock();
                    match outcome {
                        Ok(c) => {
                            r.tokens_in += c.prompt_tokens;
                            r.tokens_out += c.completion_tokens;
                            if let Some(x) = c.cost {
                                *r.cost.get_or_insert(0.0) += x;
                            }
                            match parse(&c.content).ok_or_else(|| AppError::new("bad_answer", "AI ตอบไม่ถูกรูปแบบ")).and_then(|a| save_one(&input, &a, (c.prompt_tokens, c.completion_tokens))) {
                                Ok(()) => r.done += 1,
                                Err(e) => {
                                    r.failed += 1;
                                    r.errors.push(format!("{}: {}", input.label, e.message));
                                }
                            }
                        }
                        Err(e) => {
                            r.failed += 1;
                            r.errors.push(format!("{}: {}", input.label, e.message));
                            // the Gateway / key / quota won't get better for the next category
                            if matches!(e.status, Some(401) | Some(403) | Some(429)) || e.status.is_none() {
                                stop.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                }
                let n = finished.fetch_add(1, Ordering::SeqCst) + 1;
                on_progress(n, total);
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    let mut r = result.lock().clone();
    let left = total.saturating_sub(r.done + r.failed);
    if left > 0 {
        r.errors.push(format!("หยุด — ยังไม่ได้วิเคราะห์อีก {left} หมวด"));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::Completion;

    fn project() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let (_p, c) = crate::export::testdata::project(dir.path(), "A");
        (dir, c)
    }
    fn scope() -> Scope {
        Scope { from: "2026-09".into(), to: "2026-10".into(), service: None }
    }

    #[test]
    fn gathers_categories_with_tickets_and_samples_only_problem_text() {
        let (_d, c) = project();
        let g = gather(&c, &scope(), None).unwrap();
        assert_eq!(g.len(), 1); // Internet › การเชื่อมต่อ › เน็ตหลุด (IPTV has no categories)
        assert_eq!(g[0].total, 2);
        assert_eq!(g[0].label, "การเชื่อมต่อ › เน็ตหลุด");
        assert_eq!(g[0].weekly.len(), 2);
        assert!(g[0].weekly[1].0.starts_with("Oct 2026 สัปดาห์ 2 (5–11)"));
        let msg = user_message(&g[0], &scope());
        assert!(msg.contains("ปัญหา") && msg.contains("\"total_tickets\":2"));
        assert!(!msg.contains("ช่องทาง")); // source-file columns never go to the AI
        assert!(gather(&c, &Scope { from: "2026-01".into(), to: "2026-01".into(), service: None }, None).unwrap().is_empty());
        let cats = categories(&c, "2026-09", "2026-10").unwrap();
        assert_eq!((cats.len(), cats[0].count, cats[0].label.as_str()), (1, 2, "การเชื่อมต่อ › เน็ตหลุด"));
    }

    #[test]
    fn parses_answers_in_either_shape() {
        let a = parse(r#"```json
{"summary":"หลุดบ่อยช่วงสัปดาห์ 2","symptoms":["เน็ตหลุด","- ต่อใหม่ได้"],"rootCause":"สายหลวม","resolution":"","prevention":"ตรวจสาย"}
```"#)
        .unwrap();
        assert_eq!(a.symptoms, "- เน็ตหลุด\n- ต่อใหม่ได้");
        assert_eq!(a.root_cause, "สายหลวม");
        assert!(parse("{}").is_none());
        let note = as_note(&a);
        assert!(note.starts_with("หลุดบ่อย") && note.contains("สาเหตุ:\nสายหลวม") && !note.contains("การแก้ไข"));
    }

    #[tokio::test]
    async fn runs_saves_lists_and_notes() {
        let (dir, c) = project();
        let path = dir.path().join("A.sqlite");
        drop(c);
        let conn = Arc::new(parking_lot::Mutex::new(crate::db::open(&path).unwrap()));
        let inputs = gather(&conn.lock(), &scope(), None).unwrap();
        let llm: LlmFn = Arc::new(|system: String, user: String| {
            Box::pin(async move {
                assert!(system.contains("ห้ามใส่ชื่อคน"));
                assert!(user.contains("เน็ตหลุด"));
                Ok(Completion { content: r#"{"summary":"ส่วนใหญ่หลุดตอนกลางคืน","symptoms":"- หลุดเป็นช่วง","root_cause":"ข้อมูลไม่พอ","resolution":"- รีสตาร์ท","prevention":"- ตรวจสาย"}"#.into(), prompt_tokens: 900, completion_tokens: 120, cost: Some(0.002) })
            })
        });
        let seen = Arc::new(AtomicUsize::new(0));
        let (cn, sn) = (conn.clone(), seen.clone());
        let r = run(
            llm,
            inputs,
            scope(),
            4,
            Duration::from_millis(1),
            Arc::new(move |i, a, t| save(&cn.lock(), i, &scope(), a, "godev1", t)),
            Arc::new(move |n, _| sn.store(n, Ordering::SeqCst)),
        )
        .await;
        assert_eq!((r.done, r.failed, r.tokens_in), (1, 0, 900));
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        let c = conn.lock();
        let l = list(&c, "2026-09", "2026-10").unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].analysis.summary, "ส่วนใหญ่หลุดตอนกลางคืน");
        assert_eq!(l[0].tickets, 2);
        assert!(list(&c, "2026-10", "2026-10").unwrap().is_empty());
        let v = crate::export::testdata::vals("การเชื่อมต่อ", "เน็ตหลุด");
        assert!(note_for(&c, "Internet", &v, "2026-09", "2026-10").unwrap().unwrap().starts_with("ส่วนใหญ่"));
        assert!(note_for(&c, "Internet", &v, "2026-10", "2026-10").unwrap().unwrap().starts_with("(วิเคราะห์ช่วง 2026-09 ถึง 2026-10)"));
    }

    #[tokio::test]
    async fn a_rejected_key_stops_the_rest() {
        let (_d, c) = project();
        let mut inputs = gather(&c, &scope(), None).unwrap();
        inputs.push(inputs[0].clone());
        inputs.push(inputs[0].clone());
        let llm: LlmFn = Arc::new(|_, _| Box::pin(async { Err(AppError::from_status(401, "")) }));
        let r = run(llm, inputs, scope(), 1, Duration::from_millis(1), Arc::new(|_, _, _| Ok(())), Arc::new(|_, _| {})).await;
        assert_eq!((r.done, r.failed), (0, 1));
        assert!(r.errors.last().unwrap().contains("อีก 2 หมวด"));
    }
}
