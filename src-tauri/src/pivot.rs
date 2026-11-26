//! Pivot engine (SPEC §9): GROUP BY in SQLite, tree + subtotals assembled here.
//! Fields: `service`, `month`, `source`, `cat:<category column>`, `src:<source-file column>`.

use crate::errors::{AppError, AppResult};
use crate::results::{self, Row};
use crate::taxonomy;
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub const EMPTY: &str = "(ว่าง)";
pub const UNCLASSIFIED: &str = "(ยังไม่มีหมวด)";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Filter {
    pub field: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 1–3 fields, outer first
    pub rows: Vec<String>,
    /// one field across, usually `month`; empty = totals only
    #[serde(default)]
    pub col: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// yyyy-mm inclusive
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub key: String,
    pub values: Vec<u64>,
    pub total: u64,
    pub children: Vec<Node>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PivotResult {
    pub col_keys: Vec<String>,
    pub rows: Vec<Node>,
    pub grand: Vec<u64>,
    pub grand_total: u64,
}

fn json_path(col: &str) -> String {
    format!("$.\"{}\"", col.replace('"', "\\\""))
}

/// SQL for a field (+ its bound argument).
fn field_expr(field: &str) -> AppResult<(String, Option<String>)> {
    Ok(match field {
        "service" => ("t.service".into(), None),
        "month" => ("t.month".into(), None),
        "source" => ("COALESCE(c.source,'pending')".into(), None),
        f if f.starts_with("cat:") => ("json_extract(c.fields_json, ?)".into(), Some(json_path(&f[4..]))),
        f if f.starts_with("src:") => ("NULLIF(json_extract(t.source_json, ?), '')".into(), Some(json_path(&f[4..]))),
        _ => return Err(AppError::new("invalid_field", format!("ไม่รู้จักฟิลด์ {field}"))),
    })
}

const FROM: &str = "FROM tickets t LEFT JOIN classifications c ON c.ticket_id = t.id";

fn base_where(from: &str, to: &str, filters: &[Filter]) -> AppResult<(String, Vec<Sql>)> {
    let mut w = vec!["t.month BETWEEN ? AND ?".to_string()];
    let mut p = vec![Sql::Text(from.into()), Sql::Text(to.into())];
    for f in filters.iter().filter(|f| !f.values.is_empty()) {
        let (e, arg) = field_expr(&f.field)?;
        let empty = empty_label(&f.field);
        let mut ors = vec![];
        for v in &f.values {
            if let Some(a) = &arg {
                p.push(Sql::Text(a.clone()));
            }
            if v == empty {
                ors.push(format!("{e} IS NULL"));
            } else {
                ors.push(format!("{e} = ?"));
                p.push(Sql::Text(v.clone()));
            }
        }
        w.push(format!("({})", ors.join(" OR ")));
    }
    Ok((w.join(" AND "), p))
}

fn empty_label(field: &str) -> &'static str {
    if field.starts_with("cat:") { UNCLASSIFIED } else { EMPTY }
}

/// What SQLite groups by for a field: plain columns as is, every `cat:` field through the raw
/// `fields_json` text (few distinct values), `src:` fields through json_extract.
fn raw_expr(field: &str) -> AppResult<(String, Option<String>)> {
    if field.starts_with("cat:") {
        return Ok(("c.fields_json".into(), None));
    }
    field_expr(field)
}

