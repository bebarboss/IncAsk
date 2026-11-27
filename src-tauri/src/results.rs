//! Results table (SPEC §8): server-side paging, sorting and filtering over tickets +
//! classifications, and category edits (one ticket or many of the same service).

use crate::errors::{AppError, AppResult};
use crate::taxonomy::{self, Values};
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub search: Option<String>,
    pub service: Option<String>,
    pub month: Option<String>,
    /// value of the first category column (any service)
    pub category: Option<String>,
    pub low_only: bool,
    pub error_only: bool,
    /// user | program | unclear | none (not assessed yet)
    pub cause: Option<String>,
    /// per-column "contains" filters: key → text
    pub filters: Vec<ColumnFilter>,
    pub sort: Option<String>,
    pub desc: bool,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ColumnFilter {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub ticket_no: String,
    pub date: String,
    pub month: String,
    pub service: String,
    pub problem_text: String,
    pub fields: Values,
    pub ai_fields: Option<Values>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    /// ai | cache | human | error | unknown_service | pending (not classified yet)
    pub source: String,
    pub edited_by: Option<String>,
    /// ต้นเหตุ: user | program | unclear; None = not assessed (classified before ต้นเหตุ existed)
    pub cause: Option<String>,
    pub ai_cause: Option<String>,
    pub source_row: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub total: usize,
    pub low_count: usize,
    pub rows: Vec<Row>,
}

fn json_path(col: &str) -> String {
    format!("$.\"{}\"", col.replace('"', "\\\""))
}

/// Column key → SQL expression (+ its parameter). Keys: ticketNo, date, service, problem,
/// confidence, source, cat:<column>, src:<file header>.
fn expr(key: &str) -> Option<(String, Option<String>)> {
    Some(match key {
        "ticketNo" => ("t.ticket_no".into(), None),
        "date" => ("t.date".into(), None),
        "service" => ("t.service".into(), None),
        "problem" => ("t.problem_text".into(), None),
        "confidence" => ("c.confidence".into(), None),
        "source" => ("COALESCE(c.source,'pending')".into(), None),
        "cause" => ("c.cause".into(), None),
        k if k.starts_with("cat:") => ("json_extract(c.fields_json, ?)".into(), Some(json_path(&k[4..]))),
        k if k.starts_with("src:") => ("json_extract(t.source_json, ?)".into(), Some(json_path(&k[4..]))),
        _ => return None,
    })
}

const FROM: &str = "FROM tickets t LEFT JOIN classifications c ON c.ticket_id = t.id";

/// Columns read by `map_row` (also used by the pivot drill-down).
pub const SELECT_COLS: &str = "t.id, t.ticket_no, t.date, t.month, t.service, t.problem_text, t.source_json, c.fields_json, c.ai_fields_json, c.confidence, c.reason, COALESCE(c.source,'pending'), c.edited_by, c.cause, c.ai_cause";

pub fn map_row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    let parse = |s: Option<String>| s.and_then(|j| serde_json::from_str::<Values>(&j).ok());
    let src: String = r.get(6)?;
    Ok(Row {
        id: r.get(0)?,
        ticket_no: r.get(1)?,
        date: r.get(2)?,
        month: r.get(3)?,
        service: r.get(4)?,
        problem_text: r.get(5)?,
        source_row: serde_json::from_str(&src).unwrap_or_default(),
        fields: parse(r.get(7)?).unwrap_or_default(),
        ai_fields: parse(r.get(8)?),
        confidence: r.get(9)?,
        reason: r.get(10)?,
        source: r.get(11)?,
        edited_by: r.get(12)?,
        cause: r.get(13)?,
        ai_cause: r.get(14)?,
    })
}

