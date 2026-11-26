//! Accuracy check against the real Gateway (PROMPT.md, step 6).
//!
//!   cargo run --bin classify_eval -- --tickets oct.xlsx --taxonomy หมวดหมู่.xlsx [--answers เฉลย.xlsx]
//!                                    [--batch 1,10,20] [--limit 200] [--model godev1] [--sheet ชื่อชีต]
//!
//! The API key is read from Windows Credential Manager (saved by the app) — never from arguments.
//! Nothing is written to any project: everything runs in a temporary database.
//! Answer file: a ticket-number column + the category columns (same names as the taxonomy).

use incask_lib::classify::{self, Item, JobConfig};
use incask_lib::{config, db, ingest, secrets, taxonomy};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let tickets = PathBuf::from(arg(&args, "--tickets").unwrap_or_else(|| fail("ต้องใส่ --tickets <ไฟล์ทิกเก็ต>")));
    let tax = PathBuf::from(arg(&args, "--taxonomy").unwrap_or_else(|| fail("ต้องใส่ --taxonomy <ไฟล์หมวดหมู่>")));
    let answers = arg(&args, "--answers").map(PathBuf::from);
    let sheet = arg(&args, "--sheet");
    let limit: usize = arg(&args, "--limit").and_then(|v| v.parse().ok()).unwrap_or(200);
    let sizes: Vec<usize> = arg(&args, "--batch").unwrap_or_else(|| "1,10,20".into()).split(',').filter_map(|s| s.trim().parse().ok()).collect();
    let settings = config::Settings::load();
    let model = arg(&args, "--model").unwrap_or(settings.model.clone());
    let key = secrets::require_key().unwrap_or_else(|e| fail(&e.message));

    // temporary project with the taxonomy
    let dir = std::env::temp_dir().join(format!("incask-eval-{}", std::process::id()));
    let mut conn = db::open(&dir.join("eval.sqlite")).unwrap_or_else(|e| fail(&e.message));
    let imported = taxonomy::apply_import(&mut conn, &tax, None).unwrap_or_else(|e| fail(&e.message));
    println!("หมวดหมู่: {}", imported.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", "));
    let services = classify::load_services(&conn).unwrap_or_else(|e| fail(&e.message));

    // tickets, roles guessed from the headers (as the app does for a new file)
    let parsed = ingest::load(&tickets, sheet.as_deref()).unwrap_or_else(|e| fail(&e.message));
    let roles = ingest::guess_roles(&parsed.headers);
    let (order, _) = ingest::date_order_for(&parsed, &roles, None).unwrap_or_else(|e| fail(&e.message));
    let (recs, bad) = ingest::build_records(&parsed, &roles, order).unwrap_or_else(|e| fail(&e.message));
    let recs: Vec<_> = recs.into_iter().filter(|r| services.contains_key(&r.service)).take(limit).collect();
    println!("ทิกเก็ต: {} แถว (อ่านไม่ได้ {}) จาก {}", recs.len(), bad.len(), parsed.file_name);

    // expected answers: ticket number → category label
    let mut expected: HashMap<String, String> = HashMap::new();
    if let Some(a) = &answers {
        let t = ingest::load(a, None).unwrap_or_else(|e| fail(&e.message));
        let tcol = ingest::guess_roles(&t.headers).iter().position(|r| *r == ingest::patterns::Role::Ticket).unwrap_or(0);
        for (_, row) in &t.rows {
            for svc in services.values() {
                let idx: Vec<usize> = svc.columns.iter().filter_map(|c| t.headers.iter().position(|h| h == c)).collect();
                if idx.len() == svc.columns.len() {
                    expected.insert(row[tcol].trim().to_string(), idx.iter().map(|&i| row[i].trim().to_string()).collect::<Vec<_>>().join(" › "));
                    break;
                }
            }
        }
        println!("เฉลย: {} แถว", expected.len());
    }

    let llm = classify::gateway_llm(settings.chat_url(), key, model.clone());
    let noop = || {};
    for size in sizes {
        let cfg = JobConfig { model: model.clone(), batch_size: size, concurrency: 1, low_threshold: 0.7, backoff_base: Duration::from_secs(2), restore_after: Duration::from_secs(60) };
        let (mut right, mut checked, mut low, mut errors, mut tokens, mut batches) = (0, 0, 0, 0, 0u64, 0);
        let mut wrong: Vec<String> = vec![];
        let t0 = Instant::now();
        let mut by: HashMap<&str, Vec<&ingest::Record>> = HashMap::new();
        for r in &recs {
            by.entry(r.service.as_str()).or_default().push(r);
        }
        for (svc_name, rows) in by {
            let svc = &services[svc_name];
            for chunk in rows.chunks(cfg.batch_size) {
                let items: Vec<Item> = chunk.iter().map(|r| Item { ticket_id: String::new(), ticket_no: r.ticket_no.clone(), text: r.problem_text.clone(), cache_key: String::new() }).collect();
                batches += 1;
                match classify::ask_batch(&llm, svc, &items, cfg.backoff_base, &noop).await {
                    Ok(out) => {
                        tokens += out.tokens_in + out.tokens_out;
                        errors += out.errors.len();
                        for (i, r) in chunk.iter().enumerate() {
                            let Some(a) = out.answers.get(&i) else { continue };
                            if a.confidence < cfg.low_threshold {
                                low += 1;
                            }
                            let got = a.code.as_deref().and_then(|c| svc.cat(c)).map(|c| c.label(&svc.columns)).unwrap_or_else(|| "(ไม่มีหมวด)".into());
                            if let Some(exp) = expected.get(&r.ticket_no) {
                                checked += 1;
                                if *exp == got {
                                    right += 1;
                                } else if wrong.len() < 10 {
                                    wrong.push(format!("  {} · {}\n    ข้อความ: {}\n    เฉลย: {exp}\n    AI: {got} ({:.0}%) — {}", r.ticket_no, svc_name, r.problem_text.chars().take(120).collect::<String>(), a.confidence * 100.0, a.reason));
                                }
                            }
                        }
                    }
                    Err(e) => fail(&format!("Gateway: {}", e.message)),
                }
            }
        }
        let n = recs.len().max(1);
        println!("\n=== batch_size {size} ===");
        if checked > 0 {
            println!("ถูกต้อง: {right}/{checked} = {:.1}%", right as f64 * 100.0 / checked as f64);
        }
        println!("ไม่มั่นใจ (<70%): {:.1}%  · ผิดพลาด: {errors}", low as f64 * 100.0 / n as f64);
        println!("เวลาเฉลี่ยต่อ batch: {:.1} วินาที · โทเคนต่อแถว: {:.0}", t0.elapsed().as_secs_f64() / batches.max(1) as f64, tokens as f64 / n as f64);
        if !wrong.is_empty() {
            println!("ตัวอย่างที่ผิด:\n{}", wrong.join("\n"));
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}
