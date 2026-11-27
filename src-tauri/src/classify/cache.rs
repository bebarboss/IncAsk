//! Result cache (SPEC §6.3): the same problem text, for the same service, taxonomy version and
//! model, is answered from the cache instead of the LLM.

use crate::errors::AppResult;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// trim, collapse whitespace, lowercase Latin letters (Thai is left as is)
pub fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().map(|c| c.to_ascii_lowercase()).collect()
}

pub fn key(service: &str, text: &str, taxonomy_version: i64, model: &str) -> String {
    // "cause1": answers cached before ต้นเหตุ was asked have none — ask those texts again
    let raw = format!("{service}\n{}\n{taxonomy_version}\n{model}\ncause1", normalize(text));
    hex::encode(Sha256::digest(raw.as_bytes()))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub fields_json: Option<String>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub cause: Option<String>,
}

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<Hit>> {
    Ok(conn
        .query_row("SELECT fields_json, confidence, reason, cause FROM cache WHERE key = ?1", [key], |r| {
            Ok(Hit { fields_json: r.get(0)?, confidence: r.get(1)?, reason: r.get(2)?, cause: r.get(3)? })
        })
        .optional()?)
}

pub fn put(conn: &Connection, key: &str, fields_json: Option<&str>, confidence: f64, reason: &str, cause: Option<&str>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO cache(key, fields_json, confidence, reason, created_at, cause) VALUES(?1, ?2, ?3, ?4, datetime('now'), ?5)
         ON CONFLICT(key) DO UPDATE SET fields_json = excluded.fields_json, confidence = excluded.confidence, reason = excluded.reason, cause = excluded.cause",
        params![key, fields_json, confidence, reason, cause],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_ignores_spacing_and_latin_case_but_not_meaning() {
        let a = key("Internet", "  หัวข้อ:   WiFi ช้า ", 3, "godev1");
        assert_eq!(a, key("Internet", "หัวข้อ: wifi ช้า", 3, "godev1"));
        assert_ne!(a, key("Internet", "หัวข้อ: wifi ช้า", 4, "godev1")); // taxonomy changed
        assert_ne!(a, key("Internet", "หัวข้อ: wifi ช้า", 3, "gothink1")); // other model
        assert_ne!(a, key("IPTV", "หัวข้อ: wifi ช้า", 3, "godev1"));
        assert_eq!(normalize(" A\tB  ค "), "a b ค");
    }

    #[test]
    fn stores_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        assert!(get(&c, "k").unwrap().is_none());
        put(&c, "k", Some("{\"หัวข้อหลัก\":\"x\"}"), 0.9, "r", None).unwrap();
        put(&c, "k", Some("{\"หัวข้อหลัก\":\"y\"}"), 0.8, "r2", Some("user")).unwrap();
        let h = get(&c, "k").unwrap().unwrap();
        assert_eq!(h.fields_json.as_deref(), Some("{\"หัวข้อหลัก\":\"y\"}"));
        assert_eq!(h.confidence, Some(0.8));
        assert_eq!(h.cause.as_deref(), Some("user"));
    }
}
