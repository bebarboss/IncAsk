//! Services and their category tables (SPEC §7): CRUD, column management, Excel import with
//! validation, the template, and `taxonomy_version` (bumped on every change so old cache entries
//! stop matching — SPEC §6.3).

use crate::errors::{AppError, AppResult};
use crate::ingest::sheet;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Default service colours (SPEC §11.2) — all pass contrast on white.
pub const SERVICE_COLORS: [&str; 8] = ["#2F6FB0", "#7B4FB0", "#C2631A", "#5B6270", "#0E7C74", "#B83E78", "#8A6D1F", "#3F7A2E"];
pub const COL_SERVICE: &str = "เซอร์วิส";
pub const COL_DESC: &str = "คำอธิบาย";
pub const COL_EXAMPLES: &str = "ตัวอย่าง";
const MAX_NAME: usize = 60;

pub type Values = BTreeMap<String, String>;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub name: String,
    pub color: String,
    pub columns: Vec<String>,
    pub taxonomy_version: i64,
    pub sort: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaxonomyRow {
    pub id: String,
    pub service_id: String,
    /// C01, C02 … in table order — what the LLM answers with (SPEC §6.1)
    pub code: String,
    pub values: Values,
    pub description: String,
    pub examples: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowInput {
    pub id: Option<String>,
    pub values: Values,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub examples: String,
}

/// One column in "จัดการคอลัมน์": `from` = its current name (None for a new column).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub from: Option<String>,
    pub name: String,
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

fn tidy(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_reserved(col: &str) -> bool {
    let c = col.trim().to_lowercase();
    matches!(c.as_str(), "เซอร์วิส" | "service" | "คำอธิบาย" | "description" | "ตัวอย่าง" | "example" | "examples")
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

fn clean_columns(cols: &[String]) -> AppResult<Vec<String>> {
    let cols: Vec<String> = cols.iter().map(|c| tidy(c)).collect();
    if cols.is_empty() || cols.iter().any(|c| c.is_empty()) {
        return Err(AppError::new("invalid_columns", "ต้องมีคอลัมน์หมวดหมู่อย่างน้อย 1 คอลัมน์ และห้ามเว้นชื่อว่าง"));
    }
    if let Some(c) = cols.iter().find(|c| is_reserved(c)) {
        return Err(AppError::new("invalid_columns", format!("\"{c}\" เป็นชื่อคอลัมน์พิเศษ ใช้เป็นคอลัมน์หมวดหมู่ไม่ได้")));
    }
    for (i, c) in cols.iter().enumerate() {
        if cols[..i].iter().any(|x| x.eq_ignore_ascii_case(c)) {
            return Err(AppError::new("invalid_columns", format!("ชื่อคอลัมน์ \"{c}\" ซ้ำกัน")));
        }
    }
    Ok(cols)
}

// ---------------------------------------------------------------- services

fn row_to_service(r: &rusqlite::Row) -> rusqlite::Result<Service> {
    let cols: String = r.get(3)?;
    Ok(Service {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        columns: serde_json::from_str(&cols).unwrap_or_default(),
        taxonomy_version: r.get(4)?,
        sort: r.get(5)?,
    })
}

const SERVICE_COLS: &str = "id, name, color, columns_json, taxonomy_version, COALESCE(sort, 0)";

pub fn list_services(conn: &Connection) -> AppResult<Vec<Service>> {
    let mut st = conn.prepare(&format!("SELECT {SERVICE_COLS} FROM services ORDER BY sort, name"))?;
    let rows = st.query_map([], row_to_service)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_service(conn: &Connection, id: &str) -> AppResult<Service> {
    conn.query_row(&format!("SELECT {SERVICE_COLS} FROM services WHERE id = ?1"), [id], row_to_service)
        .optional()?
        .ok_or_else(|| AppError::new("not_found", "ไม่พบเซอร์วิส"))
}

pub fn find_service_by_name(conn: &Connection, name: &str) -> AppResult<Option<Service>> {
    Ok(conn.query_row(&format!("SELECT {SERVICE_COLS} FROM services WHERE name = ?1"), [name], row_to_service).optional()?)
}

fn check_service_name(conn: &Connection, name: &str, except: Option<&str>) -> AppResult<String> {
    let n = tidy(name);
    if n.is_empty() || n.chars().count() > MAX_NAME {
        return Err(AppError::new("invalid_name", format!("ชื่อเซอร์วิสต้องยาว 1–{MAX_NAME} ตัวอักษร")));
    }
    let clash: Option<String> = conn
        .query_row("SELECT id FROM services WHERE lower(name) = lower(?1)", [&n], |r| r.get(0))
        .optional()?;
    if clash.is_some_and(|id| Some(id.as_str()) != except) {
        return Err(AppError::new("duplicate_name", format!("มีเซอร์วิสชื่อ \"{n}\" อยู่แล้ว")));
    }
    Ok(n)
}

fn next_color(conn: &Connection) -> AppResult<String> {
    let used: Vec<String> = list_services(conn)?.into_iter().map(|s| s.color.to_uppercase()).collect();
    Ok(SERVICE_COLORS.iter().find(|c| !used.contains(&c.to_string())).unwrap_or(&SERVICE_COLORS[used.len() % 8]).to_string())
}

pub fn create_service(conn: &Connection, name: &str, color: Option<&str>, columns: &[String]) -> AppResult<Service> {
    let name = check_service_name(conn, name, None)?;
    let columns = clean_columns(columns)?;
    let color = match color {
        Some(c) if valid_color(c) => c.to_uppercase(),
        Some(_) => return Err(AppError::new("invalid_color", "สีไม่ถูกต้อง")),
        None => next_color(conn)?,
    };
    let id = new_id("s-");
    let sort: i64 = conn.query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM services", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO services(id, name, color, columns_json, taxonomy_version, sort) VALUES(?1, ?2, ?3, ?4, 1, ?5)",
        params![id, name, color, serde_json::to_string(&columns)?, sort],
    )?;
    get_service(conn, &id)
}

/// Rename / recolour. Tickets store the service by name, so a rename carries them along.
pub fn update_service(conn: &mut Connection, id: &str, name: Option<&str>, color: Option<&str>) -> AppResult<Service> {
    let cur = get_service(conn, id)?;
    let tx = conn.transaction()?;
    if let Some(n) = name {
        let n = check_service_name(&tx, n, Some(id))?;
        if n != cur.name {
            tx.execute("UPDATE services SET name = ?1 WHERE id = ?2", params![n, id])?;
            tx.execute("UPDATE tickets SET service = ?1 WHERE service = ?2", params![n, cur.name])?;
        }
    }
    if let Some(c) = color {
        if !valid_color(c) {
            return Err(AppError::new("invalid_color", "สีไม่ถูกต้อง"));
        }
        tx.execute("UPDATE services SET color = ?1 WHERE id = ?2", params![c.to_uppercase(), id])?;
    }
    tx.commit()?;
    get_service(conn, id)
}

/// Deletes the service and its categories. Its tickets stay, and show as "ไม่มีหมวดหมู่".
pub fn delete_service(conn: &Connection, id: &str) -> AppResult<()> {
    get_service(conn, id)?;
    conn.execute("DELETE FROM services WHERE id = ?1", [id])?;
    Ok(())
}

pub fn bump_version(conn: &Connection, service_id: &str) -> AppResult<()> {
    conn.execute("UPDATE services SET taxonomy_version = taxonomy_version + 1 WHERE id = ?1", [service_id])?;
    Ok(())
}

/// Replace the category columns. Renamed columns keep their values (in rows and in classified
/// tickets); removed columns are dropped; new columns start empty.
pub fn set_columns(conn: &mut Connection, id: &str, specs: &[ColumnSpec]) -> AppResult<Service> {
    let svc = get_service(conn, id)?;
    let names = clean_columns(&specs.iter().map(|s| s.name.clone()).collect::<Vec<_>>())?;
    let remap = |old: &Values| -> Values {
        specs
            .iter()
            .zip(&names)
            .map(|(s, n)| (n.clone(), s.from.as_ref().and_then(|f| old.get(f)).cloned().unwrap_or_default()))
            .collect()
    };
    let tx = conn.transaction()?;
    for r in list_rows(&tx, id)? {
        tx.execute("UPDATE taxonomy_rows SET values_json = ?1 WHERE id = ?2", params![serde_json::to_string(&remap(&r.values))?, r.id])?;
    }
    for (ticket, fields, ai) in classified_for_service(&tx, &svc.name)? {
        let f = fields.map(|v| serde_json::to_string(&remap(&v))).transpose()?;
        let a = ai.map(|v| serde_json::to_string(&remap(&v))).transpose()?;
        tx.execute("UPDATE classifications SET fields_json = ?1, ai_fields_json = ?2 WHERE ticket_id = ?3", params![f, a, ticket])?;
    }
    tx.execute("UPDATE services SET columns_json = ?1 WHERE id = ?2", params![serde_json::to_string(&names)?, id])?;
    bump_version(&tx, id)?;
    tx.commit()?;
    get_service(conn, id)
}

// ---------------------------------------------------------------- rows

pub fn code_for(index: usize) -> String {
    format!("C{:02}", index + 1)
}

fn list_rows(conn: &Connection, service_id: &str) -> AppResult<Vec<TaxonomyRow>> {
    let mut st = conn.prepare(
        "SELECT id, service_id, values_json, COALESCE(description,''), COALESCE(examples,'') FROM taxonomy_rows
         WHERE service_id = ?1 ORDER BY sort, rowid",
    )?;
    let rows = st.query_map([service_id], |r| {
        let v: String = r.get(2)?;
        Ok(TaxonomyRow {
            id: r.get(0)?,
            service_id: r.get(1)?,
            code: String::new(),
            values: serde_json::from_str(&v).unwrap_or_default(),
            description: r.get(3)?,
            examples: r.get(4)?,
        })
    })?;
    let mut out: Vec<TaxonomyRow> = rows.collect::<Result<_, _>>()?;
    for (i, r) in out.iter_mut().enumerate() {
        r.code = code_for(i);
    }
    Ok(out)
}

pub fn list_taxonomy(conn: &Connection, service_id: &str) -> AppResult<Vec<TaxonomyRow>> {
    get_service(conn, service_id)?;
    list_rows(conn, service_id)
}

/// (ticket id, current fields, ai fields) for every classified ticket of a service.
type Classified = (String, Option<Values>, Option<Values>);
fn classified_for_service(conn: &Connection, service_name: &str) -> AppResult<Vec<Classified>> {
    let mut st = conn.prepare(
        "SELECT c.ticket_id, c.fields_json, c.ai_fields_json FROM classifications c JOIN tickets t ON t.id = c.ticket_id
         WHERE t.service = ?1",
    )?;
    let parse = |s: Option<String>| s.and_then(|j| serde_json::from_str::<Values>(&j).ok());
    let rows = st.query_map([service_name], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?)))?;
    let mut out = Vec::new();
    for r in rows {
        let (id, f, a) = r?;
        out.push((id, parse(f), parse(a)));
    }
    Ok(out)
}

fn same(a: &Values, b: &Values, cols: &[String]) -> bool {
    cols.iter().all(|c| a.get(c).map(|s| s.as_str()).unwrap_or("") == b.get(c).map(|s| s.as_str()).unwrap_or(""))
}

fn validate_row(svc: &Service, existing: &[TaxonomyRow], row: &RowInput) -> AppResult<Values> {
    let mut v = Values::new();
    for c in &svc.columns {
        let val = tidy(row.values.get(c).map(|s| s.as_str()).unwrap_or(""));
        if val.is_empty() {
            return Err(AppError::new("invalid_row", format!("ช่อง \"{c}\" ว่าง")));
        }
        v.insert(c.clone(), val);
    }
    if existing.iter().any(|r| Some(&r.id) != row.id.as_ref() && same(&r.values, &v, &svc.columns)) {
        return Err(AppError::new("duplicate_row", "มีหมวดนี้อยู่แล้ว"));
    }
    Ok(v)
}

/// Add or edit one category. Editing its values moves the tickets already classified into it.
pub fn save_row(conn: &mut Connection, service_id: &str, row: &RowInput) -> AppResult<TaxonomyRow> {
    let svc = get_service(conn, service_id)?;
    let existing = list_rows(conn, service_id)?;
    let values = validate_row(&svc, &existing, row)?;
    let tx = conn.transaction()?;
    let id = match &row.id {
        Some(id) => {
            let old = existing.iter().find(|r| &r.id == id).ok_or_else(|| AppError::new("not_found", "ไม่พบหมวดนี้"))?;
            if !same(&old.values, &values, &svc.columns) {
                for (ticket, fields, _) in classified_for_service(&tx, &svc.name)? {
                    if fields.as_ref().is_some_and(|f| same(f, &old.values, &svc.columns)) {
                        tx.execute("UPDATE classifications SET fields_json = ?1 WHERE ticket_id = ?2", params![serde_json::to_string(&values)?, ticket])?;
                    }
                }
            }
            tx.execute(
                "UPDATE taxonomy_rows SET values_json = ?1, description = ?2, examples = ?3 WHERE id = ?4",
                params![serde_json::to_string(&values)?, row.description.trim(), row.examples.trim(), id],
            )?;
            id.clone()
        }
        None => {
            let id = new_id("t-");
            let sort: i64 = tx.query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM taxonomy_rows WHERE service_id = ?1", [service_id], |r| r.get(0))?;
            tx.execute(
                "INSERT INTO taxonomy_rows(id, service_id, values_json, description, examples, sort) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, service_id, serde_json::to_string(&values)?, row.description.trim(), row.examples.trim(), sort],
            )?;
            id
        }
    };
    bump_version(&tx, service_id)?;
    tx.commit()?;
    list_rows(conn, service_id)?.into_iter().find(|r| r.id == id).ok_or_else(|| AppError::new("not_found", "ไม่พบหมวดนี้"))
}

fn row_by_id(conn: &Connection, row_id: &str) -> AppResult<(TaxonomyRow, Service)> {
    let service_id: String = conn
        .query_row("SELECT service_id FROM taxonomy_rows WHERE id = ?1", [row_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::new("not_found", "ไม่พบหมวดนี้"))?;
    let svc = get_service(conn, &service_id)?;
    let row = list_rows(conn, &service_id)?.into_iter().find(|r| r.id == row_id).ok_or_else(|| AppError::new("not_found", "ไม่พบหมวดนี้"))?;
    Ok((row, svc))
}

/// Tickets currently classified into this category.
pub fn row_usage(conn: &Connection, row_id: &str) -> AppResult<Vec<String>> {
    let (row, svc) = row_by_id(conn, row_id)?;
    Ok(classified_for_service(conn, &svc.name)?
        .into_iter()
        .filter(|(_, f, _)| f.as_ref().is_some_and(|f| same(f, &row.values, &svc.columns)))
        .map(|(id, _, _)| id)
        .collect())
}

/// Delete a category. Its tickets are either moved to `move_to` (another category of the same
/// service) or un-classified so the next run classifies them again (SPEC §7).
pub fn delete_row(conn: &mut Connection, row_id: &str, move_to: Option<&str>) -> AppResult<usize> {
    let (_, svc) = row_by_id(conn, row_id)?;
    let tickets = row_usage(conn, row_id)?;
    let target = match move_to {
        Some(t) => {
            let (tr, tsvc) = row_by_id(conn, t)?;
            if tsvc.id != svc.id || tr.id == row_id {
                return Err(AppError::new("invalid_target", "ย้ายได้เฉพาะไปหมวดอื่นของเซอร์วิสเดียวกัน"));
            }
            Some(tr.values)
        }
        None => None,
    };
    let tx = conn.transaction()?;
    for t in &tickets {
        match &target {
            Some(v) => {
                tx.execute(
                    "UPDATE classifications SET fields_json = ?1, source = 'human', updated_at = datetime('now') WHERE ticket_id = ?2",
                    params![serde_json::to_string(v)?, t],
                )?;
            }
            None => {
                tx.execute("DELETE FROM classifications WHERE ticket_id = ?1", [t])?;
            }
        }
    }
    tx.execute("DELETE FROM taxonomy_rows WHERE id = ?1", [row_id])?;
    bump_version(&tx, &svc.id)?;
    tx.commit()?;
    Ok(tickets.len())
}

// ---------------------------------------------------------------- Excel import

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// row number in the file (1-based, as Excel shows it)
    pub row: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePreview {
    pub name: String,
    /// an existing service of that name will be replaced
    pub exists: bool,
    pub existing_rows: usize,
    pub columns: Vec<String>,
    pub rows: Vec<RowInput>,
    /// rows left out (empty category cell, duplicate)
    pub errors: Vec<Issue>,
    /// kept but worth fixing (no description)
    pub warnings: Vec<Issue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub file_name: String,
    pub services: Vec<ServicePreview>,
}

/// Parse a category file: one service per file (named by `default_service`), or one file with a
/// `เซอร์วิส` column. Every other header except `คำอธิบาย` / `ตัวอย่าง` is a category column, left
/// to right. Upper-level cells left blank under a merged/grouped heading are filled down.
pub fn parse_import(rows: &[Vec<String>], default_service: Option<&str>) -> AppResult<Vec<ServicePreview>> {
    let h = sheet::header_row(rows).ok_or_else(|| AppError::new("no_header", "ไม่พบแถวหัวตารางในไฟล์ (ต้องมีหัวคอลัมน์อย่างน้อย 2 ช่อง)"))?;
    let headers: Vec<String> = rows[h].iter().map(|c| tidy(c)).collect();
    let find = |names: &[&str]| headers.iter().position(|x| names.iter().any(|n| x.eq_ignore_ascii_case(n)));
    let svc_col = find(&[COL_SERVICE, "service"]);
    let desc_col = find(&[COL_DESC, "description"]);
    let ex_col = find(&[COL_EXAMPLES, "example", "examples"]);
    let cat_cols: Vec<usize> = (0..headers.len())
        .filter(|i| Some(*i) != svc_col && Some(*i) != desc_col && Some(*i) != ex_col && !headers[*i].is_empty())
        .collect();
    if cat_cols.is_empty() {
        return Err(AppError::new("no_columns", "ไม่พบคอลัมน์หมวดหมู่ (คอลัมน์อื่นนอกจาก เซอร์วิส, คำอธิบาย, ตัวอย่าง)"));
    }
    let columns: Vec<String> = cat_cols.iter().map(|&i| headers[i].clone()).collect();
    if svc_col.is_none() && default_service.map(str::trim).unwrap_or("").is_empty() {
        return Err(AppError::new("no_service", "ไฟล์ไม่มีคอลัมน์ \"เซอร์วิส\" — เลือกเซอร์วิสที่จะนำเข้าก่อน"));
    }
    let cell = |r: &Vec<String>, i: usize| tidy(r.get(i).map(|s| s.as_str()).unwrap_or(""));
    let mut out: Vec<ServicePreview> = Vec::new();
    let mut last_service = String::new();
    // fill-down memory per service
    let mut carry: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (ri, r) in rows.iter().enumerate().skip(h + 1) {
        if r.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let line = ri + 1;
        let service = match svc_col {
            Some(i) => {
                let s = cell(r, i);
                if s.is_empty() { last_service.clone() } else { s }
            }
            None => tidy(default_service.unwrap_or("")),
        };
        if service.is_empty() {
            continue;
        }
        last_service = service.clone();
        let idx = match out.iter().position(|s| s.name == service) {
            Some(i) => i,
            None => {
                out.push(ServicePreview { name: service.clone(), exists: false, existing_rows: 0, columns: columns.clone(), rows: vec![], errors: vec![], warnings: vec![] });
                out.len() - 1
            }
        };
        let prev = carry.entry(service.clone()).or_insert_with(|| vec![String::new(); cat_cols.len()]);
        let mut vals: Vec<String> = cat_cols.iter().map(|&i| cell(r, i)).collect();
        let last = vals.len() - 1;
        for (k, v) in vals.iter_mut().enumerate() {
            if v.is_empty() && k < last && !prev[k].is_empty() {
                *v = prev[k].clone();
            }
        }
        *prev = vals.clone();
        let sp = &mut out[idx];
        if let Some(k) = vals.iter().position(|v| v.is_empty()) {
            sp.errors.push(Issue { row: line, message: format!("ช่อง \"{}\" ว่าง — ไม่นำเข้าแถวนี้", columns[k]) });
            continue;
        }
        let values: Values = columns.iter().cloned().zip(vals.iter().cloned()).collect();
        if let Some(dup) = sp.rows.iter().position(|x| x.values == values) {
            let _ = dup;
            sp.errors.push(Issue { row: line, message: format!("ซ้ำกับแถวก่อนหน้า ({}) — ไม่นำเข้าแถวนี้", vals.join(" › ")) });
            continue;
        }
        let description = desc_col.map(|i| cell(r, i)).unwrap_or_default();
        if description.is_empty() {
            sp.warnings.push(Issue { row: line, message: format!("{} ไม่มีคำอธิบาย · AI อาจจัดได้แม่นน้อยลง", vals.join(" › ")) });
        }
        sp.rows.push(RowInput { id: None, values, description, examples: ex_col.map(|i| cell(r, i)).unwrap_or_default() });
    }
    if out.iter().all(|s| s.rows.is_empty()) && out.iter().all(|s| s.errors.is_empty()) {
        return Err(AppError::new("empty", "ไม่พบแถวหมวดหมู่ในไฟล์"));
    }
    Ok(out)
}

/// A file without a `เซอร์วิส` column goes into `default_service`, else a service named after the file
/// (`Internet.xlsx` → Internet), matching "one file per service".
pub fn preview_import(conn: &Connection, path: &Path, default_service: Option<&str>) -> AppResult<ImportPreview> {
    let table = sheet::read_table(path, None)?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let target = default_service.filter(|s| !s.trim().is_empty()).unwrap_or(&stem);
    let mut services = parse_import(&table.rows, Some(target))?;
    for s in services.iter_mut() {
        if let Some(e) = find_service_by_name(conn, &s.name)? {
            s.exists = true;
            s.existing_rows = list_rows(conn, &e.id)?.len();
        }
    }
    Ok(ImportPreview { file_name: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), services })
}

/// Replace each service in the file (create it if new): columns + every row.
pub fn apply_import(conn: &mut Connection, path: &Path, default_service: Option<&str>) -> AppResult<Vec<Service>> {
    let preview = preview_import(conn, path, default_service)?;
    let mut done = Vec::new();
    for sp in preview.services.iter().filter(|s| !s.rows.is_empty()) {
        let svc = match find_service_by_name(conn, &sp.name)? {
            Some(s) => s,
            None => create_service(conn, &sp.name, None, &sp.columns)?,
        };
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM taxonomy_rows WHERE service_id = ?1", [&svc.id])?;
        tx.execute("UPDATE services SET columns_json = ?1 WHERE id = ?2", params![serde_json::to_string(&sp.columns)?, svc.id])?;
        for (i, r) in sp.rows.iter().enumerate() {
            tx.execute(
                "INSERT INTO taxonomy_rows(id, service_id, values_json, description, examples, sort) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![new_id("t-"), svc.id, serde_json::to_string(&r.values)?, r.description, r.examples, i as i64],
            )?;
        }
        bump_version(&tx, &svc.id)?;
        tx.commit()?;
        done.push(get_service(conn, &svc.id)?);
    }
    Ok(done)
}

/// `.xlsx` template: เซอร์วิส | หัวข้อหลัก | หัวข้อย่อย | คำอธิบาย | ตัวอย่าง + 2 example rows.
pub fn write_template(path: &Path) -> AppResult<()> {
    use rust_xlsxwriter::{Format, Workbook};
    let err = |e: rust_xlsxwriter::XlsxError| AppError::new("io", format!("เขียนไฟล์เทมเพลตไม่ได้: {e}"));
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet().set_name("หมวดหมู่").map_err(err)?;
    let bold = Format::new().set_bold().set_background_color("#E6F2EB");
    let head = [COL_SERVICE, "หัวข้อหลัก", "หัวข้อย่อย", COL_DESC, COL_EXAMPLES];
    for (c, h) in head.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *h, &bold).map_err(err)?;
    }
    let rows = [
        ["Internet", "การเชื่อมต่อ", "เน็ตหลุดเป็นช่วง", "ใช้งานได้แต่หลุดเป็นระยะ กลับมาใช้ได้เอง", "เน็ตหลุดทุกคืน, ประชุมแล้วหลุด"],
        ["Internet", "ความเร็ว", "ความเร็วต่ำกว่าแพ็กเกจ", "วัดความเร็วได้ต่ำกว่าที่สมัครอย่างชัดเจน", "สมัคร 1 Gbps วัดได้ 200"],
    ];
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            ws.write_string((r + 1) as u32, c as u16, *v).map_err(err)?;
        }
    }
    for (c, w) in [14.0, 18.0, 24.0, 44.0, 32.0].iter().enumerate() {
        ws.set_column_width(c as u16, *w).map_err(err)?;
    }
    wb.save(path).map_err(err)?;
    Ok(())
}

