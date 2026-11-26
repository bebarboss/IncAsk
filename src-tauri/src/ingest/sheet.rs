//! Read `.csv` / `.xlsx` / `.xls` into rows of text (SPEC §5).
//! Based on DocAsk's ingest/sheet.rs (calamine reader, cell formatting, delimiter sniffing), with
//! encoding detection done by `encoding_rs`: UTF-8 with/without BOM, UTF-16 BOM, else Windows-874.
//! Excel date cells become ISO `yyyy-mm-dd[ hh:mm:ss]` so they are never ambiguous.

use crate::errors::{AppError, AppResult};
use calamine::{open_workbook_auto, Data, Reader};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    /// every sheet name (one, "CSV", for a csv file)
    pub sheets: Vec<String>,
    pub sheet: String,
    pub rows: Vec<Vec<String>>,
}

pub fn is_csv(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("csv" | "tsv" | "txt"))
}

/// Read one sheet (the first when `sheet` is None or not found).
pub fn read_table(path: &Path, sheet: Option<&str>) -> AppResult<Table> {
    if !path.is_file() {
        return Err(AppError::new("not_found", "ไม่พบไฟล์"));
    }
    if is_csv(path) {
        let bytes = std::fs::read(path)?;
        return Ok(Table { sheets: vec!["CSV".into()], sheet: "CSV".into(), rows: read_delimited(&bytes) });
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "xlsx" | "xlsm" | "xls" | "xlsb" | "ods") {
        return Err(AppError::new("file_type", "รองรับเฉพาะไฟล์ .csv, .xlsx และ .xls"));
    }
    let mut wb = open_workbook_auto(path).map_err(|e| AppError::new("sheet", format!("อ่านไฟล์ Excel ไม่ได้: {e}")))?;
    let sheets = wb.sheet_names().to_vec();
    if sheets.is_empty() {
        return Err(AppError::new("sheet", "ไฟล์ Excel ไม่มีชีต"));
    }
    let name = sheet.filter(|s| sheets.iter().any(|x| x == s)).map(str::to_string).unwrap_or_else(|| sheets[0].clone());
    let range = wb.worksheet_range(&name).map_err(|e| AppError::new("sheet", format!("อ่านชีต {name} ไม่ได้: {e}")))?;
    let rows = range.rows().map(|r| r.iter().map(cell_text).collect()).collect();
    Ok(Table { sheets, sheet: name, rows })
}

pub fn cell_text(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", *f as i64),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => excel_date_iso(d.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(_) => String::new(),
    }
}

/// Excel serial → "yyyy-mm-dd" or "yyyy-mm-dd hh:mm:ss" (1899-12-30 is day 0).
pub fn excel_date_iso(serial: f64) -> String {
    let days = serial.floor() as i64;
    let (y, m, d) = civil_from_days(days - 25569);
    let secs = ((serial - serial.floor()) * 86400.0).round() as i64;
    if secs == 0 {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
    }
}

/// Days since 1970-01-01 → (year, month, day) (Howard Hinnant's algorithm).
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// UTF-8 (with or without BOM) and UTF-16 with BOM; anything that isn't valid UTF-8 is read as
/// Windows-874 (TIS-620 superset), which is what Thai Excel writes for "CSV".
pub fn decode(bytes: &[u8]) -> String {
    if let Some((enc, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom..]);
        return text.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_874.decode_without_bom_handling(bytes).0.into_owned(),
    }
}

fn read_delimited(bytes: &[u8]) -> Vec<Vec<String>> {
    let text = decode(bytes);
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let delim = (*b",\t;|")
        .into_iter()
        .max_by_key(|d| first.bytes().filter(|b| b == d).count())
        .unwrap_or(b',');
    let mut r = csv::ReaderBuilder::new().has_headers(false).flexible(true).delimiter(delim).from_reader(text.as_bytes());
    r.records().filter_map(Result::ok).map(|rec| rec.iter().map(|s| s.trim().to_string()).collect()).collect()
}

/// The header row: the first non-empty row with at least two text (non-numeric) cells.
pub fn header_row(rows: &[Vec<String>]) -> Option<usize> {
    rows.iter().position(|r| {
        r.iter().filter(|c| !c.trim().is_empty() && c.trim().parse::<f64>().is_err()).count() >= 2
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_with_and_without_bom() {
        let s = "เลขอินซิเดนต์,วันที่";
        assert_eq!(decode(s.as_bytes()), s);
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(s.as_bytes());
        assert_eq!(decode(&bom), s);
    }

    #[test]
    fn decodes_windows_874() {
        let (bytes, _, _) = encoding_rs::WINDOWS_874.encode("เน็ตหลุด,ภาพกระตุก");
        assert_eq!(decode(&bytes), "เน็ตหลุด,ภาพกระตุก");
    }

    #[test]
    fn decodes_utf16_bom() {
        let mut b = vec![0xFF, 0xFE];
        for u in "ทดสอบ".encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode(&b), "ทดสอบ");
    }

    #[test]
    fn reads_csv_with_quotes_and_sniffs_delimiter() {
        let rows = read_delimited("a;b;c\n1;\"x; y\";3\n".as_bytes());
        assert_eq!(rows, vec![vec!["a", "b", "c"], vec!["1", "x; y", "3"]]);
    }

    #[test]
    fn finds_header_row_after_title_rows() {
        let rows: Vec<Vec<String>> = vec![
            vec!["รายงานอินซิเดนต์ ต.ค. 2569".into(), "".into()],
            vec!["".into(), "".into()],
            vec!["เลขอินซิเดนต์".into(), "วันที่แจ้ง".into(), "เซอร์วิส".into()],
            vec!["INC1".into(), "01/10/2569".into(), "Internet".into()],
        ];
        assert_eq!(header_row(&rows), Some(2));
        let numbers: Vec<Vec<String>> = vec![vec!["1".into(), "2".into()], vec!["ก".into(), "ข".into()]];
        assert_eq!(header_row(&numbers), Some(1));
    }

    #[test]
    fn excel_serials_become_iso() {
        assert_eq!(excel_date_iso(45566.0), "2024-10-01");
        assert_eq!(excel_date_iso(45566.5), "2024-10-01 12:00:00");
    }

    #[test]
    fn reads_xlsx_sheets() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.xlsx");
        let mut wb = rust_xlsxwriter::Workbook::new();
        let ws = wb.add_worksheet().set_name("ต.ค.").unwrap();
        ws.write_string(0, 0, "เลขอินซิเดนต์").unwrap();
        ws.write_string(0, 1, "จำนวน").unwrap();
        ws.write_string(1, 0, "INC0102341").unwrap();
        ws.write_number(1, 1, 3.0).unwrap();
        wb.add_worksheet().set_name("อื่นๆ").unwrap();
        wb.save(&p).unwrap();
        let t = read_table(&p, None).unwrap();
        assert_eq!(t.sheets, vec!["ต.ค.", "อื่นๆ"]);
        assert_eq!(t.rows[1], vec!["INC0102341", "3"]);
        assert!(read_table(&dir.path().join("x.pdf"), None).is_err());
    }
}