fn where_clause(q: &Query, threshold: f64, first_cols: &[String]) -> (String, Vec<Sql>) {
    let mut w: Vec<String> = vec!["1=1".into()];
    let mut p: Vec<Sql> = vec![];
    if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        w.push("(t.ticket_no LIKE ? OR t.problem_text LIKE ?)".into());
        let like = format!("%{s}%");
        p.push(Sql::Text(like.clone()));
        p.push(Sql::Text(like));
    }
    if let Some(s) = q.service.as_deref().filter(|s| !s.is_empty()) {
        w.push("t.service = ?".into());
        p.push(Sql::Text(s.into()));
    }
    if let Some(m) = q.month.as_deref().filter(|s| !s.is_empty()) {
        w.push("t.month = ?".into());
        p.push(Sql::Text(m.into()));
    }
    if let Some(cat) = q.category.as_deref().filter(|s| !s.is_empty()) {
        // the top category column may have a different name per service
        let mut any = vec![];
        for col in first_cols {
            any.push("json_extract(c.fields_json, ?) = ?".to_string());
            p.push(Sql::Text(json_path(col)));
            p.push(Sql::Text(cat.into()));
        }
        w.push(if any.is_empty() { "0".into() } else { format!("({})", any.join(" OR ")) });
    }
    if q.low_only {
        w.push("c.source NOT IN ('human','error','unknown_service') AND COALESCE(c.confidence, 0) < ?".into());
        p.push(Sql::Real(threshold));
    }
    if q.error_only {
        w.push("c.source = 'error'".into());
    }
    match q.cause.as_deref() {
        Some("none") => w.push("c.cause IS NULL".into()),
        Some(v) if !v.is_empty() => {
            w.push("c.cause = ?".into());
            p.push(Sql::Text(v.into()));
        }
        _ => {}
    }
    for f in &q.filters {
        let v = f.value.trim();
        if v.is_empty() {
            continue;
        }
        if let Some((e, arg)) = expr(&f.key) {
            w.push(format!("CAST({e} AS TEXT) LIKE ?"));
            if let Some(a) = arg {
                p.push(Sql::Text(a));
            }
            p.push(Sql::Text(format!("%{v}%")));
        }
    }
    (w.join(" AND "), p)
}

pub fn query(conn: &Connection, q: &Query) -> AppResult<Page> {
    let thr = crate::db::low_threshold(conn);
    let mut first_cols: Vec<String> = taxonomy::list_services(conn)?.into_iter().filter_map(|s| s.columns.into_iter().next()).collect();
    first_cols.dedup();
    let (w, mut p) = where_clause(q, thr, &first_cols);
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) {FROM} WHERE {w}"), params_from_iter(p.iter()), |r| r.get(0))?;
    let low_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) {FROM} WHERE c.source NOT IN ('human','error','unknown_service') AND COALESCE(c.confidence,0) < ?"),
        [thr],
        |r| r.get(0),
    )?;
    let (order, order_arg) = q.sort.as_deref().and_then(expr).unwrap_or(("t.date".into(), None));
    let dir = if q.desc || q.sort.is_none() { "DESC" } else { "ASC" };
    let sql = format!("SELECT {SELECT_COLS} {FROM} WHERE {w} ORDER BY {order} {dir} NULLS LAST, t.ticket_no {dir} LIMIT ? OFFSET ?");
    if let Some(a) = order_arg {
        p.push(Sql::Text(a));
    }
    p.push(Sql::Integer(q.limit.clamp(1, 1000) as i64));
    p.push(Sql::Integer(q.offset as i64));
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(p.iter()), map_row)?;
    Ok(Page { total: total as usize, low_count: low_count as usize, rows: rows.collect::<Result<_, _>>()? })
}