/// Ticket counts by the values of `fields` in the month range: Vec<(values in field order, count)>.
/// Category values are read in Rust from each distinct `fields_json` once.
fn grouped(conn: &Connection, from: &str, to: &str, fields: &[String]) -> AppResult<Vec<(Vec<String>, u64)>> {
    let mut exprs: Vec<(String, Option<String>)> = vec![];
    let mut slot: Vec<usize> = vec![];
    for f in fields {
        let e = raw_expr(f)?;
        let i = match exprs.iter().position(|x| *x == e) {
            Some(i) => i,
            None => {
                exprs.push(e);
                exprs.len() - 1
            }
        };
        slot.push(i);
    }
    if exprs.is_empty() {
        exprs.push(("1".into(), None));
    }
    let mut p: Vec<Sql> = exprs.iter().filter_map(|(_, a)| a.clone().map(Sql::Text)).collect();
    p.push(Sql::Text(from.into()));
    p.push(Sql::Text(to.into()));
    let n = exprs.len();
    let sel: Vec<String> = exprs.iter().map(|(e, _)| format!("CAST({e} AS TEXT)")).collect();
    let groups: Vec<String> = (1..=n).map(|i| i.to_string()).collect();
    let sql = format!("SELECT {}, COUNT(*) {FROM} WHERE t.month BETWEEN ? AND ? GROUP BY {}", sel.join(", "), groups.join(", "));
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(p.iter()), |r| {
        let mut raw: Vec<Option<String>> = vec![];
        for i in 0..n {
            raw.push(r.get(i)?);
        }
        Ok((raw, r.get::<_, i64>(n)? as u64))
    })?;
    let mut parsed: HashMap<String, taxonomy::Values> = HashMap::new();
    let mut out = vec![];
    for r in rows {
        let (raw, count) = r?;
        let mut keys = Vec::with_capacity(fields.len());
        for (f, &i) in fields.iter().zip(&slot) {
            let v = match (f.strip_prefix("cat:"), &raw[i]) {
                (Some(col), Some(json)) => {
                    if !parsed.contains_key(json) {
                        parsed.insert(json.clone(), serde_json::from_str(json).unwrap_or_default());
                    }
                    parsed[json].get(col).cloned()
                }
                (Some(_), None) => None,
                (None, v) => v.clone(),
            };
            keys.push(v.filter(|s| !s.is_empty()).unwrap_or_else(|| empty_label(f).to_string()));
        }
        out.push((keys, count));
    }
    Ok(out)
}

fn sort_keys(field: &str, keys: &mut [String]) {
    if field == "month" {
        keys.sort();
    }
}

pub fn pivot(conn: &Connection, cfg: &Config) -> AppResult<PivotResult> {
    if cfg.rows.is_empty() || cfg.rows.len() > 3 {
        return Err(AppError::new("invalid_config", "เลือกแถวของ pivot 1–3 ฟิลด์"));
    }
    let has_col = !cfg.col.is_empty();
    let fields: Vec<String> = cfg.rows.iter().chain(std::iter::once(&cfg.col).filter(|c| !c.is_empty())).cloned().collect();
    let filters: Vec<&Filter> = cfg.filters.iter().filter(|f| !f.values.is_empty()).collect();
    let all: Vec<String> = fields.iter().cloned().chain(filters.iter().map(|f| f.field.clone())).collect();
    let mut cells: Vec<(Vec<String>, String, u64)> = vec![];
    for (keys, n) in grouped(conn, &cfg.from, &cfg.to, &all)? {
        // filters are applied here, after grouping, so SQLite never evaluates JSON per row
        let fkeys = &keys[fields.len()..];
        if filters.iter().zip(fkeys).any(|(f, k)| !f.values.contains(k)) {
            continue;
        }
        let mut keys = keys[..fields.len()].to_vec();
        let col = if has_col { keys.pop().unwrap_or_default() } else { String::new() };
        cells.push((keys, col, n));
    }
    // columns
    let mut col_keys: Vec<String> = if has_col {
        let mut k: Vec<String> = cells.iter().map(|c| c.1.clone()).collect();
        k.sort();
        k.dedup();
        k
    } else {
        vec![]
    };
    sort_keys(&cfg.col, &mut col_keys);
    let width = col_keys.len().max(1);
    let col_idx: HashMap<&str, usize> = col_keys.iter().enumerate().map(|(i, k)| (k.as_str(), i)).collect();
    // tree
    fn insert(nodes: &mut Vec<Node>, path: &[String], ci: usize, n: u64, width: usize) {
        let pos = match nodes.iter().position(|x| x.key == path[0]) {
            Some(p) => p,
            None => {
                nodes.push(Node { key: path[0].clone(), values: vec![0; width], total: 0, children: vec![] });
                nodes.len() - 1
            }
        };
        let node = &mut nodes[pos];
        node.values[ci] += n;
        node.total += n;
        if path.len() > 1 {
            insert(&mut node.children, &path[1..], ci, n, width);
        }
    }
    let mut tree: Vec<Node> = vec![];
    let mut grand = vec![0u64; width];
    for (keys, col, n) in &cells {
        let ci = if has_col { col_idx[col.as_str()] } else { 0 };
        insert(&mut tree, keys, ci, *n, width);
        grand[ci] += n;
    }
    fn order(nodes: &mut [Node], fields: &[String]) {
        if fields.first().map(|f| f == "month").unwrap_or(false) {
            nodes.sort_by(|a, b| a.key.cmp(&b.key));
        } else {
            nodes.sort_by(|a, b| b.total.cmp(&a.total).then(a.key.cmp(&b.key)));
        }
        for n in nodes.iter_mut() {
            order(&mut n.children, &fields[1..]);
        }
    }
    order(&mut tree, &cfg.rows);
    let grand_total = grand.iter().sum();
    Ok(PivotResult { col_keys: if has_col { col_keys } else { vec!["รวม".into()] }, rows: tree, grand, grand_total })
}

