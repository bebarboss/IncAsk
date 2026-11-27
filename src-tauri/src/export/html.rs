//! Single-file HTML report (SPEC §10.3). The page (built from `report/` by Vite into one file with
//! fonts inlined) carries `<script id="incask-data" type="application/octet-stream"></script>`; we put
//! the data there as base64 of deflate-compressed JSON — the page inflates it with the browser's
//! DecompressionStream, so it works offline and 10,000 tickets stay far below 5 MB.
//! The data holds tickets, categories, colours and saved views — no key, Gateway name or cost.

use super::{category_columns, services, tickets, Scope};
use crate::errors::{AppError, AppResult};
use base64::Engine;
use flate2::write::DeflateEncoder;
use rusqlite::Connection;
use serde::Serialize;
use std::io::Write;

#[derive(Serialize)]
struct Svc {
    name: String,
    color: String,
    columns: Vec<String>,
}

/// Compact ticket: [ticketNo, date, month, service, problem, [category values], confidence,
/// source, [ai values] | null, editedBy, [source-file values], cause | null]
type T = (String, String, String, String, String, Vec<String>, Option<f64>, String, Option<Vec<String>>, Option<String>, Vec<String>, Option<String>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    v: u32,
    project: (String, String),
    exported_at: String,
    from: String,
    to: String,
    services: Vec<Svc>,
    categories: Vec<String>,
    source_headers: Vec<String>,
    views: Vec<crate::pivot::SavedView>,
    tickets: Vec<T>,
}

pub fn payload_json(conn: &Connection, scope: &Scope, project: (&str, &str)) -> AppResult<String> {
    let svcs = services(conn)?;
    let cats = category_columns(&svcs);
    let rows = tickets(conn, scope)?;
    let mut src_headers: Vec<String> = vec![];
    for r in &rows {
        for k in r.source_row.keys() {
            if !src_headers.contains(k) {
                src_headers.push(k.clone());
            }
        }
    }
    let exported_at: String = conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| r.get(0))?;
    let p = Payload {
        v: 1,
        project: (project.0.into(), project.1.into()),
        exported_at,
        from: scope.from.clone(),
        to: scope.to.clone(),
        services: svcs.iter().filter(|s| scope.service.as_deref().is_none_or_eq(&s.name)).map(|s| Svc { name: s.name.clone(), color: s.color.clone(), columns: s.columns.clone() }).collect(),
        views: crate::pivot::list_views(conn)?,
        tickets: rows
            .into_iter()
            .map(|r| {
                let catv = cats.iter().map(|c| r.fields.get(c).cloned().unwrap_or_default()).collect();
                let ai = r.ai_fields.as_ref().map(|a| cats.iter().map(|c| a.get(c).cloned().unwrap_or_default()).collect());
                let src = src_headers.iter().map(|h| r.source_row.get(h).and_then(|v| v.as_str()).unwrap_or("").to_string()).collect();
                (r.ticket_no, r.date, r.month, r.service, r.problem_text, catv, r.confidence, r.source, ai, r.edited_by, src, r.cause)
            })
            .collect(),
        categories: cats,
        source_headers: src_headers,
    };
    Ok(serde_json::to_string(&p)?)
}

trait OptEq {
    fn is_none_or_eq(&self, v: &str) -> bool;
}
impl OptEq for Option<&str> {
    fn is_none_or_eq(&self, v: &str) -> bool {
        self.map_or(true, |s| s.is_empty() || s == v)
    }
}

pub fn compress(json: &str) -> AppResult<String> {
    let mut e = DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    e.write_all(json.as_bytes())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(e.finish()?))
}

