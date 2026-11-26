//! Job tests with a fake LLM — no Gateway, no key.

use super::*;
use crate::taxonomy::{create_service, save_row, RowInput};
use std::sync::atomic::AtomicU32;

struct NullSink;
impl Sink for NullSink {
    fn progress(&self, _: &Progress) {}
    fn finished(&self, _: &Progress) {}
}

fn vals(a: &str, b: &str) -> Values {
    [("หัวข้อหลัก".to_string(), a.to_string()), ("หัวข้อย่อย".to_string(), b.to_string())].into_iter().collect()
}

fn setup(n_internet: usize) -> (tempfile::TempDir, Arc<Mutex<Connection>>) {
    let dir = tempfile::tempdir().unwrap();
    let mut c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
    let cols = vec!["หัวข้อหลัก".to_string(), "หัวข้อย่อย".to_string()];
    let s = create_service(&c, "Internet", None, &cols).unwrap();
    for (a, b) in [("การเชื่อมต่อ", "เน็ตหลุด"), ("ความเร็ว", "เน็ตช้า")] {
        save_row(&mut c, &s.id, &RowInput { id: None, values: vals(a, b), description: "d".into(), examples: String::new() }).unwrap();
    }
    create_service(&c, "IPTV", None, &cols).unwrap(); // no categories → its tickets wait
    let ins = |id: &str, svc: &str, text: &str| {
        c.execute(
            "INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?1,'2026-10-01','2026-10',?2,?3,'{}','im1')",
            params![id, svc, text],
        )
        .unwrap();
    };
    for i in 0..n_internet {
        let text = match i % 4 {
            0 => "หัวข้อ: เน็ตหลุด".to_string(),
            1 => format!("หัวข้อ: เน็ตช้า #{i}"),
            2 => format!("หัวข้อ: อะไรก็ไม่รู้ #{i}"),
            _ => format!("หัวข้อ: skip #{i}"),
        };
        ins(&format!("T{i:03}"), "Internet", &text);
    }
    ins("TV1", "IPTV", "ภาพค้าง");
    ins("X1", "Smart Home", "กล้องหลุด");
    (dir, Arc::new(Mutex::new(c)))
}

/// Answers by keyword; leaves out "skip" tickets on the first ask (they come back on the re-ask)
/// except ones whose number ends in 7 (never answered → error). Counts calls.
fn fake_llm(calls: Arc<AtomicU32>, fail_429_first: u32) -> LlmFn {
    Arc::new(move |system: String, user: String| {
        let calls = calls.clone();
        Box::pin(async move {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            if n < fail_429_first {
                return Err(AppError::from_status(429, ""));
            }
            assert!(system.contains("C01 | การเชื่อมต่อ | เน็ตหลุด"));
            let v: serde_json::Value = serde_json::from_str(&user).unwrap();
            let tickets = v["tickets"].as_array().unwrap();
            let first_try = tickets.len() > 1 || !tickets[0]["text"].as_str().unwrap().contains("skip");
            let mut results = vec![];
            for t in tickets {
                let text = t["text"].as_str().unwrap();
                if text.contains("skip") && (first_try || text.ends_with('7')) {
                    continue;
                }
                let (code, conf) = if text.contains("หลุด") {
                    (serde_json::json!("C01"), 0.95)
                } else if text.contains("ช้า") || text.contains("skip") {
                    (serde_json::json!("C02"), 0.9)
                } else {
                    (serde_json::Value::Null, 0.2)
                };
                results.push(serde_json::json!({"id": t["id"], "code": code, "confidence": conf, "reason": "ทดสอบ"}));
            }
            Ok(Completion { content: serde_json::json!({ "results": results }).to_string(), prompt_tokens: 100, completion_tokens: 10, cost: Some(0.001) })
        })
    })
}

fn cfg() -> JobConfig {
    JobConfig { model: "godev1".into(), batch_size: 3, concurrency: 2, low_threshold: 0.7, backoff_base: Duration::from_millis(1), restore_after: Duration::from_millis(50) }
}