/// One pivot cell → its tickets (the row path and, if any, the column value).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    /// (field, value) from the outer row level down to the clicked one
    pub path: Vec<(String, String)>,
    pub col: Option<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drill {
    pub total: usize,
    pub rows: Vec<Row>,
}

pub fn drill(conn: &Connection, cfg: &Config, cell: &Cell, limit: usize) -> AppResult<Drill> {
    let (mut w, mut p) = base_where(&cfg.from, &cfg.to, &cfg.filters)?;
    for (field, value) in cell.path.iter().chain(cell.col.iter()) {
        let (e, arg) = field_expr(field)?;
        if let Some(a) = &arg {
            p.push(Sql::Text(a.clone()));
        }
        if value == empty_label(field) {
            // the expression appears twice → its argument too
            w.push_str(&format!(" AND ({e} IS NULL OR {e} = '')"));
            if let Some(a) = arg {
                p.push(Sql::Text(a));
            }
        } else {
            w.push_str(&format!(" AND {e} = ?"));
            p.push(Sql::Text(value.clone()));
        }
    }
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) {FROM} WHERE {w}"), params_from_iter(p.iter()), |r| r.get(0))?;
    p.push(Sql::Integer(limit.clamp(1, 1000) as i64));
    let sql = format!("SELECT {} {FROM} WHERE {w} ORDER BY t.date DESC, t.ticket_no DESC LIMIT ?", results::SELECT_COLS);
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(p.iter()), results::map_row)?;
    Ok(Drill { total: total as usize, rows: rows.collect::<Result<_, _>>()? })
}

