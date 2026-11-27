//! Raw CSV (SPEC §10.1): UTF-8 **with BOM** (Excel shows Thai correctly), one row per ticket,
//! the results-table columns + every category column + confidence + source.

use super::{category_columns, services, tickets, Scope};
use crate::errors::{AppError, AppResult};
use rusqlite::Connection;
use std::path::Path;

pub const CAUSE_LABEL: [(&str, &str); 3] = [("user", "ผู้ใช้"), ("program", "โปรแกรม"), ("unclear", "ไม่ชัดเจน")];

const SOURCE_LABEL: [(&str, &str); 6] = [("ai", "AI"), ("cache", "แคช"), ("human", "แก้โดยคน"), ("error", "ผิดพลาด"), ("unknown_service", "ไม่มีหมวดหมู่"), ("pending", "รอจัด")];

/// `src_cols` = source-file columns the user added to the results table.
pub fn export(conn: &Connection, scope: &Scope, src_cols: &[String], path: &Path) -> AppResult<usize> {
    let svcs = services(conn)?;
    let cats = category_columns(&svcs);
    let rows = tickets(conn, scope)?;
    let mut buf: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    {
        let mut w = csv::WriterBuilder::new().from_writer(&mut buf);
        let err = |e: csv::Error| AppError::new("io", format!("เขียน CSV ไม่ได้: {e}"));
        let mut head: Vec<String> = ["เลขทิกเก็ต", "วันที่", "เดือน", "เซอร์วิส", "ข้อความปัญหา"].iter().map(|s| s.to_string()).collect();
        head.extend(src_cols.iter().cloned());
        head.extend(cats.iter().cloned());
        head.extend(["ต้นเหตุ", "ความมั่นใจ", "ที่มา", "เดิม AI จัดเป็น", "แก้โดย"].iter().map(|s| s.to_string()));
        w.write_record(&head).map_err(err)?;
        for r in &rows {
            let mut rec: Vec<String> = vec![r.ticket_no.clone(), r.date.clone(), r.month.clone(), r.service.clone(), r.problem_text.clone()];
            for c in src_cols {
                rec.push(r.source_row.get(c).and_then(|v| v.as_str()).unwrap_or("").to_string());
            }
            for c in &cats {
                rec.push(r.fields.get(c).cloned().unwrap_or_default());
            }
            rec.push(r.cause.as_deref().and_then(|c| CAUSE_LABEL.iter().find(|(k, _)| *k == c)).map(|(_, v)| v.to_string()).unwrap_or_default());
            rec.push(r.confidence.map(|c| format!("{:.2}", c)).unwrap_or_default());
            rec.push(SOURCE_LABEL.iter().find(|(k, _)| *k == r.source).map(|(_, v)| v.to_string()).unwrap_or_else(|| r.source.clone()));
            let svc_cols = svcs.iter().find(|s| s.name == r.service).map(|s| s.columns.clone()).unwrap_or_default();
            let ai = match (&r.ai_fields, r.source.as_str()) {
                (Some(a), "human") => svc_cols.iter().filter_map(|c| a.get(c).cloned()).collect::<Vec<_>>().join(" › "),
                _ => String::new(),
            };
            rec.push(ai);
            rec.push(r.edited_by.clone().unwrap_or_default());
            w.write_record(&rec).map_err(err)?;
        }
        w.flush()?;
    }
    std::fs::write(path, buf)?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_bom_utf8_and_quotes_safely() {
        let dir = tempfile::tempdir().unwrap();
        let (_p, c) = crate::export::testdata::project(dir.path(), "A");
        let out = dir.path().join("a.csv");
        let n = export(&c, &Scope { from: "2026-09".into(), to: "2026-10".into(), service: None }, &["ช่องทาง".into()], &out).unwrap();
        assert_eq!(n, 3);
        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        let mut r = csv::Reader::from_reader(text.as_bytes());
        let head: Vec<String> = r.headers().unwrap().iter().map(str::to_string).collect();
        assert_eq!(head, vec!["เลขทิกเก็ต", "วันที่", "เดือน", "เซอร์วิส", "ข้อความปัญหา", "ช่องทาง", "หัวข้อหลัก", "หัวข้อย่อย", "ต้นเหตุ", "ความมั่นใจ", "ที่มา", "เดิม AI จัดเป็น", "แก้โดย"]);
        let recs: Vec<csv::StringRecord> = r.records().map(|x| x.unwrap()).collect();
        assert_eq!(recs.len(), 3);
        assert_eq!(&recs[0][0], "INC1");
        assert!(recs[0][4].contains("\"ปัญหา\"") && recs[0][4].contains('\n')); // quotes/newlines survive
        assert_eq!(&recs[0][5], "โทร");
        assert_eq!(&recs[0][7], "เน็ตหลุด");
        assert_eq!(&recs[0][8], "โปรแกรม");
        assert_eq!(&recs[0][9], "0.92");
        assert_eq!(&recs[1][10], "แก้โดยคน");
        assert_eq!(&recs[1][11], "การเชื่อมต่อ › เน็ตหลุด");
        assert_eq!(&recs[2][8], ""); // not assessed
        assert_eq!(&recs[2][10], "รอจัด");
        // one service only
        let n = export(&c, &Scope { from: "2026-01".into(), to: "2026-12".into(), service: Some("IPTV".into()) }, &[], &out).unwrap();
        assert_eq!(n, 1);
    }
}
