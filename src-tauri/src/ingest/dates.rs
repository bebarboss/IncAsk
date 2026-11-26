//! Ticket dates (SPEC §5): Excel serial, `dd/mm/yyyy`, `d/m/yy`, `yyyy-mm-dd`, with an optional
//! time after the date. Years above 2400 are พ.ศ. (−543). Day/month order is decided for the whole
//! column: a first part > 12 means day-first, a second part > 12 means month-first; when no value
//! settles it the user is asked.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateOrder {
    /// day/month/year (Thai default)
    Dmy,
    /// month/day/year
    Mdy,
}

impl DateOrder {
    pub fn as_str(self) -> &'static str {
        match self {
            DateOrder::Dmy => "dmy",
            DateOrder::Mdy => "mdy",
        }
    }
    pub fn parse(s: &str) -> Option<DateOrder> {
        match s {
            "dmy" => Some(DateOrder::Dmy),
            "mdy" => Some(DateOrder::Mdy),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ymd {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

impl Ymd {
    pub fn iso(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
    pub fn month(&self) -> String {
        format!("{:04}-{:02}", self.y, self.m)
    }
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

fn year_ce(raw: &str) -> Option<i32> {
    let y: i32 = raw.parse().ok()?;
    let y = match raw.len() {
        // two-digit years: 50–99 are พ.ศ. 25xx (Thai reports), 00–49 are ค.ศ. 20xx
        1 | 2 if y >= 50 => 2500 + y,
        1 | 2 => 2000 + y,
        4 => y,
        _ => return None,
    };
    Some(if y > 2400 { y - 543 } else { y })
}

fn build(y: i32, m: u32, d: u32) -> Option<Ymd> {
    ((1900..=2200).contains(&y) && (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)).then_some(Ymd { y, m, d })
}

/// Split off a trailing time ("01/10/2569 08:15", "2026-10-01T08:15:00").
fn date_part(s: &str) -> &str {
    let s = s.trim();
    let cut = s.find([' ', 'T']).unwrap_or(s.len());
    &s[..cut]
}

/// The two leading numbers of a d/m/y or m/d/y date (None for ISO, serials, junk).
fn first_two(s: &str) -> Option<(u32, u32)> {
    let p: Vec<&str> = date_part(s).split(['/', '-', '.']).collect();
    if p.len() != 3 || p[0].len() > 2 {
        return None;
    }
    Some((p[0].parse().ok()?, p[1].parse().ok()?))
}

pub fn parse(s: &str, order: DateOrder) -> Option<Ymd> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    // Excel serial typed into a number cell (1955-01-01 … 2173-10-14)
    if let Ok(f) = t.parse::<f64>() {
        if (20000.0..100000.0).contains(&f) {
            let (y, m, d) = super::sheet::civil_from_days(f.floor() as i64 - 25569);
            return build(y as i32, m as u32, d as u32);
        }
        return None;
    }
    let p: Vec<&str> = date_part(t).split(['/', '-', '.']).collect();
    if p.len() != 3 || p.iter().any(|x| x.is_empty() || !x.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    if p[0].len() == 4 {
        return build(year_ce(p[0])?, p[1].parse().ok()?, p[2].parse().ok()?);
    }
    let (a, b): (u32, u32) = (p[0].parse().ok()?, p[1].parse().ok()?);
    let y = year_ce(p[2])?;
    match order {
        DateOrder::Dmy => build(y, b, a),
        DateOrder::Mdy => build(y, a, b),
    }
}

/// `Some(order)` when the column settles it (or has no d/m vs m/d values at all → Dmy);
/// `None` when every value fits both orders and the user must choose.
pub fn detect_order<'a>(values: impl Iterator<Item = &'a str>) -> Option<DateOrder> {
    let (mut day_first, mut month_first, mut slashy) = (false, false, false);
    for v in values {
        if let Some((a, b)) = first_two(v) {
            slashy = true;
            if a > 12 && b <= 12 {
                day_first = true;
            }
            if b > 12 && a <= 12 {
                month_first = true;
            }
        }
    }
    match (day_first, month_first) {
        (true, false) => Some(DateOrder::Dmy),
        (false, true) => Some(DateOrder::Mdy),
        // mixed evidence: the file is inconsistent — prefer the Thai convention
        (true, true) => Some(DateOrder::Dmy),
        (false, false) if !slashy => Some(DateOrder::Dmy),
        (false, false) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use DateOrder::*;

    fn iso(s: &str, o: DateOrder) -> Option<String> {
        parse(s, o).map(|d| d.iso())
    }

    #[test]
    fn buddhist_years_become_ce() {
        assert_eq!(iso("01/10/2569", Dmy).as_deref(), Some("2026-10-01"));
        assert_eq!(iso("1/10/69", Dmy).as_deref(), Some("2026-10-01"));
        assert_eq!(iso("2569-10-31", Dmy).as_deref(), Some("2026-10-31"));
        assert_eq!(iso("31.10.2026", Dmy).as_deref(), Some("2026-10-31"));
        assert_eq!(iso("5/3/26", Dmy).as_deref(), Some("2026-03-05"));
    }

    #[test]
    fn times_and_iso_and_serials() {
        assert_eq!(iso("01/10/2569 08:15", Dmy).as_deref(), Some("2026-10-01"));
        assert_eq!(iso("2026-10-01T08:15:00", Dmy).as_deref(), Some("2026-10-01"));
        assert_eq!(iso("2026-10-01 08:15:00", Mdy).as_deref(), Some("2026-10-01"));
        assert_eq!(iso("46296", Dmy).as_deref(), Some("2026-10-01"));
        assert_eq!(parse("2026-10-01", Dmy).unwrap().month(), "2026-10");
    }

    #[test]
    fn order_matters_only_for_slash_dates() {
        assert_eq!(iso("03/04/2569", Dmy).as_deref(), Some("2026-04-03"));
        assert_eq!(iso("03/04/2569", Mdy).as_deref(), Some("2026-03-04"));
        assert_eq!(iso("10/31/2026", Mdy).as_deref(), Some("2026-10-31"));
    }

    #[test]
    fn rejects_bad_dates() {
        for bad in ["", "ไม่ระบุ", "31/02/2569", "13/13/2569", "2026-13-01", "12", "1/2", "abc/def/ghij"] {
            assert!(parse(bad, Dmy).is_none(), "{bad}");
        }
        assert_eq!(iso("29/02/2567", Dmy).as_deref(), Some("2024-02-29"));
    }

    #[test]
    fn detects_order_from_the_whole_column() {
        assert_eq!(detect_order(["03/04/2569", "15/04/2569"].into_iter()), Some(Dmy));
        assert_eq!(detect_order(["03/04/2569", "04/15/2569"].into_iter()), Some(Mdy));
        assert_eq!(detect_order(["03/04/2569", "05/06/2569"].into_iter()), None);
        assert_eq!(detect_order(["2026-10-01", "46296"].into_iter()), Some(Dmy));
    }
}
