//! Excel "รายงานวิเคราะห์" in the layout the team already uses (PAM-APS-CEP … วิเคราะห์ 2026):
//! one sheet per service; rows = every category (upper levels merged), Classification; columns per
//! month = each day, a total after every week (Monday first, cut at the month edge — "Jan 1-4",
//! "Jan 5-11" …) and "Calls <Mon> <yyyy>" for the month; a totals row; a "สรุปหารือ" column at the end.
//! Week and month totals are SUM formulas (with cached results) so the file can be edited by hand.

use super::Scope;
use crate::errors::{AppError, AppResult};
use crate::taxonomy::{self, Service, Values};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Formula, Workbook, Worksheet, XlsxError};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;

const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn err(e: XlsxError) -> AppError {
    AppError::new("io", format!("เขียนไฟล์ Excel ไม่ได้: {e}"))
}

/// Months yyyy-mm from `from` to `to` inclusive.
pub fn months_between(from: &str, to: &str) -> Vec<String> {
    let parse = |s: &str| -> Option<(i32, u32)> { Some((s.get(0..4)?.parse().ok()?, s.get(5..7)?.parse().ok()?)) };
    let (Some((mut y, mut m)), Some((ty, tm))) = (parse(from), parse(to)) else { return vec![] };
    let mut out = vec![];
    while (y, m) <= (ty, tm) && out.len() < 240 {
        out.push(format!("{y:04}-{m:02}"));
        m += 1;
        if m > 12 {
            m = 1;
            y += 1;
        }
    }
    out
}

fn days_in(y: i32, m: u32) -> u32 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 0 = Monday … 6 = Sunday (Sakamoto)
fn weekday(y: i32, m: u32, d: u32) -> u32 {
    const T: [i32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if m < 3 { y - 1 } else { y };
    let sun0 = (y + y / 4 - y / 100 + y / 400 + T[(m - 1) as usize] + d as i32).rem_euclid(7) as u32;
    (sun0 + 6) % 7
}

/// Weeks of a month as day ranges: Monday first, cut at the month edges (same as the pivot's `week`).
pub fn weeks_of(y: i32, m: u32) -> Vec<(u32, u32)> {
    let last = days_in(y, m);
    let mut out = vec![];
    let mut start = 1;
    for d in 1..=last {
        if weekday(y, m, d) == 6 || d == last {
            out.push((start, d));
            start = d + 1;
        }
    }
    out
}

/// Spreadsheet column letters (0 → A).
fn col_name(mut c: u16) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s
}

fn cause_text(c: Option<&str>) -> &'static str {
    match c {
        Some("user") => "User",
        Some("program") => "Program/Software",
        Some("unclear") => "Unclear",
        _ => "",
    }
}

/// One time column: a day (its date), a week total (the day columns it sums) or a month total
/// (the week-total columns it sums).
enum TimeCol {
    Day(String),
    Week(Vec<u16>),
    Month(Vec<u16>),
}

struct Formats {
    head: Format,
    head_week: Format,
    head_month: Format,
    text: Format,
    wrap: Format,
    num: Format,
    week: Format,
    month: Format,
    total_label: Format,
    total: Format,
}

fn formats() -> Formats {
    let base = Format::new().set_border(FormatBorder::Thin).set_border_color(Color::RGB(0xBFC5CE)).set_font_name("Tahoma").set_font_size(10);
    let head = base.clone().set_bold().set_background_color(Color::RGB(0xE6F2EB)).set_align(FormatAlign::Center).set_align(FormatAlign::VerticalCenter).set_text_wrap();
    Formats {
        head_week: head.clone().set_background_color(Color::RGB(0xFFF2CC)),
        head_month: head.clone().set_background_color(Color::RGB(0xFCE4D6)),
        head,
        text: base.clone().set_align(FormatAlign::Top),
        wrap: base.clone().set_text_wrap().set_align(FormatAlign::Top),
        num: base.clone().set_align(FormatAlign::Center),
        week: base.clone().set_align(FormatAlign::Center).set_bold().set_background_color(Color::RGB(0xFFF2CC)),
        month: base.clone().set_align(FormatAlign::Center).set_bold().set_background_color(Color::RGB(0xFCE4D6)),
        total_label: base.clone().set_bold().set_background_color(Color::RGB(0xEEF0F3)),
        total: base.set_align(FormatAlign::Center).set_bold().set_background_color(Color::RGB(0xEEF0F3)),
    }
}