fn progress(run: &str) -> Progress {
    Progress {
        run_id: run.into(), project_id: "p".into(), file_name: "f.csv".into(), pattern_name: None, status: "running".into(), total: 0, done: 0, ai: 0,
        cached: 0, low: 0, error: 0, eta_sec: None, concurrency: 2, recent: vec![], message: None, tokens_in: 0, tokens_out: 0, cost: None,
    }
}

async fn run_job(conn: Arc<Mutex<Connection>>, llm: LlmFn, run: &str) -> Progress {
    let shared = Shared::new(progress(run));
    super::run(Job { conn, shared: shared.clone(), cfg: cfg(), llm, sink: Arc::new(NullSink), import_id: Some("im1".into()), kind: "full".into() }).await;
    shared.snapshot()
}

fn count(c: &Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[tokio::test]
async fn classifies_retries_reasks_and_uses_the_cache() {
    let (_d, conn) = setup(12);
    let calls = Arc::new(AtomicU32::new(0));
    // two 429s first: the job waits and retries instead of failing
    let p = run_job(conn.clone(), fake_llm(calls.clone(), 2), "run1").await;
    assert_eq!(p.status, "done");
    assert_eq!(p.total, 12); // IPTV (no categories) and Smart Home (unknown) are not sent
    assert_eq!(p.done, 12);
    // T003/T007/T011 are "skip": 003 and 011 answered on the re-ask, 007 never → error
    assert_eq!(p.error, 1);
    // 3 "อะไรก็ไม่รู้" got null + 0.2 → low
    assert_eq!(p.low, 3);
    // "หัวข้อ: เน็ตหลุด" appears 3 times: the cache only helps on a later run, all 3 asked now
    assert_eq!(p.ai + p.cached, 11);
    assert_eq!(p.tokens_in % 100, 0);
    assert!(p.cost.unwrap() > 0.0);
    {
        let c = conn.lock();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM classifications WHERE source='ai'"), 11);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM classifications WHERE source='error'"), 1);
        let f: String = c.query_row("SELECT fields_json FROM classifications WHERE ticket_id='T000'", [], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Values>(&f).unwrap(), vals("การเชื่อมต่อ", "เน็ตหลุด"));
        let null_fields: Option<String> = c.query_row("SELECT fields_json FROM classifications WHERE ticket_id='T002'", [], |r| r.get(0)).unwrap();
        assert!(null_fields.is_none());
        let (status, done): (String, i64) = c.query_row("SELECT status, rows_done FROM runs WHERE id='run1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((status.as_str(), done), ("done", 12));
        // a new ticket with the same text as an answered one, and a reclassify of T000 → both from cache
        c.execute("INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES('N1','N1','2026-10-02','2026-10','Internet','หัวข้อ:   เน็ตหลุด','{}','im2')", []).unwrap();
        c.execute("DELETE FROM classifications WHERE ticket_id='T000'", []).unwrap();
    }
    let before = calls.load(Ordering::SeqCst);
    let p2 = run_job(conn.clone(), fake_llm(calls.clone(), 0), "run2").await;
    assert_eq!((p2.total, p2.cached, p2.ai), (2, 2, 0));
    assert_eq!(calls.load(Ordering::SeqCst), before); // no LLM call at all
    assert_eq!(last_run(&conn.lock(), "p").unwrap().unwrap().run_id, "run2");
}

