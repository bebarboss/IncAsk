//! Ticket-file import (SPEC §5): preview → roles → live summary → commit.
//! The parsed file is cached (path + sheet + size + mtime) so changing a role re-analyses instantly.

pub mod dates;
pub mod patterns;
pub mod sheet;

use crate::errors::{AppError, AppResult};
use dates::{DateOrder, Ymd};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use patterns::{Role, RoleMap};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

/// A ticket file after reading: unique headers and its data rows (with their line numbers).
#[derive(Debug, Clone)]
pub struct Parsed {
    pub file_name: String,
    pub sheets: Vec<String>,
    pub sheet: String,
    pub headers: Vec<String>,
    /// (1-based line in the file, cells)
    pub rows: Vec<(usize, Vec<String>)>,
}

type Cached = Option<(String, Arc<Parsed>)>;
static CACHE: Lazy<Mutex<Cached>> = Lazy::new(|| Mutex::new(None));

fn cache_key(path: &Path, sheet: Option<&str>) -> String {
    let meta = std::fs::metadata(path).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    format!("{}|{}|{len}|{mtime}", path.display(), sheet.unwrap_or(""))
}

pub fn load(path: &Path, sheet: Option<&str>) -> AppResult<Arc<Parsed>> {
    let key = cache_key(path, sheet);
    if let Some((k, p)) = CACHE.lock().as_ref() {
        if *k == key {
            return Ok(p.clone());
        }
    }
    let table = sheet::read_table(path, sheet)?;
    let h = sheet::header_row(&table.rows).ok_or_else(|| AppError::new("no_header", "ไม่พบแถวหัวตาราง (ต้องมีหัวคอลัมน์ที่เป็นข้อความอย่างน้อย 2 ช่อง)"))?;
    let width = table.rows.iter().skip(h).map(|r| r.len()).max().unwrap_or(0);
    let mut headers: Vec<String> = Vec::new();
    for i in 0..width {
        let base = table.rows[h].get(i).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let base = if base.is_empty() { format!("คอลัมน์ {}", i + 1) } else { base };
        let mut name = base.clone();
        let mut n = 2;
        while headers.contains(&name) {
            name = format!("{base} ({n})");
            n += 1;
        }
        headers.push(name);
    }
    let rows = table
        .rows
        .iter()
        .enumerate()
        .skip(h + 1)
        .filter(|(_, r)| r.iter().any(|c| !c.trim().is_empty()))
        .map(|(i, r)| (i + 1, (0..width).map(|c| r.get(c).cloned().unwrap_or_default()).collect()))
        .collect();
    let parsed = Arc::new(Parsed {
        file_name: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        sheets: table.sheets,
        sheet: table.sheet,
        headers,
        rows,
    });
    *CACHE.lock() = Some((key, parsed.clone()));
    Ok(parsed)
}

// ---------------------------------------------------------------- roles

const TICKET_WORDS: [&str; 8] = ["เลขอินซิเดนต์", "เลขทิกเก็ต", "เลขที่", "หมายเลข", "ticket", "incident", "case", "inc no"];
const DATE_WORDS: [&str; 5] = ["วันที่", "date", "เวลาแจ้ง", "created", "open time"];
const SERVICE_WORDS: [&str; 4] = ["เซอร์วิส", "service", "บริการ", "product"];
const PROBLEM_WORDS: [&str; 11] = ["ปัญหา", "รายละเอียด", "หัวข้อ", "อาการ", "สาเหตุ", "description", "detail", "subject", "problem", "summary", "symptom"];

/// First guess for a file with no saved pattern, from the header words.
pub fn guess_roles(headers: &[String]) -> Vec<Role> {
    let mut roles = vec![Role::None; headers.len()];
    let low: Vec<String> = headers.iter().map(|h| h.to_lowercase()).collect();
    let pick = |words: &[&str], role: Role, roles: &mut Vec<Role>| {
        if let Some(i) = (0..low.len()).find(|&i| roles[i] == Role::None && words.iter().any(|w| low[i].contains(w))) {
            roles[i] = role;
        }
    };
    pick(&TICKET_WORDS, Role::Ticket, &mut roles);
    pick(&DATE_WORDS, Role::Date, &mut roles);
    pick(&SERVICE_WORDS, Role::Service, &mut roles);
    for i in 0..low.len() {
        if roles[i] == Role::None && PROBLEM_WORDS.iter().any(|w| low[i].contains(w)) {
            roles[i] = Role::Problem;
        }
    }
    roles
}