/// Write the workbook; returns the number of tickets counted.
pub fn export(conn: &Connection, scope: &Scope, path: &Path) -> AppResult<usize> {
    let services: Vec<Service> = taxonomy::list_services(conn)?
        .into_iter()
        .filter(|s| scope.service.as_deref().map_or(true, |x| x.is_empty() || x == s.name))
        .collect();
    let months = months_between(&scope.from, &scope.to);
    if months.is_empty() {
        return Err(AppError::new("invalid_scope", "ช่วงเดือนไม่ถูกต้อง"));
    }
    let mut wb = Workbook::new();
    let f = formats();
    let mut counted = 0usize;
    let mut used_names: Vec<String> = vec![];
    for svc in &services {
        let rows = taxonomy::list_taxonomy(conn, &svc.id)?;
        if rows.is_empty() {
            continue;
        }
        let ws = wb.add_worksheet();
        ws.set_name(sheet_name(&svc.name, &mut used_names)).map_err(err)?;
        counted += write_service(conn, ws, svc, &rows, &months, &f)?;
    }
    if used_names.is_empty() {
        return Err(AppError::new("no_taxonomy", "ยังไม่มีหมวดหมู่ให้ส่งออก — ตั้งหมวดหมู่ของเซอร์วิสก่อน"));
    }
    wb.save(path).map_err(err)?;
    Ok(counted)
}

/// Excel sheet names: ≤31 chars, none of []:*?/\ , unique.
fn sheet_name(name: &str, used: &mut Vec<String>) -> String {
    let clean: String = name.chars().map(|c| if "[]:*?/\\".contains(c) { '_' } else { c }).collect();
    let mut base: String = clean.trim().chars().take(28).collect();
    if base.is_empty() {
        base = "Sheet".into();
    }
    let mut n = base.clone();
    let mut i = 2;
    while used.iter().any(|u| u.eq_ignore_ascii_case(&n)) {
        n = format!("{base} {i}");
        i += 1;
    }
    used.push(n.clone());
    n
}

