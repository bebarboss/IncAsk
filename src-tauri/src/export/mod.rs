//! Exports (SPEC §10): raw CSV, `.incask` project file (+ import / merge), single-file HTML report.
//! None of them ever contains the API key, the Gateway URL or costs.

pub mod csv_export;
pub mod html;
pub mod incask;

use crate::errors::AppResult;
use crate::results::Row;
use crate::taxonomy::{self, Service};
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde::Deserialize;

/// What to export: a month range and optionally one service.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub from: String,
    pub to: String,
    pub service: Option<String>,
}

impl Scope {
    fn sql(&self) -> (String, Vec<Sql>) {
        let mut w = "t.month BETWEEN ? AND ?".to_string();
        let mut p = vec![Sql::Text(self.from.clone()), Sql::Text(self.to.clone())];
        if let Some(s) = self.service.as_deref().filter(|s| !s.is_empty()) {
            w.push_str(" AND t.service = ?");
            p.push(Sql::Text(s.into()));
        }
        (w, p)
    }
}

/// Tickets in scope, oldest first, in the same shape as the results table.
pub fn tickets(conn: &Connection, scope: &Scope) -> AppResult<Vec<Row>> {
    let (w, p) = scope.sql();
    let sql = format!(
        "SELECT {} FROM tickets t LEFT JOIN classifications c ON c.ticket_id = t.id WHERE {w} ORDER BY t.date, t.ticket_no",
        crate::results::SELECT_COLS
    );
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(p.iter()), crate::results::map_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Category columns of every service, in table order without repeats.
pub fn category_columns(services: &[Service]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for s in services {
        for c in &s.columns {
            if !out.contains(c) {
                out.push(c.clone());
            }
        }
    }
    out
}

pub fn services(conn: &Connection) -> AppResult<Vec<Service>> {
    taxonomy::list_services(conn)
}

/// `<project>_<yyyy-mm>_<yyyy-mm>.<ext>` with characters Windows forbids replaced.
pub fn default_file_name(project: &str, scope: &Scope, ext: &str) -> String {
    let safe: String = project.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    format!("{}_{}_{}.{ext}", safe.trim(), scope.from, scope.to)
}

#[cfg(test)]
pub mod testdata {
    //! A small project used by every export test.
    use crate::taxonomy::{create_service, save_row, RowInput, Values};
    use rusqlite::{params, Connection};

    pub fn vals(a: &str, b: &str) -> Values {
        [("หัวข้อหลัก".to_string(), a.to_string()), ("หัวข้อย่อย".to_string(), b.to_string())].into_iter().collect()
    }

    pub fn project(dir: &std::path::Path, name: &str) -> (std::path::PathBuf, Connection) {
        let path = dir.join(format!("{name}.sqlite"));
        let mut c = crate::db::open(&path).unwrap();
        crate::db::set_meta(&c, "project_name", name).unwrap();
        let cols = vec!["หัวข้อหลัก".to_string(), "หัวข้อย่อย".to_string()];
        let s = create_service(&c, "Internet", Some("#2F6FB0"), &cols).unwrap();
        save_row(&mut c, &s.id, &RowInput { id: None, values: vals("การเชื่อมต่อ", "เน็ตหลุด"), description: "หลุดเป็นช่วง".into(), examples: String::new(), cause: None }).unwrap();
        create_service(&c, "IPTV", Some("#7B4FB0"), &cols).unwrap();
        c.execute("INSERT INTO imports(id,file_name) VALUES('im1','oct.xlsx')", []).unwrap();
        for (id, no, month, svc, cls) in [
            ("k1", "INC1", "2026-09", "Internet", Some(("ai", 0.92))),
            ("k2", "INC2", "2026-10", "Internet", Some(("human", 1.0))),
            ("k3", "INC3", "2026-10", "IPTV", None),
        ] {
            c.execute(
                "INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?2,?3||'-05',?3,?4,?5,?6,'im1')",
                params![id, no, month, svc, format!("หัวข้อ: \"ปัญหา\" {no}, รายละเอียด: มีจุลภาค, และ\nขึ้นบรรทัด"), r#"{"เลขอินซิเดนต์":"x","ช่องทาง":"โทร"}"#],
            )
            .unwrap();
            if let Some((src, conf)) = cls {
                let f = serde_json::to_string(&vals("การเชื่อมต่อ", "เน็ตหลุด")).unwrap();
                c.execute("INSERT INTO classifications(ticket_id,fields_json,ai_fields_json,confidence,source,cause,ai_cause) VALUES(?1,?2,?2,?3,?4,'program','program')", params![id, f, conf, src]).unwrap();
            }
        }
        crate::pivot::save_view(&c, None, "รายงานประจำเดือน", &serde_json::json!({"rows":["service"]})).unwrap();
        (path, c)
    }
}
