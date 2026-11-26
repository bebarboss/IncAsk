//! Services and their category tables (SPEC §7). Step 3: read-only listing; editing, Excel
//! import/validation, template and versioning arrive in step 4.

use crate::errors::AppResult;
use rusqlite::Connection;
use serde::Serialize;

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

pub fn list_services(conn: &Connection) -> AppResult<Vec<Service>> {
    let mut st = conn.prepare(
        "SELECT id, name, color, columns_json, taxonomy_version, COALESCE(sort, 0) FROM services ORDER BY sort, name",
    )?;
    let rows = st.query_map([], |r| {
        let cols: String = r.get(3)?;
        Ok(Service {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
            columns: serde_json::from_str(&cols).unwrap_or_default(),
            taxonomy_version: r.get(4)?,
            sort: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
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

    #[test]
    fn lists_services_in_order_with_columns() {
        let dir = tempfile::tempdir().unwrap();
        let c = crate::db::open(&dir.path().join("p.sqlite")).unwrap();
        assert!(list_services(&c).unwrap().is_empty());
        assert!(project_months(&c).unwrap().is_empty());
        c.execute("INSERT INTO services(id,name,color,columns_json,sort) VALUES('s2','IPTV','#7B4FB0','[\"หัวข้อหลัก\"]',1)", []).unwrap();
        c.execute("INSERT INTO services(id,name,color,columns_json,sort) VALUES('s1','Internet','#2F6FB0','[\"หัวข้อหลัก\",\"หัวข้อย่อย\"]',0)", []).unwrap();
        let s = list_services(&c).unwrap();
        assert_eq!(s.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["Internet", "IPTV"]);
        assert_eq!(s[0].columns, vec!["หัวข้อหลัก", "หัวข้อย่อย"]);
        assert_eq!(s[0].taxonomy_version, 1);
    }
}