fn write_service(conn: &Connection, ws: &mut Worksheet, svc: &Service, rows: &[taxonomy::TaxonomyRow], months: &[String], f: &Formats) -> AppResult<usize> {
    let levels = svc.columns.len() as u16;
    let class_col = levels + 1;
    let first_time = levels + 2;
    let same = |a: &Values, b: &Values| svc.columns.iter().all(|c| a.get(c) == b.get(c));

    // ---- counts: (row index | unclassified, day) → n, and the tickets' own causes per row
    let (from, to) = (months.first().cloned().unwrap_or_default(), months.last().cloned().unwrap_or_default());
    let mut st = conn.prepare(
        "SELECT c.fields_json, substr(t.date, 1, 10), c.cause, COUNT(*) FROM tickets t LEFT JOIN classifications c ON c.ticket_id = t.id
         WHERE t.service = ?1 AND t.month BETWEEN ?2 AND ?3 GROUP BY 1, 2, 3",
    )?;
    let data = st.query_map(rusqlite::params![svc.name, from, to], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, i64>(3)? as u64))
    })?;
    let other = rows.len(); // "(ยังไม่มีหมวด)" row
    let mut counts: HashMap<(usize, String), u64> = HashMap::new();
    let mut causes: Vec<HashMap<String, u64>> = vec![HashMap::new(); rows.len() + 1];
    let mut parsed: HashMap<String, Option<usize>> = HashMap::new();
    let mut total = 0usize;
    for d in data {
        let (json, day, cause, n) = d?;
        let idx = match json {
            Some(j) => *parsed.entry(j.clone()).or_insert_with(|| serde_json::from_str::<Values>(&j).ok().and_then(|v| rows.iter().position(|r| same(&r.values, &v)))),
            None => None,
        }
        .unwrap_or(other);
        *counts.entry((idx, day)).or_default() += n;
        if let Some(c) = cause {
            *causes[idx].entry(c).or_default() += n;
        }
        total += n as usize;
    }
    let has_other = counts.keys().any(|(i, _)| *i == other);

    // ---- time columns
    let mut cols: Vec<TimeCol> = vec![];
    // (first col, last col, label) for the month and week header bands
    let mut month_bands: Vec<(u16, u16, String, u16)> = vec![];
    let mut week_bands: Vec<(u16, u16, String)> = vec![];
    let mut c = first_time;
    for ym in months {
        let (y, m): (i32, u32) = (ym[0..4].parse().unwrap_or(2026), ym[5..7].parse().unwrap_or(1));
        let band_start = c;
        let mut week_cols = vec![];
        for (wi, (a, b)) in weeks_of(y, m).into_iter().enumerate() {
            let wstart = c;
            let mut day_cols = vec![];
            for d in a..=b {
                cols.push(TimeCol::Day(format!("{ym}-{d:02}")));
                day_cols.push(c);
                c += 1;
            }
            cols.push(TimeCol::Week(day_cols));
            week_bands.push((wstart, c, format!("Week{}", wi + 1)));
            week_cols.push(c);
            c += 1;
        }
        month_bands.push((band_start, c - 1, MON[(m - 1) as usize].to_string(), c));
        cols.push(TimeCol::Month(week_cols));
        c += 1;
    }
    let note_col = c;

    // ---- header (3 rows)
    let fixed: Vec<String> = std::iter::once("No".to_string()).chain(svc.columns.iter().cloned()).chain(std::iter::once("Classification".to_string())).collect();
    for (i, h) in fixed.iter().enumerate() {
        ws.merge_range(0, i as u16, 2, i as u16, h, &f.head).map_err(err)?;
    }
    for (a, b, label, month_col) in &month_bands {
        ws.merge_range(0, *a, 0, *b, label, &f.head).map_err(err)?;
        let ym = &months[month_bands.iter().position(|x| x.3 == *month_col).unwrap_or(0)];
        let m: usize = ym[5..7].parse().unwrap_or(1);
        ws.merge_range(0, *month_col, 2, *month_col, &format!("Calls {} {}", MON[m - 1], &ym[0..4]), &f.head_month).map_err(err)?;
    }
    for (a, b, label) in &week_bands {
        if a == b {
            ws.write_string_with_format(1, *a, label, &f.head_week).map_err(err)?;
        } else {
            ws.merge_range(1, *a, 1, *b, label, &f.head_week).map_err(err)?;
        }
    }
    ws.merge_range(0, note_col, 2, note_col, "สรุปหารือ", &f.head).map_err(err)?;
    for (i, tc) in cols.iter().enumerate() {
        let col = first_time + i as u16;
        match tc {
            TimeCol::Day(d) => {
                ws.write_number_with_format(2, col, d[8..10].parse::<f64>().unwrap_or(0.0), &f.head).map_err(err)?;
            }
            TimeCol::Week(days) => {
                let day = |c: &u16| match &cols[(*c - first_time) as usize] {
                    TimeCol::Day(d) => d[8..10].trim_start_matches('0').to_string(),
                    _ => String::new(),
                };
                let ym = match &cols[(days[0] - first_time) as usize] {
                    TimeCol::Day(d) => d[5..7].parse::<usize>().unwrap_or(1),
                    _ => 1,
                };
                let (a, b) = (day(&days[0]), day(days.last().unwrap_or(&days[0])));
                let label = if a == b { format!("{} {a}", MON[ym - 1]) } else { format!("{} {a}-{b}", MON[ym - 1]) };
                ws.write_string_with_format(2, col, &label, &f.head_week).map_err(err)?;
            }
            TimeCol::Month(_) => {}
        }
    }

    // ---- body
    let n_rows = rows.len() + usize::from(has_other);
    let first_row = 3u32;
    let group_level = (levels as usize).saturating_sub(3); // "No" counts groups of this level (ProductType in a 5-level table)
    let mut no = 0u32;
    for i in 0..n_rows {
        let r = first_row + i as u32;
        let (values, fixed_cause): (Vec<String>, Option<&str>) = if i < rows.len() {
            (svc.columns.iter().map(|c| rows[i].values.get(c).cloned().unwrap_or_default()).collect(), rows[i].cause.as_deref())
        } else {
            (std::iter::once("(ยังไม่มีหมวด)".to_string()).chain(std::iter::repeat(String::new()).take(levels as usize - 1)).collect(), None)
        };
        let new_group = i == 0 || i >= rows.len() || svc.columns[..=group_level].iter().any(|c| rows[i].values.get(c) != rows[i - 1].values.get(c));
        if new_group {
            no += 1;
        }
        ws.write_number_with_format(r, 0, no as f64, &f.num).map_err(err)?;
        for (k, v) in values.iter().enumerate() {
            ws.write_string_with_format(r, 1 + k as u16, v, if k + 1 == values.len() { &f.wrap } else { &f.text }).map_err(err)?;
        }
        // Classification: the category's fixed one, else what most of its tickets got
        let cause = fixed_cause.map(str::to_string).or_else(|| causes[i.min(rows.len())].iter().max_by_key(|(_, n)| **n).map(|(c, _)| c.clone()));
        ws.write_string_with_format(r, class_col, cause_text(cause.as_deref()), &f.text).map_err(err)?;
        let idx = if i < rows.len() { i } else { other };
        let mut week_vals: HashMap<u16, u64> = HashMap::new();
        for (j, tc) in cols.iter().enumerate() {
            let col = first_time + j as u16;
            match tc {
                TimeCol::Day(d) => match counts.get(&(idx, d.clone())) {
                    Some(n) => ws.write_number_with_format(r, col, *n as f64, &f.num).map_err(err)?,
                    None => ws.write_blank(r, col, &f.num).map_err(err)?,
                },
                TimeCol::Week(days) => {
                    let v: u64 = days.iter().filter_map(|c| match &cols[(*c - first_time) as usize] {
                        TimeCol::Day(d) => counts.get(&(idx, d.clone())),
                        _ => None,
                    }).sum();
                    week_vals.insert(col, v);
                    let fm = Formula::new(format!("=SUM({}{}:{}{})", col_name(days[0]), r + 1, col_name(*days.last().unwrap_or(&days[0])), r + 1)).set_result(v.to_string());
                    ws.write_formula_with_format(r, col, fm, &f.week).map_err(err)?
                }
                TimeCol::Month(weeks) => {
                    let v: u64 = weeks.iter().map(|w| week_vals.get(w).copied().unwrap_or(0)).sum();
                    let refs: Vec<String> = weeks.iter().map(|w| format!("{}{}", col_name(*w), r + 1)).collect();
                    ws.write_formula_with_format(r, col, Formula::new(format!("=SUM({})", refs.join(","))).set_result(v.to_string()), &f.month).map_err(err)?
                }
            };
        }
        ws.write_blank(r, note_col, &f.wrap).map_err(err)?;
    }
    // merge repeated upper levels (and No) down the rows, like the hand-made report
    if n_rows > 1 {
        let cell = |i: usize, k: usize| if i < rows.len() { rows[i].values.get(&svc.columns[k]).cloned().unwrap_or_default() } else { format!("\u{0}{i}") };
        for k in 0..(levels as usize).saturating_sub(1) {
            let mut start = 0usize;
            for i in 1..=n_rows {
                let same_run = i < n_rows && (0..=k).all(|kk| cell(i, kk) == cell(i - 1, kk));
                if !same_run {
                    if i - start > 1 {
                        ws.merge_range(first_row + start as u32, 1 + k as u16, first_row + i as u32 - 1, 1 + k as u16, &cell(start, k), &f.text).map_err(err)?;
                        if k == group_level {
                            ws.merge_range(first_row + start as u32, 0, first_row + i as u32 - 1, 0, "", &f.num).map_err(err)?;
                            let no_at: f64 = (1..=start).filter(|&x| x == 0 || (0..=group_level).any(|kk| cell(x, kk) != cell(x - 1, kk))).count() as f64 + 1.0;
                            ws.write_number_with_format(first_row + start as u32, 0, no_at, &f.num).map_err(err)?;
                        }
                    }
                    start = i;
                }
            }
        }
    }
    // ---- totals row
    let tr = first_row + n_rows as u32;
    ws.merge_range(tr, 0, tr, class_col, "รวม", &f.total_label).map_err(err)?;
    for j in 0..cols.len() {
        let col = first_time + j as u16;
        let v: u64 = (0..n_rows)
            .map(|i| {
                let idx = if i < rows.len() { i } else { other };
                match &cols[j] {
                    TimeCol::Day(d) => counts.get(&(idx, d.clone())).copied().unwrap_or(0),
                    TimeCol::Week(days) => days.iter().filter_map(|c| match &cols[(*c - first_time) as usize] {
                        TimeCol::Day(d) => counts.get(&(idx, d.clone())),
                        _ => None,
                    }).sum(),
                    TimeCol::Month(_) => 0,
                }
            })
            .sum();
        let v = if let TimeCol::Month(weeks) = &cols[j] {
            weeks.iter().map(|w| (0..n_rows).map(|i| {
                let idx = if i < rows.len() { i } else { other };
                match &cols[(*w - first_time) as usize] {
                    TimeCol::Week(days) => days.iter().filter_map(|c| match &cols[(*c - first_time) as usize] {
                        TimeCol::Day(d) => counts.get(&(idx, d.clone())),
                        _ => None,
                    }).sum::<u64>(),
                    _ => 0,
                }
            }).sum::<u64>()).sum()
        } else {
            v
        };
        let fm = Formula::new(format!("=SUM({c}{}:{c}{})", first_row + 1, tr, c = col_name(col))).set_result(v.to_string());
        ws.write_formula_with_format(tr, col, fm, &f.total).map_err(err)?;
    }
    ws.write_blank(tr, note_col, &f.total).map_err(err)?;

    // ---- sizes, freeze
    ws.set_column_width(0, 5).map_err(err)?;
    for k in 0..levels {
        let w = if k + 1 == levels { 48.0 } else { 18.0 };
        ws.set_column_width(1 + k, w).map_err(err)?;
    }
    ws.set_column_width(class_col, 16).map_err(err)?;
    for (j, tc) in cols.iter().enumerate() {
        let w = match tc {
            TimeCol::Day(_) => 4.2,
            TimeCol::Week(_) => 9.0,
            TimeCol::Month(_) => 11.0,
        };
        ws.set_column_width(first_time + j as u16, w).map_err(err)?;
    }
    ws.set_column_width(note_col, 40).map_err(err)?;
    ws.set_row_height(2, 30).map_err(err)?;
    ws.set_freeze_panes(3, first_time).map_err(err)?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weeks_start_monday_and_cut_at_month_edges() {
        // 1 Jan 2026 is a Thursday → the user's report: Jan 1-4, 5-11, 12-18, 19-25, 26-31
        assert_eq!(weeks_of(2026, 1), vec![(1, 4), (5, 11), (12, 18), (19, 25), (26, 31)]);
        // 1 Feb 2026 is a Sunday → Feb 1, 2-8 …
        assert_eq!(weeks_of(2026, 2)[0], (1, 1));
        assert_eq!(weekday(2026, 10, 1), 3); // Thursday
        assert_eq!(months_between("2025-11", "2026-02"), vec!["2025-11", "2025-12", "2026-01", "2026-02"]);
        assert_eq!(col_name(0), "A");
        assert_eq!(col_name(25), "Z");
        assert_eq!(col_name(26), "AA");
        assert_eq!(col_name(441), "PZ");
    }

    #[test]
    fn writes_a_workbook_with_counts_formulas_and_classification() {
        let dir = tempfile::tempdir().unwrap();
        let (_p, c) = crate::export::testdata::project(dir.path(), "A");
        c.execute("UPDATE taxonomy_rows SET cause = 'user'", []).unwrap();
        let out = dir.path().join("a.xlsx");
        let n = export(&c, &Scope { from: "2026-09".into(), to: "2026-10".into(), service: None }, &out).unwrap();
        assert_eq!(n, 2); // Internet's 2 tickets (IPTV has no categories → no sheet)
        // read it back
        use calamine::{open_workbook, Reader, Xlsx};
        let mut wb: Xlsx<_> = open_workbook(&out).unwrap();
        assert_eq!(wb.sheet_names(), vec!["Internet"]);
        let r = wb.worksheet_range("Internet").unwrap();
        let s = |row: usize, col: usize| r.get((row, col)).map(|v| v.to_string()).unwrap_or_default();
        assert_eq!(s(0, 0), "No");
        assert_eq!(s(0, 1), "หัวข้อหลัก");
        assert_eq!(s(0, 3), "Classification");
        assert_eq!(s(0, 4), "Sep");
        assert_eq!(s(1, 4), "Week1");
        assert_eq!(s(2, 4), "1");
        assert!((0..r.width()).any(|c| s(0, c) == "Calls Sep 2026"));
        assert!((0..r.width()).any(|c| s(2, c) == "Oct 1-4"));
        assert_eq!(s(3, 1), "การเชื่อมต่อ");
        assert_eq!(s(3, 3), "User");
        let f = wb.worksheet_formula("Internet").unwrap();
        assert!(f.used_cells().any(|(_, _, v)| v.starts_with("SUM(")));
    }
}