// ---------------------------------------------------------------- charts

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub name: String,
    pub color: String,
    pub values: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopItem {
    pub service: String,
    pub category: String,
    pub color: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Charts {
    pub months: Vec<String>,
    /// monthly ticket count per service
    pub trend: Vec<Series>,
    /// top 5 (service › top-level category) of the latest month
    pub top: Vec<TopItem>,
}

pub fn charts(conn: &Connection, from: &str, to: &str, filters: &[Filter]) -> AppResult<Charts> {
    let services = taxonomy::list_services(conn)?;
    let colors: HashMap<String, String> = services.iter().map(|s| (s.name.clone(), s.color.clone())).collect();
    // the top-level category column has a different name per service
    let first_col: HashMap<String, String> = services.iter().filter_map(|s| s.columns.first().map(|c| (s.name.clone(), format!("cat:{c}")))).collect();
    let mut cat_fields: Vec<String> = first_col.values().cloned().collect();
    cat_fields.sort();
    cat_fields.dedup();
    let active: Vec<&Filter> = filters.iter().filter(|f| !f.values.is_empty()).collect();
    let all: Vec<String> = ["service".to_string(), "month".to_string()].into_iter().chain(cat_fields.iter().cloned()).chain(active.iter().map(|f| f.field.clone())).collect();
    let mut months: Vec<String> = vec![];
    let mut per_service: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut per_cat: HashMap<(String, String, String), u64> = HashMap::new();
    for (keys, n) in grouped(conn, from, to, &all)? {
        let fkeys = &keys[2 + cat_fields.len()..];
        if active.iter().zip(fkeys).any(|(f, k)| !f.values.contains(k)) {
            continue;
        }
        let (svc, month) = (keys[0].clone(), keys[1].clone());
        let cat = first_col
            .get(&svc)
            .and_then(|f| cat_fields.iter().position(|x| x == f))
            .map(|i| keys[2 + i].clone())
            .filter(|v| v != UNCLASSIFIED);
        if !months.contains(&month) {
            months.push(month.clone());
        }
        *per_service.entry(svc.clone()).or_default().entry(month.clone()).or_default() += n;
        if let Some(cat) = cat {
            *per_cat.entry((month, svc, cat)).or_default() += n;
        }
    }
    months.sort();
    let mut trend: Vec<Series> = per_service
        .into_iter()
        .map(|(name, m)| Series { color: colors.get(&name).cloned().unwrap_or_else(|| "#5B6270".into()), values: months.iter().map(|k| *m.get(k).unwrap_or(&0)).collect(), name })
        .collect();
    trend.sort_by_key(|s| std::cmp::Reverse(s.values.iter().sum::<u64>()));
    let last = months.last().cloned().unwrap_or_default();
    let mut top: Vec<TopItem> = per_cat
        .into_iter()
        .filter(|((m, _, _), _)| *m == last)
        .map(|((_, service, category), count)| TopItem { color: colors.get(&service).cloned().unwrap_or_else(|| "#5B6270".into()), service, category, count })
        .collect();
    top.sort_by(|a, b| b.count.cmp(&a.count).then(a.service.cmp(&b.service)).then(a.category.cmp(&b.category)));
    top.truncate(5);
    Ok(Charts { months, trend, top })
}

/// Distinct values of a field in the period (for filter chips).
pub fn field_values(conn: &Connection, field: &str, from: &str, to: &str) -> AppResult<Vec<String>> {
    let (e, arg) = field_expr(field)?;
    let mut p: Vec<Sql> = arg.into_iter().map(Sql::Text).collect();
    p.push(Sql::Text(from.into()));
    p.push(Sql::Text(to.into()));
    let sql = format!("SELECT DISTINCT {e} {FROM} WHERE t.month BETWEEN ? AND ? ORDER BY 1 LIMIT 500");
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(p.iter()), |r| r.get::<_, Option<String>>(0))?;
    let mut out = vec![];
    for r in rows {
        out.push(r?.filter(|s| !s.is_empty()).unwrap_or_else(|| empty_label(field).to_string()));
    }
    out.dedup();
    Ok(out)
}

// ---------------------------------------------------------------- saved views

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub name: String,
    /// the frontend's view config (rows, col, value, filters, heatmap), as JSON
    pub config: serde_json::Value,
}