#[tokio::test]
async fn gateway_down_pauses_without_marking_errors_and_resume_finishes() {
    let (_d, conn) = setup(6);
    let down = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(AtomicU32::new(0));
    let real = fake_llm(calls, 0);
    let flaky: LlmFn = {
        let down = down.clone();
        Arc::new(move |s, u| {
            if down.load(Ordering::SeqCst) {
                Box::pin(async { Err(AppError::unreachable()) })
            } else {
                real(s, u)
            }
        })
    };
    let shared = Shared::new(progress("run1"));
    let job = Job { conn: conn.clone(), shared: shared.clone(), cfg: cfg(), llm: flaky, sink: Arc::new(NullSink), import_id: None, kind: "full".into() };
    let h = tokio::spawn(super::run(job));
    for _ in 0..100 {
        if shared.snapshot().status == "paused" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let p = shared.snapshot();
    assert_eq!(p.status, "paused");
    assert_eq!(p.message.as_deref(), Some(crate::errors::MSG_UNREACHABLE));
    assert_eq!(count(&conn.lock(), "SELECT COUNT(*) FROM classifications WHERE source='error'"), 0);
    // VPN back → resume → done
    down.store(false, Ordering::SeqCst);
    shared.resume();
    tokio::time::timeout(Duration::from_secs(10), h).await.unwrap().unwrap();
    let p = shared.snapshot();
    assert_eq!((p.status.as_str(), p.done), ("done", 6));
}

#[tokio::test]
async fn cancel_stops_and_leaves_the_rest_for_later() {
    let (_d, conn) = setup(9);
    let shared = Shared::new(progress("run1"));
    shared.pause();
    let job = Job { conn: conn.clone(), shared: shared.clone(), cfg: cfg(), llm: fake_llm(Arc::new(AtomicU32::new(0)), 0), sink: Arc::new(NullSink), import_id: None, kind: "full".into() };
    let h = tokio::spawn(super::run(job));
    tokio::time::sleep(Duration::from_millis(50)).await;
    shared.cancel();
    tokio::time::timeout(Duration::from_secs(5), h).await.unwrap().unwrap();
    assert_eq!(shared.snapshot().status, "cancelled");
    let svc = load_services(&conn.lock()).unwrap();
    assert_eq!(pending(&conn.lock(), &svc).unwrap().len(), 9);
    // the closed run is what the classify page shows next time
    assert_eq!(last_run(&conn.lock(), "p").unwrap().unwrap().status, "cancelled");
}

#[tokio::test]
async fn trial_spreads_over_services_and_writes_nothing() {
    let (_d, conn) = setup(8);
    let services = load_services(&conn.lock()).unwrap();
    let by: Vec<(String, Vec<(String, String)>)> = vec![
        ("Internet".into(), (0..8).map(|i| (format!("A{i}"), "เน็ตหลุด".to_string())).collect()),
        ("IPTV".into(), vec![("B1".into(), "x".into())]),
    ];
    let picked = spread(&by, 5);
    assert_eq!(picked.iter().filter(|(s, _)| s == "IPTV").count(), 1);
    assert_eq!(picked.len(), 5);
    let sample: Vec<(String, String, String)> = picked.into_iter().filter(|(s, _)| services.contains_key(s)).map(|(s, (no, t))| (s, no, t)).collect();
    let r = trial(&fake_llm(Arc::new(AtomicU32::new(0)), 0), &services, sample, &cfg()).await;
    assert_eq!(r.items.len(), 4);
    assert_eq!(r.items[0].category.as_deref(), Some("การเชื่อมต่อ › เน็ตหลุด"));
    assert_eq!(count(&conn.lock(), "SELECT COUNT(*) FROM classifications"), 0);
    assert_eq!(count(&conn.lock(), "SELECT COUNT(*) FROM cache"), 0);
}

#[test]
fn few_shot_comes_from_human_corrections() {
    let (_d, conn) = setup(2);
    let c = conn.lock();
    c.execute(
        "INSERT INTO classifications(ticket_id, fields_json, source, updated_at) VALUES('T001', ?1, 'human', datetime('now'))",
        [serde_json::to_string(&vals("ความเร็ว", "เน็ตช้า")).unwrap()],
    )
    .unwrap();
    let s = load_services(&c).unwrap();
    assert_eq!(s["Internet"].few_shot, vec![("หัวข้อ: เน็ตช้า #1".to_string(), "C02".to_string())]);
    assert!(!s.contains_key("IPTV"));
}

#[test]
fn backoff_doubles_and_caps_at_a_minute() {
    let b = Duration::from_secs(2);
    assert!(backoff(b, 0) >= Duration::from_secs(2) && backoff(b, 0) < Duration::from_secs(3));
    assert!(backoff(b, 2) >= Duration::from_secs(8));
    assert!(backoff(b, 9) <= Duration::from_secs(61));
}