/// Writes `target/sample_analysis.xlsx` (5 levels like the team's report, Jan–Feb 2026) to look at.
/// `cargo test --lib sample_analysis -- --ignored`
#[cfg(test)]
#[test]
#[ignore]
fn sample_analysis() {
    use crate::taxonomy::{create_service, save_row, RowInput};
    let dir = tempfile::tempdir().unwrap();
    let mut c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
    let cols: Vec<String> = ["Category", "SubCategory", "ProductType", "Problem Type", "สรุปวิเคราะห์ Call"].iter().map(|s| s.to_string()).collect();
    let s = create_service(&c, "StorePortal_Store Time Management", None, &cols).unwrap();
    let cats = [
        ("Login", "เด้งออกกลับมาหน้า Login", "กด log in แล้วเด้งออก", Some("user")),
        ("Login", "สอบถามข้อมูล / ตรวจสอบข้อมูล", "หน้าจอค้าง Continue with SBP", Some("program")),
        ("Login", "สอบถามข้อมูล / ตรวจสอบข้อมูล", "สอบถามการ log in ผ่าน Entra", Some("user")),
        ("Manage TIme", "ข้อมูลปรับปรุงเวลาแสดงไม่ถูกต้อง", "ผจก. ไม่ได้จัดกะย้อนหลัง", Some("user")),
        ("Manage TIme", "หน้าพิมพ์ใบลงเวลาแสดงหน้าขาว", "ทั่วไป", None),
    ];
    let mut ids = vec![];
    for (pt, prob, sum, cause) in cats {
        let values = cols.iter().cloned().zip(["SC Process", "StorePortal_Store Time Management", pt, prob, sum].iter().map(|s| s.to_string())).collect();
        ids.push(save_row(&mut c, &s.id, &RowInput { id: None, values, description: String::new(), examples: String::new(), cause: cause.map(String::from) }).unwrap().values);
    }
    for i in 0..400usize {
        let m = 1 + i % 2;
        let d = 1 + (i * 7) % if m == 1 { 31 } else { 28 };
        let date = format!("2026-{m:02}-{d:02}");
        c.execute("INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES(?1,?1,?2,substr(?2,1,7),?3,'x','{}','i')", rusqlite::params![format!("T{i}"), date, s.name]).unwrap();
        if i % 17 != 0 {
            c.execute("INSERT INTO classifications(ticket_id,fields_json,source,cause) VALUES(?1,?2,'ai','user')", rusqlite::params![format!("T{i}"), serde_json::to_string(&ids[i % ids.len()]).unwrap()]).unwrap();
        }
    }
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/sample_analysis.xlsx");
    let n = export(&c, &Scope { from: "2026-01".into(), to: "2026-02".into(), service: None }, &out).unwrap();
    println!("{} tickets → {}", n, out.display());
}