pub fn list_views(conn: &Connection) -> AppResult<Vec<SavedView>> {
    let mut st = conn.prepare("SELECT id, name, config_json FROM saved_views ORDER BY sort, rowid")?;
    let rows = st.query_map([], |r| {
        let c: String = r.get(2)?;
        Ok(SavedView { id: r.get(0)?, name: r.get(1)?, config: serde_json::from_str(&c).unwrap_or(serde_json::Value::Null) })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn save_view(conn: &Connection, id: Option<&str>, name: &str, config: &serde_json::Value) -> AppResult<SavedView> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::new("invalid_name", "ใส่ชื่อมุมมองก่อน"));
    }
    let id = id.map(str::to_string).unwrap_or_else(|| format!("v-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
    let sort: i64 = conn.query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM saved_views", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO saved_views(id, name, config_json, sort) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json",
        rusqlite::params![id, name, serde_json::to_string(config)?, sort],
    )?;
    Ok(SavedView { id, name, config: config.clone() })
}

pub fn delete_view(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM saved_views WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taxonomy::{create_service, save_row, RowInput, Values};

    fn vals(a: &str, b: &str) -> Values {
        [("หัวข้อหลัก".to_string(), a.to_string()), ("หัวข้อย่อย".to_string(), b.to_string())].into_iter().collect()
    }

    /// (service, month, main, sub or None = unclassified, channel)
    fn seed(c: &mut Connection, rows: &[(&str, &str, &str, Option<&str>, &str)]) {
        let cols = vec!["หัวข้อหลัก".to_string(), "หัวข้อย่อย".to_string()];
        for svc in ["Internet", "IPTV"] {
            let s = create_service(c, svc, None, &cols).unwrap();
            save_row(c, &s.id, &RowInput { id: None, values: vals("x", "y"), description: String::new(), examples: String::new() }).unwrap();
        }
        let tx = c.transaction().unwrap();
        for (i, (svc, month, main, sub, ch)) in rows.iter().enumerate() {
            let id = format!("T{i}");
            tx.execute(
                "INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?1,?2||'-01',?2,?3,'x',?4,'im')",
                rusqlite::params![id, month, svc, format!("{{\"ช่องทาง\":\"{ch}\"}}")],
            )
            .unwrap();
            if let Some(sub) = sub {
                tx.execute(
                    "INSERT INTO classifications(ticket_id,fields_json,source,confidence) VALUES(?1,?2,'ai',0.9)",
                    rusqlite::params![id, serde_json::to_string(&vals(main, sub)).unwrap()],
                )
                .unwrap();
            }
        }
        tx.commit().unwrap();
    }

    fn db(rows: &[(&str, &str, &str, Option<&str>, &str)]) -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let mut c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        seed(&mut c, rows);
        (dir, c)
    }

    fn cfg(rows: &[&str], col: &str) -> Config {
        Config { rows: rows.iter().map(|s| s.to_string()).collect(), col: col.into(), filters: vec![], from: "2026-01".into(), to: "2026-12".into() }
    }

    const DATA: &[(&str, &str, &str, Option<&str>, &str)] = &[
        ("Internet", "2026-09", "การเชื่อมต่อ", Some("หลุด"), "โทร"),
        ("Internet", "2026-09", "การเชื่อมต่อ", Some("ไม่มีเน็ต"), "แชต"),
        ("Internet", "2026-10", "การเชื่อมต่อ", Some("หลุด"), "โทร"),
        ("Internet", "2026-10", "การเชื่อมต่อ", Some("หลุด"), "โทร"),
        ("Internet", "2026-10", "ความเร็ว", Some("ช้า"), "โทร"),
        ("IPTV", "2026-10", "ภาพ", Some("ค้าง"), "แชต"),
        ("IPTV", "2026-08", "ภาพ", None, "โทร"),
    ];

    #[test]
    fn subtotals_grand_totals_and_month_columns() {
        let (_d, c) = db(DATA);
        let p = pivot(&c, &cfg(&["service", "cat:หัวข้อหลัก"], "month")).unwrap();
        assert_eq!(p.col_keys, vec!["2026-08", "2026-09", "2026-10"]);
        assert_eq!(p.grand, vec![1, 2, 4]);
        assert_eq!(p.grand_total, 7);
        let net = &p.rows[0];
        assert_eq!((net.key.as_str(), net.total, net.values.clone()), ("Internet", 5, vec![0, 2, 3]));
        assert_eq!(net.children[0].key, "การเชื่อมต่อ"); // biggest first
        assert_eq!(net.children[0].values, vec![0, 2, 2]);
        let tv = &p.rows[1];
        assert_eq!(tv.children.iter().find(|n| n.key == UNCLASSIFIED).unwrap().values, vec![1, 0, 0]);
        // three levels, a source column across
        let p3 = pivot(&c, &cfg(&["service", "cat:หัวข้อหลัก", "cat:หัวข้อย่อย"], "src:ช่องทาง")).unwrap();
        assert_eq!(p3.col_keys, vec!["แชต", "โทร"]);
        assert_eq!(p3.rows[0].children[0].children.len(), 2);
        // no column field → one total column
        let p0 = pivot(&c, &cfg(&["month"], "")).unwrap();
        assert_eq!(p0.rows.iter().map(|n| n.key.as_str()).collect::<Vec<_>>(), vec!["2026-08", "2026-09", "2026-10"]);
        assert_eq!(p0.grand, vec![7]);
    }

    #[test]
    fn filters_and_month_range() {
        let (_d, c) = db(DATA);
        let mut k = cfg(&["service"], "month");
        k.from = "2026-09".into();
        k.filters = vec![Filter { field: "src:ช่องทาง".into(), values: vec!["โทร".into()] }];
        let p = pivot(&c, &k).unwrap();
        assert_eq!(p.grand_total, 4);
        assert_eq!(p.col_keys, vec!["2026-09", "2026-10"]);
        k.filters = vec![Filter { field: "cat:หัวข้อหลัก".into(), values: vec![UNCLASSIFIED.into()] }];
        k.from = "2026-01".into();
        assert_eq!(pivot(&c, &k).unwrap().grand_total, 1);
        assert_eq!(field_values(&c, "cat:หัวข้อหลัก", "2026-01", "2026-12").unwrap(), vec![UNCLASSIFIED, "การเชื่อมต่อ", "ความเร็ว", "ภาพ"]);
    }

    #[test]
    fn drill_matches_the_cell_count() {
        let (_d, c) = db(DATA);
        let k = cfg(&["service", "cat:หัวข้อหลัก"], "month");
        let cell = Cell { path: vec![("service".into(), "Internet".into()), ("cat:หัวข้อหลัก".into(), "การเชื่อมต่อ".into())], col: Some(("month".into(), "2026-10".into())) };
        let d = drill(&c, &k, &cell, 50).unwrap();
        assert_eq!(d.total, 2);
        assert!(d.rows.iter().all(|r| r.month == "2026-10" && r.service == "Internet"));
        let un = Cell { path: vec![("service".into(), "IPTV".into()), ("cat:หัวข้อหลัก".into(), UNCLASSIFIED.into())], col: None };
        assert_eq!(drill(&c, &k, &un, 50).unwrap().total, 1);
    }

    #[test]
    fn charts_trend_and_top5_of_the_last_month() {
        let (_d, c) = db(DATA);
        let ch = charts(&c, "2026-01", "2026-12", &[]).unwrap();
        assert_eq!(ch.months, vec!["2026-08", "2026-09", "2026-10"]);
        assert_eq!(ch.trend[0].name, "Internet");
        assert_eq!(ch.trend[0].values, vec![0, 2, 3]);
        assert_eq!(ch.top[0].category, "การเชื่อมต่อ");
        assert_eq!(ch.top[0].count, 2);
        assert_eq!(ch.top.len(), 3);
    }

    #[test]
    fn saved_views_round_trip() {
        let (_d, c) = db(&[]);
        let v = save_view(&c, None, "รายงานประจำเดือน", &serde_json::json!({"rows":["service"]})).unwrap();
        save_view(&c, Some(&v.id), "รายงาน", &serde_json::json!({"rows":["month"]})).unwrap();
        let all = list_views(&c).unwrap();
        assert_eq!((all.len(), all[0].name.as_str()), (1, "รายงาน"));
        delete_view(&c, &v.id).unwrap();
        assert!(list_views(&c).unwrap().is_empty());
    }

    /// SPEC: pivot answers within 300 ms at 50,000 tickets over 12 months.
    /// `cargo test --release pivot_benchmark -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn pivot_benchmark_50k_tickets_12_months() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        let mains = ["การเชื่อมต่อ", "ความเร็ว", "บริการติดตั้ง", "บิล", "สัญญาณ"];
        let subs = ["ก", "ข", "ค", "ง"];
        let mut rows: Vec<(String, String, String, String, String)> = vec![];
        for i in 0..50_000usize {
            let svc = ["Internet", "IPTV"][i % 2];
            rows.push((svc.into(), format!("2026-{:02}", i % 12 + 1), mains[i % 5].into(), subs[i % 4].into(), ["โทร", "แชต", "อีเมล"][i % 3].into()));
        }
        let borrowed: Vec<(&str, &str, &str, Option<&str>, &str)> = rows.iter().map(|r| (r.0.as_str(), r.1.as_str(), r.2.as_str(), Some(r.3.as_str()), r.4.as_str())).collect();
        seed(&mut c, &borrowed);
        let k = cfg(&["service", "cat:หัวข้อหลัก"], "month");
        pivot(&c, &k).unwrap(); // warm
        let t = std::time::Instant::now();
        let p = pivot(&c, &k).unwrap();
        let ms = t.elapsed().as_millis();
        let t2 = std::time::Instant::now();
        charts(&c, "2026-01", "2026-12", &[]).unwrap();
        let ms2 = t2.elapsed().as_millis();
        println!("pivot 50k×12: {ms} ms · charts: {ms2} ms");
        assert_eq!(p.grand_total, 50_000);
        assert_eq!(p.col_keys.len(), 12);
        assert!(ms < 300, "pivot took {ms} ms");
        assert!(ms2 < 300, "charts took {ms2} ms");
    }
}