struct Cols {
    ticket: usize,
    date: usize,
    service: usize,
    problem: Vec<usize>,
}

fn cols(headers: &[String], roles: &[Role]) -> AppResult<Cols> {
    if roles.len() != headers.len() {
        return Err(AppError::new("invalid_roles", "จำนวนบทบาทไม่ตรงกับจำนวนคอลัมน์"));
    }
    let one = |r: Role| -> AppResult<usize> {
        let idx: Vec<usize> = (0..roles.len()).filter(|&i| roles[i] == r).collect();
        match idx.len() {
            1 => Ok(idx[0]),
            _ => Err(AppError::new("invalid_roles", "เลือกคอลัมน์ให้ครบทั้งสี่บทบาทก่อน (เลขทิกเก็ต วันที่ เซอร์วิส อย่างละ 1 และปัญหาอย่างน้อย 1)")),
        }
    };
    let problem: Vec<usize> = (0..roles.len()).filter(|&i| roles[i] == Role::Problem).collect();
    if problem.is_empty() {
        return Err(AppError::new("invalid_roles", "เลือกคอลัมน์ปัญหาอย่างน้อย 1 คอลัมน์"));
    }
    Ok(Cols { ticket: one(Role::Ticket)?, date: one(Role::Date)?, service: one(Role::Service)?, problem })
}