/// Every source-file column seen in this project (for "เพิ่มคอลัมน์จากไฟล์ต้นทาง").
pub fn source_columns(conn: &Connection) -> AppResult<Vec<String>> {
    let mut st = conn.prepare("SELECT source_json FROM tickets GROUP BY import_id")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    let mut out: Vec<String> = vec![];
    for r in rows {
        if let Ok(serde_json::Value::Object(m)) = serde_json::from_str::<serde_json::Value>(&r?) {
            for k in m.keys() {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
    }
    Ok(out)
}

pub const CAUSES: [&str; 3] = ["user", "program", "unclear"];

/// A person sets ต้นเหตุ for one or more classified tickets (any service). The AI's answer stays in
/// `ai_cause`; the category and its source are left alone.
pub fn set_cause(conn: &mut Connection, ticket_ids: &[String], cause: &str, user: &str) -> AppResult<usize> {
    if !CAUSES.contains(&cause) {
        return Err(AppError::new("invalid_cause", "ต้นเหตุต้องเป็น ผู้ใช้ โปรแกรม หรือ ไม่ชัดเจน"));
    }
    let tx = conn.transaction()?;
    let mut n = 0;
    {
        let mut st = tx.prepare(
            "UPDATE classifications SET cause = ?1, edited_by = ?2, updated_at = datetime('now')
             WHERE ticket_id = ?3 AND source NOT IN ('error', 'unknown_service')",
        )?;
        for id in ticket_ids {
            n += st.execute(rusqlite::params![cause, user, id])?;
        }
    }
    tx.commit()?;
    if n == 0 && !ticket_ids.is_empty() {
        return Err(AppError::new("not_classified", "ทิกเก็ตนี้ยังไม่ได้จัดหมวด — จัดหมวดก่อนแล้วค่อยแก้ต้นเหตุ"));
    }
    Ok(n)
}

/// Set the category of one or more tickets of ONE service (SPEC §8): must be a category of that
/// service; saved as `human`, the AI's original answer is kept.
pub fn set_category(conn: &mut Connection, ticket_ids: &[String], fields: &Values, user: &str) -> AppResult<usize> {
    if ticket_ids.is_empty() {
        return Ok(0);
    }
    let mut services = std::collections::HashSet::new();
    for id in ticket_ids {
        let s: String = conn.query_row("SELECT service FROM tickets WHERE id = ?1", [id], |r| r.get(0)).map_err(|_| AppError::new("not_found", "ไม่พบทิกเก็ต"))?;
        services.insert(s);
    }
    if services.len() != 1 {
        return Err(AppError::new("mixed_services", "แก้หลายแถวพร้อมกันได้เฉพาะทิกเก็ตของเซอร์วิสเดียวกัน"));
    }
    let name = services.into_iter().next().unwrap_or_default();
    let svc = taxonomy::find_service_by_name(conn, &name)?.ok_or_else(|| AppError::new("unknown_service", format!("เซอร์วิส {name} ยังไม่มีหมวดหมู่")))?;
    let rows = taxonomy::list_taxonomy(conn, &svc.id)?;
    let row = rows
        .iter()
        .find(|r| svc.columns.iter().all(|c| r.values.get(c) == fields.get(c)))
        .ok_or_else(|| AppError::new("invalid_category", "หมวดนี้ไม่อยู่ในตารางหมวดหมู่ของเซอร์วิส"))?;
    let json = serde_json::to_string(&row.values)?;
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare(
            "INSERT INTO classifications(ticket_id, fields_json, ai_fields_json, source, taxonomy_version, updated_at, edited_by)
             VALUES(?1, ?2, NULL, 'human', ?3, datetime('now'), ?4)
             ON CONFLICT(ticket_id) DO UPDATE SET fields_json = excluded.fields_json, source = 'human',
               taxonomy_version = excluded.taxonomy_version, updated_at = excluded.updated_at, edited_by = excluded.edited_by",
        )?;
        for id in ticket_ids {
            st.execute(rusqlite::params![id, json, svc.taxonomy_version, user])?;
        }
    }
    tx.commit()?;
    Ok(ticket_ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taxonomy::{create_service, save_row, RowInput};

    fn vals(a: &str, b: &str) -> Values {
        [("หัวข้อหลัก".to_string(), a.to_string()), ("หัวข้อย่อย".to_string(), b.to_string())].into_iter().collect()
    }

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let mut c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        let cols = vec!["หัวข้อหลัก".to_string(), "หัวข้อย่อย".to_string()];
        let s = create_service(&c, "Internet", None, &cols).unwrap();
        create_service(&c, "IPTV", None, &cols).unwrap();
        for (a, b) in [("การเชื่อมต่อ", "เน็ตหลุด"), ("ความเร็ว", "เน็ตช้า")] {
            save_row(&mut c, &s.id, &RowInput { id: None, values: vals(a, b), description: String::new(), examples: String::new() }).unwrap();
        }
        let rows = [
            ("T1", "2026-10-01", "Internet", "เน็ตหลุดทุกคืน", Some((vals("การเชื่อมต่อ", "เน็ตหลุด"), 0.95, "ai"))),
            ("T2", "2026-10-02", "Internet", "เน็ตช้าตอนเย็น", Some((vals("ความเร็ว", "เน็ตช้า"), 0.55, "ai"))),
            ("T3", "2026-09-15", "Internet", "หลุดบ่อย", Some((vals("การเชื่อมต่อ", "เน็ตหลุด"), 0.4, "human"))),
            ("T4", "2026-09-20", "IPTV", "ภาพค้าง", None),
        ];
        for (id, date, svc, text, cls) in rows {
            c.execute(
                "INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?1,?2,substr(?2,1,7),?3,?4,?5,'im1')",
                rusqlite::params![id, date, svc, text, format!("{{\"ช่องทาง\":\"{}\"}}", if id == "T2" { "แชต" } else { "โทร" })],
            )
            .unwrap();
            if let Some((f, conf, src)) = cls {
                c.execute(
                    "INSERT INTO classifications(ticket_id,fields_json,ai_fields_json,confidence,source) VALUES(?1,?2,?2,?3,?4)",
                    rusqlite::params![id, serde_json::to_string(&f).unwrap(), conf, src],
                )
                .unwrap();
            }
        }
        (dir, c)
    }

    #[test]
    fn cause_is_set_by_hand_filtered_and_kept_apart_from_the_ai_answer() {
        let (_d, mut c) = setup();
        c.execute("UPDATE classifications SET cause='program', ai_cause='program' WHERE ticket_id='T1'", []).unwrap();
        let q = |c: &Connection, cause: &str| ids(&query(c, &Query { limit: 50, cause: Some(cause.into()), ..Default::default() }).unwrap()).into_iter().map(String::from).collect::<Vec<_>>();
        assert_eq!(q(&c, "program"), vec!["T1"]);
        assert_eq!(q(&c, "none"), vec!["T2", "T4", "T3"]); // T4 has no classification row at all
        assert_eq!(set_cause(&mut c, &["T1".into(), "T2".into()], "user", "สมชาย").unwrap(), 2);
        let r = &query(&c, &Query { limit: 50, cause: Some("user".into()), ..Default::default() }).unwrap().rows;
        let t1 = r.iter().find(|x| x.id == "T1").unwrap();
        assert_eq!((t1.cause.as_deref(), t1.ai_cause.as_deref(), t1.source.as_str(), t1.edited_by.as_deref()), (Some("user"), Some("program"), "ai", Some("สมชาย")));
        assert!(set_cause(&mut c, &["T1".into()], "network", "x").is_err());
        assert!(set_cause(&mut c, &["T4".into()], "user", "x").is_err()); // not classified yet
    }

    fn ids(p: &Page) -> Vec<&str> {
        p.rows.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn filters_sorts_and_pages() {
        let (_d, c) = setup();
        let all = query(&c, &Query { limit: 50, ..Default::default() }).unwrap();
        assert_eq!(all.total, 4);
        assert_eq!(ids(&all), vec!["T2", "T1", "T4", "T3"]); // newest first
        assert_eq!(all.low_count, 1); // T2 only: human rows are never "low"
        assert_eq!(all.rows[2].source, "pending");
        let q = |q: Query| query(&c, &Query { limit: 50, ..q }).unwrap();
        assert_eq!(ids(&q(Query { search: Some("หลุด".into()), ..Default::default() })), vec!["T1", "T3"]);
        assert_eq!(ids(&q(Query { month: Some("2026-09".into()), ..Default::default() })), vec!["T4", "T3"]);
        assert_eq!(ids(&q(Query { low_only: true, ..Default::default() })), vec!["T2"]);
        assert_eq!(ids(&q(Query { category: Some("การเชื่อมต่อ".into()), ..Default::default() })), vec!["T1", "T3"]);
        let f = |key: &str, value: &str| vec![ColumnFilter { key: key.into(), value: value.into() }];
        assert_eq!(ids(&q(Query { filters: f("cat:หัวข้อย่อย", "ช้า"), ..Default::default() })), vec!["T2"]);
        assert_eq!(ids(&q(Query { filters: f("src:ช่องทาง", "แชต"), ..Default::default() })), vec!["T2"]);
        assert_eq!(ids(&q(Query { sort: Some("confidence".into()), desc: false, ..Default::default() })), vec!["T3", "T2", "T1", "T4"]);
        assert_eq!(ids(&q(Query { sort: Some("cat:หัวข้อหลัก".into()), desc: true, ..Default::default() }))[0], "T2");
        let page2 = query(&c, &Query { offset: 2, limit: 2, ..Default::default() }).unwrap();
        assert_eq!((page2.total, ids(&page2)), (4, vec!["T4", "T3"]));
        assert_eq!(source_columns(&c).unwrap(), vec!["ช่องทาง"]);
    }

    #[test]
    fn category_edits_keep_the_ai_answer_and_stay_within_one_service() {
        let (_d, mut c) = setup();
        let n = set_category(&mut c, &["T1".into(), "T2".into()], &vals("ความเร็ว", "เน็ตช้า"), "Somchai").unwrap();
        assert_eq!(n, 2);
        let r = query(&c, &Query { search: Some("T1".into()), limit: 5, ..Default::default() }).unwrap();
        let t1 = &r.rows[0];
        assert_eq!(t1.source, "human");
        assert_eq!(t1.fields, vals("ความเร็ว", "เน็ตช้า"));
        assert_eq!(t1.ai_fields, Some(vals("การเชื่อมต่อ", "เน็ตหลุด")));
        assert_eq!(t1.edited_by.as_deref(), Some("Somchai"));
        assert_eq!(set_category(&mut c, &["T1".into(), "T4".into()], &vals("ความเร็ว", "เน็ตช้า"), "x").unwrap_err().code, "mixed_services");
        assert_eq!(set_category(&mut c, &["T1".into()], &vals("ความเร็ว", "ไม่มีจริง"), "x").unwrap_err().code, "invalid_category");
        assert_eq!(set_category(&mut c, &["T4".into()], &vals("ความเร็ว", "เน็ตช้า"), "x").unwrap_err().code, "invalid_category");
    }
}
