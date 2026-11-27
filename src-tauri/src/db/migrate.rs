//! Per-project schema (SPEC §4.2) and migrations by `meta.schema_version`.
//! Each entry in MIGRATIONS moves the database from version i to i+1, inside one transaction.

use rusqlite::{Connection, OptionalExtension};

pub const SCHEMA_VERSION: i64 = 2;

const V1: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE services(
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL DEFAULT 1, sort INTEGER);
CREATE TABLE taxonomy_rows(
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  values_json TEXT NOT NULL,
  description TEXT, examples TEXT, sort INTEGER);
CREATE TABLE report_patterns(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  header_signature TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  date_format TEXT);
CREATE TABLE imports(
  id TEXT PRIMARY KEY, file_name TEXT, pattern_id TEXT, imported_at TEXT,
  rows_total INTEGER, rows_new INTEGER, rows_duplicate INTEGER, rows_invalid INTEGER);
CREATE TABLE tickets(
  id TEXT PRIMARY KEY, ticket_no TEXT UNIQUE NOT NULL, date TEXT NOT NULL,
  month TEXT NOT NULL,
  service TEXT NOT NULL, problem_text TEXT NOT NULL,
  source_json TEXT NOT NULL,
  import_id TEXT NOT NULL);
CREATE TABLE classifications(
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  fields_json TEXT,
  ai_fields_json TEXT,
  confidence REAL, reason TEXT,
  source TEXT NOT NULL,
  model TEXT, taxonomy_version INTEGER, updated_at TEXT, edited_by TEXT) WITHOUT ROWID;
CREATE TABLE cache(key TEXT PRIMARY KEY, fields_json TEXT, confidence REAL, reason TEXT, created_at TEXT);
CREATE TABLE runs(
  id TEXT PRIMARY KEY, import_id TEXT, kind TEXT,
  started_at TEXT, finished_at TEXT, model TEXT, status TEXT,
  rows_total INTEGER, rows_done INTEGER, rows_cached INTEGER, rows_low INTEGER, rows_error INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL);
CREATE TABLE saved_views(id TEXT PRIMARY KEY, name TEXT, config_json TEXT, sort INTEGER);
CREATE TABLE prefs(key TEXT PRIMARY KEY, value TEXT);
-- (month, service) per SPEC + id so the pivot/summary scans never touch the table rows
CREATE INDEX idx_tickets_month ON tickets(month, service, id);
"#;

/// ต้นเหตุ (user | program | unclear): the AI's answer and the current one (a person may change it)
const V2: &str = r#"
ALTER TABLE classifications ADD COLUMN cause TEXT;
ALTER TABLE classifications ADD COLUMN ai_cause TEXT;
ALTER TABLE cache ADD COLUMN cause TEXT;
"#;

const MIGRATIONS: &[&str] = &[V1, V2];

pub fn current_version(conn: &Connection) -> rusqlite::Result<i64> {
    let has_meta: bool = conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'", [], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if !has_meta {
        return Ok(0);
    }
    let v: Option<String> =
        conn.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0)).optional()?;
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
}

/// Bring the database up to SCHEMA_VERSION. Refuses a file written by a newer IncAsk.
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<i64> {
    let mut v = current_version(conn)?;
    if v > SCHEMA_VERSION {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISMATCH),
            Some(format!("ไฟล์โปรเจกต์มาจาก IncAsk รุ่นใหม่กว่า (schema {v}) — อัปเดตโปรแกรมก่อน")),
        ));
    }
    while v < SCHEMA_VERSION {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATIONS[v as usize])?;
        v += 1;
        tx.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [v.to_string()],
        )?;
        tx.commit()?;
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables(conn: &Connection) -> Vec<String> {
        let mut st = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn creates_every_spec_table_once() {
        let mut c = Connection::open_in_memory().unwrap();
        assert_eq!(migrate(&mut c).unwrap(), SCHEMA_VERSION);
        assert_eq!(
            tables(&c),
            vec!["cache", "classifications", "imports", "meta", "prefs", "report_patterns", "runs", "saved_views", "services", "taxonomy_rows", "tickets"]
        );
        // running again is a no-op
        assert_eq!(migrate(&mut c).unwrap(), SCHEMA_VERSION);
        assert_eq!(current_version(&c).unwrap(), SCHEMA_VERSION);
        let cols: Vec<String> = c.prepare("SELECT name FROM pragma_table_info('classifications')").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert!(cols.ends_with(&["cause".to_string(), "ai_cause".to_string()]));
    }

    #[test]
    fn refuses_newer_schema() {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c).unwrap();
        c.execute("UPDATE meta SET value='99' WHERE key='schema_version'", []).unwrap();
        assert!(migrate(&mut c).is_err());
    }
}