/// Put the data into the report template.
pub fn render(template: &str, json: &str) -> AppResult<String> {
    let marker = "id=\"incask-data\"";
    let at = template.find(marker).ok_or_else(|| AppError::new("report", "แม่แบบรายงานไม่สมบูรณ์ — ติดตั้งโปรแกรมใหม่"))?;
    let open = at + template[at..].find('>').ok_or_else(|| AppError::new("report", "แม่แบบรายงานไม่สมบูรณ์"))? + 1;
    let close = open + template[open..].find("</script>").ok_or_else(|| AppError::new("report", "แม่แบบรายงานไม่สมบูรณ์"))?;
    // base64 never contains "</", but keep the guard should the encoding ever change
    let data = compress(json)?.replace("</", "<\\/");
    Ok(format!("{}{}{}", &template[..open], data, &template[close..]))
}

pub fn export(conn: &Connection, scope: &Scope, project: (&str, &str), template: &str, out: &std::path::Path) -> AppResult<usize> {
    let json = payload_json(conn, scope, project)?;
    let html = render(template, &json)?;
    std::fs::write(out, html.as_bytes())?;
    Ok(html.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::testdata;
    use std::io::Read;

    const TEMPLATE: &str = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></head><body><div id=\"root\"></div><script id=\"incask-data\" type=\"application/octet-stream\"></script><script>/*app*/</script></body></html>";

    fn inflate(b64: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let mut d = flate2::read::DeflateDecoder::new(&bytes[..]);
        let mut s = String::new();
        d.read_to_string(&mut s).unwrap();
        s
    }

    #[test]
    fn embeds_compressed_data_without_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let (_p, c) = testdata::project(dir.path(), "A");
        c.execute("INSERT INTO runs(id, cost, model) VALUES('r1', 4.2, 'godev1')", []).unwrap();
        let json = payload_json(&c, &Scope { from: "2026-01".into(), to: "2026-12".into(), service: None }, ("Call Center A", "#217346")).unwrap();
        let html = render(TEMPLATE, &json).unwrap();
        assert!(html.starts_with("<!doctype html>") && html.ends_with("</html>"));
        let start = html.find("application/octet-stream\">").unwrap() + "application/octet-stream\">".len();
        let end = start + html[start..].find("</script>").unwrap();
        let back = inflate(&html[start..end]);
        assert_eq!(back, json);
        let v: serde_json::Value = serde_json::from_str(&back).unwrap();
        assert_eq!(v["tickets"].as_array().unwrap().len(), 3);
        assert_eq!(v["categories"], serde_json::json!(["หัวข้อหลัก", "หัวข้อย่อย"]));
        assert_eq!(v["views"][0]["name"], "รายงานประจำเดือน");
        for banned in ["sk-", "agent-gateway", "cost", "godev1", "4.2"] {
            assert!(!back.contains(banned), "{banned}");
        }
        assert!(render("<html></html>", "{}").is_err());
    }

    /// SPEC: ≤ 5 MB at 10,000 tickets.
    #[test]
    fn ten_thousand_tickets_stay_well_under_5mb() {
        let dir = tempfile::tempdir().unwrap();
        let (_p, mut c) = testdata::project(dir.path(), "A");
        let words = ["อินเทอร์เน็ตหลุด", "ภาพค้าง", "สัญญาณอ่อน", "บิลผิด", "ช่างไม่มา", "เราเตอร์ไฟแดง", "ความเร็วต่ำ", "แอปเข้าไม่ได้", "โทรไม่ติด", "ย้ายที่ติดตั้ง"];
        let names = ["สมชาย", "วิภา", "อนันต์", "นภา", "ธนา", "ปิยะ", "กมล", "ศิริ", "ประยุทธ", "มาลี"];
        let tx = c.transaction().unwrap();
        for i in 0..10_000usize {
            let text = format!("หัวข้อ: {} ครั้งที่ {}, รายละเอียดปัญหา: ลูกค้า{}แจ้งว่า{}ตั้งแต่เวลา {}:{:02} น. บ้านเลขที่ {}/{} รีสตาร์ทแล้วยังไม่หาย",
                words[i % 10], i % 7, names[(i / 10) % 10], words[(i * 7) % 10], i % 24, i % 60, i % 999, i % 37);
            let src = format!(r#"{{"เลขอินซิเดนต์":"INC{i:07}","วันที่แจ้ง":"{:02}/10/2569","ชื่อลูกค้า":"คุณ{} {}.","เซอร์วิส":"Internet","ช่องทาง":"โทร","สถานะ":"ปิดแล้ว"}}"#, i % 28 + 1, names[i % 10], names[(i / 3) % 10]);
            tx.execute(
                "INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?1,'2026-10-01','2026-10','Internet',?2,?3,'im1')",
                rusqlite::params![format!("X{i}"), text, src],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO classifications(ticket_id,fields_json,ai_fields_json,confidence,source,reason) VALUES(?1,?2,?2,?3,'ai','ข้อความพูดถึงการเชื่อมต่อ')",
                rusqlite::params![format!("X{i}"), serde_json::to_string(&testdata::vals("การเชื่อมต่อ", "เน็ตหลุด")).unwrap(), 0.5 + (i % 50) as f64 / 100.0],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let json = payload_json(&c, &Scope { from: "2026-01".into(), to: "2026-12".into(), service: None }, ("A", "#217346")).unwrap();
        let data = compress(&json).unwrap();
        println!("10k tickets: json {} KB → embedded {} KB", json.len() / 1024, data.len() / 1024);
        // the page itself (React + fonts) is under 1 MB; the data must leave plenty of room
        assert!(data.len() < 3 * 1024 * 1024, "{} bytes", data.len());
    }
}

/// Writes `target/sample_report.html` (10,000 tickets, the real template) for a manual / browser check:
/// `cargo test --lib sample_report -- --ignored`
#[cfg(test)]
#[test]
#[ignore]
fn sample_report() {
    use crate::export::testdata;
    let dir = tempfile::tempdir().unwrap();
    let (_p, mut c) = testdata::project(dir.path(), "Call Center A");
    let words = ["อินเทอร์เน็ตหลุด", "ภาพค้าง", "สัญญาณอ่อน", "บิลผิด", "ช่างไม่มา", "เราเตอร์ไฟแดง", "ความเร็วต่ำ", "แอปเข้าไม่ได้", "โทรไม่ติด", "ย้ายที่ติดตั้ง"];
    let cats = [("การเชื่อมต่อ", "เน็ตหลุด"), ("การเชื่อมต่อ", "ไม่มีเน็ต"), ("ความเร็ว", "เน็ตช้า"), ("บริการติดตั้ง", "ย้ายจุด")];
    let tx = c.transaction().unwrap();
    for i in 0..10_000usize {
        let svc = ["Internet", "IPTV"][i % 2];
        let month = format!("2026-{:02}", 8 + i % 3);
        let (a, b) = cats[i % 4];
        tx.execute(
            "INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?1,?2||'-15',?2,?3,?4,?5,'im1')",
            rusqlite::params![format!("INC{:07}", i + 10), month, svc, format!("หัวข้อ: {}, รายละเอียดปัญหา: ลูกค้าแจ้ง{} ครั้งที่ {}", words[i % 10], words[(i * 3) % 10], i % 9), format!(r#"{{"ช่องทาง":"{}"}}"#, ["โทร", "แชต", "อีเมล"][i % 3])],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO classifications(ticket_id,fields_json,ai_fields_json,confidence,source,reason) VALUES(?1,?2,?2,?3,'ai','ทดสอบ')",
            rusqlite::params![format!("INC{:07}", i + 10), serde_json::to_string(&testdata::vals(a, b)).unwrap(), 0.6 + (i % 40) as f64 / 100.0],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let template = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/report.html")).unwrap();
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/sample_report.html");
    let size = export(&c, &Scope { from: "2026-01".into(), to: "2026-12".into(), service: None }, ("Call Center A", "#217346"), &template, &out).unwrap();
    println!("sample report: {} KB at {}", size / 1024, out.display());
    assert!(size < 5 * 1024 * 1024);
}