/// Months (yyyy-mm) that have tickets, oldest first.
pub fn project_months(conn: &Connection) -> AppResult<Vec<String>> {
    let mut st = conn.prepare("SELECT DISTINCT month FROM tickets ORDER BY month")?;
    let rows = st.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        (dir, c)
    }
    fn cols() -> Vec<String> {
        vec!["หัวข้อหลัก".into(), "หัวข้อย่อย".into()]
    }
    fn vals(a: &str, b: &str) -> Values {
        [("หัวข้อหลัก".to_string(), a.to_string()), ("หัวข้อย่อย".to_string(), b.to_string())].into_iter().collect()
    }
    fn row(a: &str, b: &str) -> RowInput {
        RowInput { id: None, values: vals(a, b), description: "d".into(), examples: String::new() }
    }
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }
    fn add_ticket(c: &Connection, id: &str, service: &str, fields: Option<&Values>) {
        c.execute(
            "INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?1,'2026-10-01','2026-10',?2,'x','{}','i1')",
            params![id, service],
        )
        .unwrap();
        if let Some(f) = fields {
            let j = serde_json::to_string(f).unwrap();
            c.execute("INSERT INTO classifications(ticket_id,fields_json,ai_fields_json,source) VALUES(?1,?2,?2,'ai')", params![id, j]).unwrap();
        }
    }
    fn fields_of(c: &Connection, id: &str) -> Option<Values> {
        c.query_row("SELECT fields_json FROM classifications WHERE ticket_id=?1", [id], |r| r.get::<_, Option<String>>(0))
            .optional()
            .unwrap()
            .flatten()
            .map(|j| serde_json::from_str(&j).unwrap())
    }

    #[test]
    fn services_crud_and_rules() {
        let (_d, mut c) = db();
        let a = create_service(&c, " Internet ", None, &cols()).unwrap();
        assert_eq!((a.name.as_str(), a.color.as_str(), a.taxonomy_version), ("Internet", "#2F6FB0", 1));
        let b = create_service(&c, "IPTV", None, &cols()).unwrap();
        assert_eq!(b.color, "#7B4FB0"); // next unused colour
        assert_eq!(create_service(&c, "internet", None, &cols()).unwrap_err().code, "duplicate_name");
        assert_eq!(create_service(&c, "X", None, &[]).unwrap_err().code, "invalid_columns");
        assert_eq!(create_service(&c, "X", None, &s(&["คำอธิบาย"])).unwrap_err().code, "invalid_columns");
        assert_eq!(create_service(&c, "X", None, &s(&["ก", "ก"])).unwrap_err().code, "invalid_columns");
        add_ticket(&c, "T1", "Internet", None);
        update_service(&mut c, &a.id, Some("Broadband"), Some("#0e7c74")).unwrap();
        let svc: String = c.query_row("SELECT service FROM tickets WHERE id='T1'", [], |r| r.get(0)).unwrap();
        assert_eq!(svc, "Broadband");
        delete_service(&c, &b.id).unwrap();
        assert_eq!(list_services(&c).unwrap().len(), 1);
    }

    #[test]
    fn rows_get_codes_and_bump_version() {
        let (_d, mut c) = db();
        let svc = create_service(&c, "Internet", None, &cols()).unwrap();
        save_row(&mut c, &svc.id, &row("การเชื่อมต่อ", "เน็ตหลุด")).unwrap();
        save_row(&mut c, &svc.id, &row("ความเร็ว", "ช้า")).unwrap();
        let rows = list_taxonomy(&c, &svc.id).unwrap();
        assert_eq!(rows.iter().map(|r| r.code.as_str()).collect::<Vec<_>>(), vec!["C01", "C02"]);
        assert_eq!(get_service(&c, &svc.id).unwrap().taxonomy_version, 3);
        assert_eq!(save_row(&mut c, &svc.id, &row("การเชื่อมต่อ", "เน็ตหลุด")).unwrap_err().code, "duplicate_row");
        assert_eq!(save_row(&mut c, &svc.id, &row("การเชื่อมต่อ", " ")).unwrap_err().code, "invalid_row");
    }

    #[test]
    fn editing_a_row_moves_its_tickets_and_delete_offers_move_or_reclassify() {
        let (_d, mut c) = db();
        let svc = create_service(&c, "Internet", None, &cols()).unwrap();
        let a = save_row(&mut c, &svc.id, &row("การเชื่อมต่อ", "เน็ตหลุด")).unwrap();
        let b = save_row(&mut c, &svc.id, &row("ความเร็ว", "ช้า")).unwrap();
        add_ticket(&c, "T1", "Internet", Some(&vals("การเชื่อมต่อ", "เน็ตหลุด")));
        add_ticket(&c, "T2", "Internet", Some(&vals("การเชื่อมต่อ", "เน็ตหลุด")));
        add_ticket(&c, "T3", "Internet", Some(&vals("ความเร็ว", "ช้า")));
        // rename the category → classified tickets follow
        let edit = RowInput { id: Some(a.id.clone()), ..row("การเชื่อมต่อ", "เน็ตหลุดเป็นช่วง") };
        save_row(&mut c, &svc.id, &edit).unwrap();
        assert_eq!(fields_of(&c, "T1"), Some(vals("การเชื่อมต่อ", "เน็ตหลุดเป็นช่วง")));
        assert_eq!(row_usage(&c, &a.id).unwrap().len(), 2);
        // delete with move
        assert_eq!(delete_row(&mut c, &a.id, Some(&b.id)).unwrap(), 2);
        assert_eq!(fields_of(&c, "T1"), Some(vals("ความเร็ว", "ช้า")));
        // delete with reclassify → classifications removed
        assert_eq!(delete_row(&mut c, &b.id, None).unwrap(), 3);
        assert_eq!(fields_of(&c, "T3"), None);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM classifications", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn renaming_columns_keeps_values() {
        let (_d, mut c) = db();
        let svc = create_service(&c, "Internet", None, &cols()).unwrap();
        save_row(&mut c, &svc.id, &row("การเชื่อมต่อ", "เน็ตหลุด")).unwrap();
        add_ticket(&c, "T1", "Internet", Some(&vals("การเชื่อมต่อ", "เน็ตหลุด")));
        let specs = vec![
            ColumnSpec { from: Some("หัวข้อหลัก".into()), name: "กลุ่ม".into() },
            ColumnSpec { from: None, name: "ระดับ".into() },
        ];
        let s2 = set_columns(&mut c, &svc.id, &specs).unwrap();
        assert_eq!(s2.columns, s(&["กลุ่ม", "ระดับ"]));
        let r = &list_taxonomy(&c, &svc.id).unwrap()[0];
        assert_eq!(r.values.get("กลุ่ม").unwrap(), "การเชื่อมต่อ");
        assert_eq!(r.values.get("ระดับ").unwrap(), "");
        assert_eq!(fields_of(&c, "T1").unwrap().get("กลุ่ม").unwrap(), "การเชื่อมต่อ");
    }

    fn grid(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect()
    }

    #[test]
    fn parses_one_file_with_service_column_and_reports_problems() {
        let rows = grid(&[
            &["หมวดหมู่ Call Center", "", "", "", ""],
            &["เซอร์วิส", "หัวข้อหลัก", "หัวข้อย่อย", "คำอธิบาย", "ตัวอย่าง"],
            &["Internet", "การเชื่อมต่อ", "เน็ตหลุด", "หลุดเป็นช่วง", "เน็ตหลุดทุกคืน"],
            &["", "", "ไม่มีเน็ต", "ใช้ไม่ได้เลย", ""], // service + main filled down
            &["Internet", "การเชื่อมต่อ", "เน็ตหลุด", "ซ้ำ", ""],
            &["Mobile", "สัญญาณ", "", "x", ""],
            &["Mobile", "บิล", "บิลผิด", "", ""],
            &["", "", "", "", ""],
        ]);
        let p = parse_import(&rows, None).unwrap();
        assert_eq!(p.len(), 2);
        let net = &p[0];
        assert_eq!(net.columns, s(&["หัวข้อหลัก", "หัวข้อย่อย"]));
        assert_eq!(net.rows.len(), 2);
        assert_eq!(net.rows[1].values, vals("การเชื่อมต่อ", "ไม่มีเน็ต"));
        assert_eq!(net.errors.len(), 1);
        assert_eq!(net.errors[0].row, 5);
        let mob = &p[1];
        assert_eq!(mob.rows.len(), 1);
        assert_eq!(mob.errors[0].row, 6); // empty leaf
        assert_eq!(mob.warnings.len(), 1); // no description
    }

    #[test]
    fn file_without_service_column_needs_a_target() {
        let rows = grid(&[&["หัวข้อหลัก", "หัวข้อย่อย", "คำอธิบาย"], &["สัญญาณ", "อ่อน", "ในอาคาร"]]);
        assert_eq!(parse_import(&rows, None).unwrap_err().code, "no_service");
        let p = parse_import(&rows, Some("Mobile")).unwrap();
        assert_eq!(p[0].name, "Mobile");
    }

    #[test]
    fn per_service_file_is_named_after_the_file() {
        let (d, c) = db();
        let p = d.path().join("Mobile.csv");
        std::fs::write(&p, "หัวข้อหลัก,หัวข้อย่อย,คำอธิบาย
สัญญาณ,อ่อน,ในอาคาร
").unwrap();
        assert_eq!(preview_import(&c, &p, None).unwrap().services[0].name, "Mobile");
        assert_eq!(preview_import(&c, &p, Some("IPTV")).unwrap().services[0].name, "IPTV");
    }

    #[test]
    fn template_round_trips_through_import() {
        let (d, mut c) = db();
        let p = d.path().join("template.xlsx");
        write_template(&p).unwrap();
        let prev = preview_import(&c, &p, None).unwrap();
        assert_eq!(prev.services.len(), 1);
        assert!(!prev.services[0].exists);
        let done = apply_import(&mut c, &p, None).unwrap();
        assert_eq!(done[0].name, "Internet");
        assert_eq!(list_taxonomy(&c, &done[0].id).unwrap().len(), 2);
        // importing again replaces, not appends
        let prev = preview_import(&c, &p, None).unwrap();
        assert!(prev.services[0].exists);
        assert_eq!(prev.services[0].existing_rows, 2);
        let done = apply_import(&mut c, &p, None).unwrap();
        assert_eq!(list_taxonomy(&c, &done[0].id).unwrap().len(), 2);
    }
}