/// `"<header>: <value>"` for each problem column in file order, joined by ", ", empty values skipped.
pub fn problem_text(headers: &[String], row: &[String], problem_cols: &[usize]) -> String {
    problem_cols
        .iter()
        .filter_map(|&i| {
            let v = row.get(i).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default();
            (!v.is_empty()).then(|| format!("{}: {v}", headers[i]))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------- analyse

#[derive(Debug, Clone)]
pub struct Record {
    pub line: usize,
    pub ticket_no: String,
    pub date: Ymd,
    pub service: String,
    pub problem_text: String,
    pub source: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Issue {
    pub row: usize,
    pub message: String,
}

/// Valid records + rows that can't be imported (no ticket number, unreadable date).
pub fn build_records(p: &Parsed, roles: &[Role], order: DateOrder) -> AppResult<(Vec<Record>, Vec<Issue>)> {
    let c = cols(&p.headers, roles)?;
    let mut ok = Vec::with_capacity(p.rows.len());
    let mut bad = Vec::new();
    for (line, r) in &p.rows {
        let ticket = r[c.ticket].trim().to_string();
        if ticket.is_empty() {
            bad.push(Issue { row: *line, message: "ไม่มีเลขทิกเก็ต".into() });
            continue;
        }
        let Some(date) = dates::parse(&r[c.date], order) else {
            let v = r[c.date].trim();
            bad.push(Issue { row: *line, message: if v.is_empty() { "ไม่มีวันที่".into() } else { format!("อ่านวันที่ไม่ได้: {v}") } });
            continue;
        };
        let source = p.headers.iter().cloned().zip(r.iter().map(|v| serde_json::Value::String(v.clone()))).collect();
        ok.push(Record {
            line: *line,
            ticket_no: ticket,
            date,
            service: r[c.service].split_whitespace().collect::<Vec<_>>().join(" "),
            problem_text: problem_text(&p.headers, r, &c.problem),
            source,
        });
    }
    Ok((ok, bad))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCount {
    pub name: String,
    pub known: bool,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub months: Vec<String>,
    /// already in the project, or repeated earlier in this file
    pub duplicates: usize,
    pub invalid: usize,
    /// first 50
    pub invalid_rows: Vec<Issue>,
    pub services: Vec<ServiceCount>,
    pub sample: String,
    pub date_order: DateOrder,
    /// every date fits both day/month orders — the user must pick
    pub date_ambiguous: bool,
    /// rows that would be added (skip mode)
    pub new_rows: usize,
}

fn existing_ticket_nos(conn: &Connection, recs: &[Record]) -> AppResult<HashSet<String>> {
    let mut st = conn.prepare_cached("SELECT 1 FROM tickets WHERE ticket_no = ?1")?;
    let mut out = HashSet::new();
    for r in recs {
        if st.exists([&r.ticket_no])? {
            out.insert(r.ticket_no.clone());
        }
    }
    Ok(out)
}

fn known_services(conn: &Connection) -> AppResult<HashSet<String>> {
    Ok(crate::taxonomy::list_services(conn)?.into_iter().map(|s| s.name).collect())
}

pub fn date_order_for(p: &Parsed, roles: &[Role], chosen: Option<DateOrder>) -> AppResult<(DateOrder, bool)> {
    if let Some(o) = chosen {
        return Ok((o, false));
    }
    let c = cols(&p.headers, roles)?;
    Ok(match dates::detect_order(p.rows.iter().map(|(_, r)| r[c.date].as_str())) {
        Some(o) => (o, false),
        None => (DateOrder::Dmy, true),
    })
}

pub fn analyze(conn: &Connection, p: &Parsed, roles: &[Role], chosen: Option<DateOrder>) -> AppResult<Summary> {
    let (order, ambiguous) = date_order_for(p, roles, chosen)?;
    let (recs, bad) = build_records(p, roles, order)?;
    let existing = existing_ticket_nos(conn, &recs)?;
    let known = known_services(conn)?;
    let mut seen = HashSet::new();
    let mut dups = 0;
    let mut months = BTreeSet::new();
    let mut svc: BTreeMap<String, usize> = BTreeMap::new();
    let (mut from, mut to): (Option<String>, Option<String>) = (None, None);
    for r in &recs {
        if !seen.insert(r.ticket_no.clone()) || existing.contains(&r.ticket_no) {
            dups += 1;
            continue;
        }
        let d = r.date.iso();
        if from.as_ref().map_or(true, |f| &d < f) {
            from = Some(d.clone());
        }
        if to.as_ref().map_or(true, |t| &d > t) {
            to = Some(d);
        }
        months.insert(r.date.month());
        *svc.entry(r.service.clone()).or_default() += 1;
    }
    let mut services: Vec<ServiceCount> = svc
        .into_iter()
        .map(|(name, count)| ServiceCount { known: known.contains(&name), name: if name.is_empty() { "(ว่าง)".into() } else { name }, count })
        .collect();
    services.sort_by_key(|s| std::cmp::Reverse(s.count));
    Ok(Summary {
        date_from: from,
        date_to: to,
        months: months.into_iter().collect(),
        duplicates: dups,
        invalid: bad.len(),
        invalid_rows: bad.into_iter().take(50).collect(),
        sample: recs.first().map(|r| r.problem_text.clone()).unwrap_or_default(),
        date_order: order,
        date_ambiguous: ambiguous,
        new_rows: recs.len() - dups,
        services,
    })
}

// ---------------------------------------------------------------- preview / commit

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub file_name: String,
    pub sheet: String,
    pub sheets: Vec<String>,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub pattern: Option<PatternRef>,
    pub roles: Vec<Role>,
    pub date_order: Option<DateOrder>,
}

pub fn preview(conn: &Connection, path: &Path, sheet: Option<&str>) -> AppResult<Preview> {
    let p = load(path, sheet)?;
    let pattern = patterns::find(conn, &p.headers)?;
    let roles = match &pattern {
        Some(pt) => pt.roles.to_roles(&p.headers),
        None => guess_roles(&p.headers),
    };
    Ok(Preview {
        file_name: p.file_name.clone(),
        sheet: p.sheet.clone(),
        sheets: p.sheets.clone(),
        headers: p.headers.clone(),
        rows: p.rows.iter().take(10).map(|(_, r)| r.clone()).collect(),
        row_count: p.rows.len(),
        date_order: pattern.as_ref().and_then(|x| x.date_format.as_deref()).and_then(DateOrder::parse),
        pattern: pattern.map(|x| PatternRef { id: x.id, name: x.name }),
        roles,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub import_id: String,
    pub rows_total: usize,
    pub rows_new: usize,
    pub rows_duplicate: usize,
    pub rows_invalid: usize,
    pub unknown_service: usize,
}

pub struct CommitOptions<'a> {
    pub roles: &'a [Role],
    pub date_order: Option<DateOrder>,
    /// replace tickets that already exist (their old classification is dropped)
    pub replace: bool,
    /// remember this report pattern under this name
    pub pattern_name: Option<&'a str>,
}

pub fn commit(conn: &mut Connection, p: &Parsed, opt: &CommitOptions) -> AppResult<ImportResult> {
    let (order, _) = date_order_for(p, opt.roles, opt.date_order)?;
    let (recs, bad) = build_records(p, opt.roles, order)?;
    let known = known_services(conn)?;
    let existing = existing_ticket_nos(conn, &recs)?;
    let import_id = format!("im-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let tx = conn.transaction()?;
    let mut pattern_id: Option<String> = None;
    if let Some(name) = opt.pattern_name {
        let map = RoleMap::from_roles(&p.headers, opt.roles);
        pattern_id = Some(patterns::save(&tx, name, &p.headers, &map, Some(order.as_str()))?.id);
    }
    let (mut new, mut dup, mut unknown) = (0usize, 0usize, 0usize);
    let mut seen: HashMap<String, ()> = HashMap::new();
    {
        let mut del = tx.prepare("DELETE FROM tickets WHERE ticket_no = ?1")?;
        let mut ins = tx.prepare(
            "INSERT INTO tickets(id, ticket_no, date, month, service, problem_text, source_json, import_id) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let mut unk = tx.prepare("INSERT INTO classifications(ticket_id, source, updated_at) VALUES(?1, 'unknown_service', datetime('now'))")?;
        for r in &recs {
            if seen.insert(r.ticket_no.clone(), ()).is_some() {
                dup += 1; // repeated inside this file: keep the first
                continue;
            }
            if existing.contains(&r.ticket_no) {
                dup += 1;
                if !opt.replace {
                    continue;
                }
                del.execute([&r.ticket_no])?;
            }
            let id = format!("k-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
            ins.execute(params![id, r.ticket_no, r.date.iso(), r.date.month(), r.service, r.problem_text, serde_json::to_string(&r.source)?, import_id])?;
            if !known.contains(&r.service) {
                unk.execute([&id])?;
                unknown += 1;
            }
            new += 1;
        }
    }
    tx.execute(
        "INSERT INTO imports(id, file_name, pattern_id, imported_at, rows_total, rows_new, rows_duplicate, rows_invalid) VALUES(?1, ?2, ?3, datetime('now'), ?4, ?5, ?6, ?7)",
        params![import_id, p.file_name, pattern_id, p.rows.len() as i64, new as i64, dup as i64, bad.len() as i64],
    )?;
    tx.commit()?;
    Ok(ImportResult { import_id, rows_total: p.rows.len(), rows_new: new, rows_duplicate: dup, rows_invalid: bad.len(), unknown_service: unknown })
}

#[cfg(test)]
mod tests {
    use super::*;
    use Role::*;

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        crate::taxonomy::create_service(&c, "Internet", Option::None, &["หัวข้อหลัก".to_string()]).unwrap();
        crate::taxonomy::create_service(&c, "IPTV", Option::None, &["หัวข้อหลัก".to_string()]).unwrap();
        (dir, c)
    }

    const CSV: &str = "รายงานอินซิเดนต์ ต.ค. 2569,,,,,\n\
เลขอินซิเดนต์,วันที่แจ้ง,ชื่อลูกค้า,เซอร์วิส,หัวข้อ,รายละเอียดปัญหา\n\
INC0102341,01/10/2569 08:15,คุณสมชาย ก.,Internet,เน็ตหลุด,อินเทอร์เน็ตหลุดทุกคืน\n\
INC0102342,15/10/2569,คุณวิภา ส.,IPTV,ภาพกระตุก,\n\
INC0102343,02/11/2569,คุณอนันต์ ป.,Smart Home,กล้องออฟไลน์,กล้องหลุด\n\
,03/10/2569,ไม่มีเลข,Internet,x,y\n\
INC0102345,ไม่ระบุ,คุณธนา จ.,Internet,x,y\n\
INC0102341,01/10/2569,ซ้ำในไฟล์,Internet,x,y\n";

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn guesses_roles_from_thai_headers() {
        let h: Vec<String> = ["เลขอินซิเดนต์", "วันที่แจ้ง", "ชื่อลูกค้า", "เซอร์วิส", "หัวข้อ", "รายละเอียดปัญหา", "ช่องทาง"].iter().map(|s| s.to_string()).collect();
        assert_eq!(guess_roles(&h), vec![Ticket, Date, None, Service, Problem, Problem, None]);
    }

    #[test]
    fn joins_problem_columns_skipping_empty() {
        let h: Vec<String> = vec!["หัวข้อ".into(), "รายละเอียดปัญหา".into(), "x".into()];
        let r: Vec<String> = vec!["เน็ตหลุด".into(), "  หลุด   ทุกคืน ".into(), "".into()];
        assert_eq!(problem_text(&h, &r, &[0, 1]), "หัวข้อ: เน็ตหลุด, รายละเอียดปัญหา: หลุด ทุกคืน");
        let r2: Vec<String> = vec!["ภาพกระตุก".into(), "".into(), "".into()];
        assert_eq!(problem_text(&h, &r2, &[0, 1]), "หัวข้อ: ภาพกระตุก");
    }

    fn roles() -> Vec<Role> {
        vec![Ticket, Date, None, Service, Problem, Problem]
    }

    #[test]
    fn analyses_and_commits_a_thai_csv_in_both_encodings() {
        let (d, mut c) = db();
        let (tis, _, _) = encoding_rs::WINDOWS_874.encode(CSV);
        for (name, bytes) in [("utf8.csv", CSV.as_bytes().to_vec()), ("tis620.csv", tis.into_owned())] {
            let path = write(d.path(), name, &bytes);
            let p = load(&path, Option::None).unwrap();
            assert_eq!(p.headers[0], "เลขอินซิเดนต์", "{name}");
            assert_eq!(p.rows.len(), 6);
            assert_eq!(p.rows[0].0, 3); // line numbers as Excel shows them
            let s = analyze(&c, &p, &roles(), Option::None).unwrap();
            assert_eq!(s.date_order, DateOrder::Dmy);
            assert!(!s.date_ambiguous);
            assert_eq!(s.date_from.as_deref(), Some("2026-10-01"));
            assert_eq!(s.date_to.as_deref(), Some("2026-11-02"));
            assert_eq!(s.months, vec!["2026-10", "2026-11"]);
            assert_eq!(s.invalid, 2);
            assert_eq!(s.invalid_rows[0].message, "ไม่มีเลขทิกเก็ต");
            assert!(s.invalid_rows[1].message.contains("ไม่ระบุ"));
            assert_eq!(s.duplicates, 1);
            assert_eq!(s.new_rows, 3);
            assert_eq!(s.sample, "หัวข้อ: เน็ตหลุด, รายละเอียดปัญหา: อินเทอร์เน็ตหลุดทุกคืน");
            let smart = s.services.iter().find(|x| x.name == "Smart Home").unwrap();
            assert!(!smart.known);
        }
        let p = load(&d.path().join("utf8.csv"), Option::None).unwrap();
        let r = commit(&mut c, &p, &CommitOptions { roles: &roles(), date_order: Option::None, replace: false, pattern_name: Some("รีพอร์ตรายเดือน") }).unwrap();
        assert_eq!((r.rows_new, r.rows_duplicate, r.rows_invalid, r.unknown_service), (3, 1, 2, 1));
        // the second file had the same tickets → all duplicates now, and the pattern is recognised
        let path = write(d.path(), "again.csv", CSV.as_bytes());
        let pv = preview(&c, &path, Option::None).unwrap();
        assert_eq!(pv.pattern.as_ref().unwrap().name, "รีพอร์ตรายเดือน");
        assert_eq!(pv.roles, roles());
        assert_eq!(pv.date_order, Some(DateOrder::Dmy));
        let p = load(&path, Option::None).unwrap();
        assert_eq!(analyze(&c, &p, &roles(), Option::None).unwrap().duplicates, 4);
        // stored as ค.ศ. with source columns in file order and the unknown service flagged
        let (date, month, src, text): (String, String, String, String) = c
            .query_row("SELECT date, month, source_json, problem_text FROM tickets WHERE ticket_no='INC0102341'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        assert_eq!((date.as_str(), month.as_str()), ("2026-10-01", "2026-10"));
        assert!(src.starts_with("{\"เลขอินซิเดนต์\":\"INC0102341\",\"วันที่แจ้ง\""), "{src}");
        assert!(text.starts_with("หัวข้อ: เน็ตหลุด"));
        let unknown: String = c
            .query_row("SELECT c.source FROM classifications c JOIN tickets t ON t.id=c.ticket_id WHERE t.ticket_no='INC0102343'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unknown, "unknown_service");
    }

    #[test]
    fn replace_mode_swaps_existing_tickets_and_drops_their_classification() {
        let (d, mut c) = db();
        let path = write(d.path(), "a.csv", CSV.as_bytes());
        let p = load(&path, Option::None).unwrap();
        let opts = CommitOptions { roles: &roles(), date_order: Option::None, replace: false, pattern_name: Option::None };
        commit(&mut c, &p, &opts).unwrap();
        c.execute("INSERT INTO classifications(ticket_id, fields_json, source) SELECT id, '{}', 'human' FROM tickets WHERE ticket_no='INC0102341'", []).unwrap();
        let r = commit(&mut c, &p, &CommitOptions { replace: true, ..opts }).unwrap();
        assert_eq!(r.rows_new, 3);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM tickets", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
        let human: i64 = c.query_row("SELECT COUNT(*) FROM classifications WHERE source='human'", [], |r| r.get(0)).unwrap();
        assert_eq!(human, 0);
    }

    #[test]
    fn ambiguous_dates_ask_and_respect_the_choice() {
        let (d, c) = db();
        let csv = "เลข,วันที่,เซอร์วิส,ปัญหา\nA1,03/04/2569,Internet,x\nA2,05/06/2569,Internet,y\n";
        let path = write(d.path(), "amb.csv", csv.as_bytes());
        let p = load(&path, Option::None).unwrap();
        let r = vec![Ticket, Date, Service, Problem];
        let s = analyze(&c, &p, &r, Option::None).unwrap();
        assert!(s.date_ambiguous);
        let s = analyze(&c, &p, &r, Some(DateOrder::Mdy)).unwrap();
        assert!(!s.date_ambiguous);
        assert_eq!(s.date_from.as_deref(), Some("2026-03-04"));
    }

    #[test]
    fn missing_roles_are_refused() {
        let (d, c) = db();
        let path = write(d.path(), "a.csv", CSV.as_bytes());
        let p = load(&path, Option::None).unwrap();
        let e = analyze(&c, &p, &[Ticket, Date, None, None, Problem, None], Option::None).unwrap_err();
        assert_eq!(e.code, "invalid_roles");
        let e = analyze(&c, &p, &[Ticket, Ticket, None, Service, Problem, None], Option::None).unwrap_err();
        assert_eq!(e.code, "invalid_roles");
    }

    #[test]
    fn reads_an_xlsx_with_real_date_cells() {
        let (d, mut c) = db();
        let path = d.path().join("oct.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet();
        let fmt = rust_xlsxwriter::Format::new().set_num_format("dd/mm/yyyy");
        for (i, h) in ["เลขอินซิเดนต์", "วันที่แจ้ง", "เซอร์วิส", "รายละเอียดปัญหา"].iter().enumerate() {
            ws.write_string(0, i as u16, *h).unwrap();
        }
        ws.write_string(1, 0, "INC1").unwrap();
        ws.write_number_with_format(1, 1, 46296.0, &fmt).unwrap(); // 2026-10-01
        ws.write_string(1, 2, "IPTV").unwrap();
        ws.write_string(1, 3, "ภาพค้าง").unwrap();
        wb.save(&path).unwrap();
        let p = load(&path, Option::None).unwrap();
        let r = guess_roles(&p.headers);
        let s = analyze(&c, &p, &r, Option::None).unwrap();
        assert_eq!(s.date_from.as_deref(), Some("2026-10-01"));
        assert_eq!(commit(&mut c, &p, &CommitOptions { roles: &r, date_order: Option::None, replace: false, pattern_name: Option::None }).unwrap().rows_new, 1);
    }
}
