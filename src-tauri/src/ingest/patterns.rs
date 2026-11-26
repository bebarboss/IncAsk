//! Report patterns (SPEC §5): a file's headers → which column plays which role. Matched by
//! `header_signature` = sha256 of the headers, trimmed + lowercased, in file order.

use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Ticket,
    Date,
    Problem,
    Service,
    None,
}

/// As stored in `report_patterns.roles_json`: header names per role.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RoleMap {
    pub ticket: Option<String>,
    pub date: Option<String>,
    pub service: Option<String>,
    #[serde(default)]
    pub problem: Vec<String>,
}

impl RoleMap {
    pub fn from_roles(headers: &[String], roles: &[Role]) -> RoleMap {
        let mut m = RoleMap::default();
        for (h, r) in headers.iter().zip(roles) {
            match r {
                Role::Ticket => m.ticket = Some(h.clone()),
                Role::Date => m.date = Some(h.clone()),
                Role::Service => m.service = Some(h.clone()),
                Role::Problem => m.problem.push(h.clone()),
                Role::None => {}
            }
        }
        m
    }
    pub fn to_roles(&self, headers: &[String]) -> Vec<Role> {
        headers
            .iter()
            .map(|h| {
                if self.ticket.as_ref() == Some(h) {
                    Role::Ticket
                } else if self.date.as_ref() == Some(h) {
                    Role::Date
                } else if self.service.as_ref() == Some(h) {
                    Role::Service
                } else if self.problem.contains(h) {
                    Role::Problem
                } else {
                    Role::None
                }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pattern {
    pub id: String,
    pub name: String,
    pub headers: Vec<String>,
    pub roles: RoleMap,
    pub date_format: Option<String>,
}

pub fn header_signature(headers: &[String]) -> String {
    let joined = headers.iter().map(|h| h.trim().to_lowercase()).collect::<Vec<_>>().join("\n");
    hex::encode(Sha256::digest(joined.as_bytes()))
}

fn row_to_pattern(r: &rusqlite::Row) -> rusqlite::Result<Pattern> {
    let h: String = r.get(2)?;
    let roles: String = r.get(3)?;
    Ok(Pattern {
        id: r.get(0)?,
        name: r.get(1)?,
        headers: serde_json::from_str(&h).unwrap_or_default(),
        roles: serde_json::from_str(&roles).unwrap_or_default(),
        date_format: r.get(4)?,
    })
}

const COLS: &str = "id, name, headers_json, roles_json, date_format";

pub fn find(conn: &Connection, headers: &[String]) -> AppResult<Option<Pattern>> {
    let sig = header_signature(headers);
    Ok(conn.query_row(&format!("SELECT {COLS} FROM report_patterns WHERE header_signature = ?1"), [sig], row_to_pattern).optional()?)
}

pub fn list(conn: &Connection) -> AppResult<Vec<Pattern>> {
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM report_patterns ORDER BY name"))?;
    let rows = st.query_map([], row_to_pattern)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Insert or update the pattern for these headers (one pattern per signature).
pub fn save(conn: &Connection, name: &str, headers: &[String], roles: &RoleMap, date_format: Option<&str>) -> AppResult<Pattern> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::new("invalid_name", "ใส่ชื่อรูปแบบรีพอร์ตก่อน"));
    }
    let sig = header_signature(headers);
    let id = match find(conn, headers)? {
        Some(p) => p.id,
        None => format!("rp-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
    };
    conn.execute(
        "INSERT INTO report_patterns(id, name, header_signature, headers_json, roles_json, date_format) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, roles_json = excluded.roles_json, date_format = excluded.date_format",
        params![id, name, sig, serde_json::to_string(headers)?, serde_json::to_string(roles)?, date_format],
    )?;
    get(conn, &id)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Pattern> {
    conn.query_row(&format!("SELECT {COLS} FROM report_patterns WHERE id = ?1"), [id], row_to_pattern)
        .optional()?
        .ok_or_else(|| AppError::new("not_found", "ไม่พบรูปแบบรีพอร์ต"))
}

pub fn update(conn: &Connection, id: &str, name: Option<&str>, roles: Option<&RoleMap>) -> AppResult<Pattern> {
    let p = get(conn, id)?;
    save(conn, name.unwrap_or(&p.name), &p.headers, roles.unwrap_or(&p.roles), p.date_format.as_deref())
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM report_patterns WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn signature_ignores_case_and_spaces_but_not_order() {
        let a = header_signature(&h(&["เลขอินซิเดนต์", " Service "]));
        assert_eq!(a, header_signature(&h(&["เลขอินซิเดนต์", "service"])));
        assert_ne!(a, header_signature(&h(&["service", "เลขอินซิเดนต์"])));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn roles_round_trip_and_patterns_are_found_again() {
        let dir = tempfile::tempdir().unwrap();
        let c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        let headers = h(&["เลข", "วันที่", "เซอร์วิส", "หัวข้อ", "รายละเอียด", "ช่องทาง"]);
        let roles = vec![Role::Ticket, Role::Date, Role::Service, Role::Problem, Role::Problem, Role::None];
        let map = RoleMap::from_roles(&headers, &roles);
        assert_eq!(map.problem, h(&["หัวข้อ", "รายละเอียด"]));
        assert_eq!(map.to_roles(&headers), roles);
        let p = save(&c, "รีพอร์ตรายเดือน", &headers, &map, Some("dmy")).unwrap();
        assert_eq!(find(&c, &h(&["เลข ", "วันที่", "เซอร์วิส", "หัวข้อ", "รายละเอียด", "ช่องทาง"])).unwrap().unwrap().id, p.id);
        // saving again with the same headers updates, never duplicates
        save(&c, "ชื่อใหม่", &headers, &map, Some("mdy")).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "ชื่อใหม่");
        assert_eq!(all[0].date_format.as_deref(), Some("mdy"));
        update(&c, &p.id, Some("X"), None).unwrap();
        delete(&c, &p.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
    }
}
