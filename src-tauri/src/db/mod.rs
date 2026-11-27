//! One SQLite file per project (`projects/<id>.sqlite`), WAL + foreign keys, migrated on open.

pub mod migrate;
pub mod projects;

use crate::errors::AppResult;
use rusqlite::Connection;
use std::path::Path;

/// Open (creating if needed) a project database and bring its schema up to date.
pub fn open(path: &Path) -> AppResult<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrate::migrate(&mut conn)?;
    Ok(conn)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

/// Per-project preferences (table settings, low-confidence threshold, heatmap …) as text.
pub fn get_pref(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn.query_row("SELECT value FROM prefs WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_pref(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute("INSERT INTO prefs(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])?;
    Ok(())
}

/// SPEC §6.2: below this confidence a result is "ไม่มั่นใจ" (default 0.7).
pub fn low_threshold(conn: &Connection) -> f64 {
    get_pref(conn, "low_threshold").ok().flatten().and_then(|v| v.parse::<f64>().ok()).filter(|v| (0.0..=1.0).contains(v)).unwrap_or(0.7)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_sets_wal_and_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        let c = open(&dir.path().join("p.sqlite")).unwrap();
        let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        let fk: i64 = c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        assert_eq!(fk, 1);
        assert_eq!(get_meta(&c, "schema_version").unwrap().as_deref(), Some(crate::db::migrate::SCHEMA_VERSION.to_string().as_str()));
    }

    #[test]
    fn deleting_a_service_cascades_to_its_taxonomy() {
        let dir = tempfile::tempdir().unwrap();
        let c = open(&dir.path().join("p.sqlite")).unwrap();
        c.execute("INSERT INTO services(id,name,color,columns_json) VALUES('s1','Internet','#2F6FB0','[\"หัวข้อหลัก\"]')", []).unwrap();
        c.execute("INSERT INTO taxonomy_rows(id,service_id,values_json) VALUES('t1','s1','{}')", []).unwrap();
        c.execute("DELETE FROM services WHERE id='s1'", []).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM taxonomy_rows", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
