//! `.incask` project file (SPEC §10.2): a zip with `project.sqlite` (a `VACUUM INTO` copy cut to the
//! chosen months/service) and `manifest.json`. Opening one makes a new project, or merges it into an
//! existing one by ticket number.

use super::Scope;
use crate::errors::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const FORMAT: &str = "incask";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub from: String,
    pub to: String,
    pub service: Option<String>,
    pub project_name: String,
    pub project_color: String,
    pub schema_version: i64,
    pub tickets: usize,
}

fn temp_file(ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!("incask-{}.{ext}", &uuid::Uuid::new_v4().simple().to_string()[..12]))
}

fn zip_err(e: impl std::fmt::Display) -> AppError {
    AppError::new("incask", format!("ไฟล์ .incask ไม่ถูกต้อง: {e}"))
}

pub fn export(conn: &Connection, scope: &Scope, project_name: &str, project_color: &str, app_version: &str, out: &Path) -> AppResult<Manifest> {
    let copy = temp_file("sqlite");
    conn.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])?;
    let result = (|| {
        let c = crate::db::open(&copy)?;
        let service = scope.service.clone().filter(|s| !s.is_empty());
        c.execute("DELETE FROM tickets WHERE NOT (month BETWEEN ?1 AND ?2)", params![scope.from, scope.to])?;
        if let Some(s) = &service {
            c.execute("DELETE FROM tickets WHERE service != ?1", [s])?;
            c.execute("DELETE FROM services WHERE name != ?1", [s])?;
        }
        c.execute("DELETE FROM imports WHERE id NOT IN (SELECT DISTINCT import_id FROM tickets)", [])?;
        // run history holds costs and usage — it stays on this PC
        c.execute("DELETE FROM runs", [])?;
        crate::db::set_meta(&c, "project_name", project_name)?;
        crate::db::set_meta(&c, "project_color", project_color)?;
        let tickets: i64 = c.query_row("SELECT COUNT(*) FROM tickets", [], |r| r.get(0))?;
        let schema_version = crate::db::migrate::current_version(&c)?;
        let exported_at: String = c.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| r.get(0))?;
        c.execute_batch("PRAGMA journal_mode=DELETE; VACUUM;")?;
        drop(c);
        let manifest = Manifest {
            format: FORMAT.into(),
            version: VERSION,
            exported_at,
            app_version: app_version.into(),
            from: scope.from.clone(),
            to: scope.to.clone(),
            service,
            project_name: project_name.into(),
            project_color: project_color.into(),
            schema_version,
            tickets: tickets as usize,
        };
        let file = std::fs::File::create(out)?;
        let mut z = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        z.start_file("manifest.json", opt).map_err(zip_err)?;
        z.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        z.start_file("project.sqlite", opt).map_err(zip_err)?;
        z.write_all(&std::fs::read(&copy)?)?;
        z.finish().map_err(zip_err)?;
        Ok(manifest)
    })();
    let _ = std::fs::remove_file(&copy);
    result
}

/// Unzip to a temporary `.sqlite` (caller removes it), checking the manifest and the schema.
pub fn extract(path: &Path) -> AppResult<(Manifest, PathBuf)> {
    let file = std::fs::File::open(path)?;
    let mut z = zip::ZipArchive::new(file).map_err(zip_err)?;
    let manifest: Manifest = {
        let mut f = z.by_name("manifest.json").map_err(zip_err)?;
        let mut s = String::new();
        f.read_to_string(&mut s)?;
        serde_json::from_str(&s).map_err(zip_err)?
    };
    if manifest.format != FORMAT {
        return Err(AppError::new("incask", "ไม่ใช่ไฟล์โปรเจกต์ IncAsk"));
    }
    if manifest.version > VERSION || manifest.schema_version > crate::db::migrate::SCHEMA_VERSION {
        return Err(AppError::new("incask", "ไฟล์นี้มาจาก IncAsk รุ่นใหม่กว่า — อัปเดตโปรแกรมก่อนเปิด"));
    }
    let tmp = temp_file("sqlite");
    {
        let mut f = z.by_name("project.sqlite").map_err(zip_err)?;
        let mut out = std::fs::File::create(&tmp)?;
        std::io::copy(&mut f, &mut out)?;
    }
    // opening migrates an older schema and proves the file is a real database
    if let Err(e) = crate::db::open(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok((manifest, tmp))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspect {
    pub manifest: Manifest,
    pub tickets: usize,
    pub months: Vec<String>,
    pub services: Vec<String>,
    /// tickets whose number already exists in the target project
    pub conflicts: usize,
}

pub fn inspect(path: &Path, target: Option<&Connection>) -> AppResult<Inspect> {
    let (manifest, tmp) = extract(path)?;
    let r = (|| {
        let c = Connection::open(&tmp)?;
        let tickets: i64 = c.query_row("SELECT COUNT(*) FROM tickets", [], |r| r.get(0))?;
        let months = crate::taxonomy::project_months(&c)?;
        let services = crate::taxonomy::list_services(&c)?.into_iter().map(|s| s.name).collect();
        let mut conflicts = 0;
        if let Some(t) = target {
            let mut st = c.prepare("SELECT ticket_no FROM tickets")?;
            let nos: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            let mut q = t.prepare_cached("SELECT 1 FROM tickets WHERE ticket_no = ?1")?;
            for n in nos {
                if q.exists([n])? {
                    conflicts += 1;
                }
            }
        }
        Ok(Inspect { manifest: manifest.clone(), tickets: tickets as usize, months, services, conflicts })
    })();
    let _ = std::fs::remove_file(&tmp);
    r
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub added: usize,
    pub replaced: usize,
    pub kept: usize,
    pub services_added: usize,
}

/// Merge into `target` by ticket number. On a clash, `take_theirs` replaces our ticket (and its
/// classification) with the file's; otherwise ours stays. New services come with their categories;
/// a service both sides have keeps our categories.
pub fn merge(target: &mut Connection, path: &Path, take_theirs: bool) -> AppResult<MergeResult> {
    let (_, tmp) = extract(path)?;
    let r = (|| {
        target.execute("ATTACH DATABASE ?1 AS src", [tmp.to_string_lossy().as_ref()])?;
        let res = (|| {
            let tx = target.transaction()?;
            let new_services: Vec<String> = {
                let mut st = tx.prepare("SELECT id FROM src.services WHERE name NOT IN (SELECT name FROM main.services)")?;
                let v = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
                v
            };
            for id in &new_services {
                tx.execute("INSERT OR IGNORE INTO main.services SELECT * FROM src.services WHERE id = ?1", [id])?;
                tx.execute("INSERT OR IGNORE INTO main.taxonomy_rows SELECT * FROM src.taxonomy_rows WHERE service_id = ?1", [id])?;
            }
            tx.execute("INSERT OR IGNORE INTO main.report_patterns SELECT * FROM src.report_patterns WHERE header_signature NOT IN (SELECT header_signature FROM main.report_patterns)", [])?;
            tx.execute("INSERT OR IGNORE INTO main.saved_views SELECT * FROM src.saved_views WHERE name NOT IN (SELECT name FROM main.saved_views)", [])?;
            tx.execute("INSERT OR IGNORE INTO main.imports SELECT * FROM src.imports", [])?;
            tx.execute("INSERT OR IGNORE INTO main.cache SELECT * FROM src.cache", [])?;
            let clash: i64 = tx.query_row("SELECT COUNT(*) FROM src.tickets WHERE ticket_no IN (SELECT ticket_no FROM main.tickets)", [], |r| r.get(0))?;
            let total: i64 = tx.query_row("SELECT COUNT(*) FROM src.tickets", [], |r| r.get(0))?;
            if take_theirs {
                tx.execute("DELETE FROM main.tickets WHERE ticket_no IN (SELECT ticket_no FROM src.tickets)", [])?;
            }
            tx.execute("CREATE TEMP TABLE merged AS SELECT id FROM src.tickets WHERE ticket_no NOT IN (SELECT ticket_no FROM main.tickets)", [])?;
            tx.execute("INSERT OR IGNORE INTO main.tickets SELECT * FROM src.tickets WHERE id IN (SELECT id FROM temp.merged)", [])?;
            tx.execute("INSERT OR IGNORE INTO main.classifications SELECT * FROM src.classifications WHERE ticket_id IN (SELECT id FROM temp.merged)", [])?;
            tx.execute("DROP TABLE temp.merged", [])?;
            tx.commit()?;
            Ok(MergeResult {
                added: (total - clash) as usize,
                replaced: if take_theirs { clash as usize } else { 0 },
                kept: if take_theirs { 0 } else { clash as usize },
                services_added: new_services.len(),
            })
        })();
        let _ = target.execute("DETACH DATABASE src", []);
        res
    })();
    let _ = std::fs::remove_file(&tmp);
    r
}

/// Copy the file's database in as a brand-new project (see `Registry::adopt`).
pub fn import_new(reg: &mut crate::db::projects::Registry, path: &Path, name: Option<&str>) -> AppResult<crate::db::projects::Project> {
    let (m, tmp) = extract(path)?;
    let r = reg.adopt(&tmp, name.unwrap_or(&m.project_name), &m.project_color);
    let _ = std::fs::remove_file(&tmp);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::projects::Registry;
    use crate::export::testdata;

    fn count(c: &Connection, sql: &str) -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn exports_and_imports_back_everything_in_scope() {
        let dir = tempfile::tempdir().unwrap();
        let (_p, c) = testdata::project(dir.path(), "Call Center A");
        c.execute("INSERT INTO runs(id, cost) VALUES('r1', 4.2)", []).unwrap();
        let out = dir.path().join("a.incask");
        let all = Scope { from: "2026-01".into(), to: "2026-12".into(), service: None };
        let m = export(&c, &all, "Call Center A", "#217346", "0.1.0", &out).unwrap();
        assert_eq!((m.format.as_str(), m.tickets, m.schema_version), ("incask", 3, 1));

        let reg_dir = dir.path().join("projects");
        let mut reg = Registry::load(&reg_dir).unwrap();
        reg.create("Call Center A", None).unwrap(); // same name already here → renamed on import
        let p = import_new(&mut reg, &out, None).unwrap();
        assert_ne!(p.name, "Call Center A");
        assert!(p.name.starts_with("Call Center A"));
        assert_eq!(p.color, "#217346");
        let n = crate::db::open(&reg.db_path(&p.id).unwrap()).unwrap();
        assert_eq!(count(&n, "SELECT COUNT(*) FROM tickets"), 3);
        assert_eq!(count(&n, "SELECT COUNT(*) FROM classifications"), 2);
        assert_eq!(count(&n, "SELECT COUNT(*) FROM services"), 2);
        assert_eq!(count(&n, "SELECT COUNT(*) FROM taxonomy_rows"), 1);
        assert_eq!(count(&n, "SELECT COUNT(*) FROM saved_views"), 1);
        assert_eq!(count(&n, "SELECT COUNT(*) FROM runs"), 0); // costs stay home
        let src: String = n.query_row("SELECT source_json FROM tickets WHERE ticket_no='INC1'", [], |r| r.get(0)).unwrap();
        assert!(src.contains("ช่องทาง"));
        // a month/service slice
        let out2 = dir.path().join("b.incask");
        let m2 = export(&c, &Scope { from: "2026-10".into(), to: "2026-10".into(), service: Some("Internet".into()) }, "A", "#217346", "0.1.0", &out2).unwrap();
        assert_eq!(m2.tickets, 1);
        assert_eq!(inspect(&out2, None).unwrap().services, vec!["Internet"]);
    }

    #[test]
    fn merge_adds_new_and_resolves_clashes_either_way() {
        let dir = tempfile::tempdir().unwrap();
        let (_p, src) = testdata::project(dir.path(), "theirs");
        src.execute("INSERT INTO services(id,name,color,columns_json,sort) VALUES('s9','Mobile','#C2631A','[\"หัวข้อหลัก\"]',9)", []).unwrap();
        src.execute("INSERT INTO tickets(id,ticket_no,date,month,service,problem_text,source_json,import_id) VALUES('k9','INC9','2026-10-09','2026-10','Mobile','สัญญาณอ่อน','{}','im1')", []).unwrap();
        src.execute("UPDATE classifications SET fields_json='{\"หัวข้อหลัก\":\"ของเขา\"}' WHERE ticket_id='k2'", []).unwrap();
        let file = dir.path().join("t.incask");
        export(&src, &Scope { from: "2026-01".into(), to: "2026-12".into(), service: None }, "theirs", "#B4530A", "0.1.0", &file).unwrap();

        for take_theirs in [false, true] {
            let sub = dir.path().join(format!("m{take_theirs}"));
            std::fs::create_dir_all(&sub).unwrap();
            let (_q, mut mine) = testdata::project(&sub, "mine");
            mine.execute("DELETE FROM tickets WHERE ticket_no='INC3'", []).unwrap();
            assert_eq!(inspect(&file, Some(&mine)).unwrap().conflicts, 2);
            let r = merge(&mut mine, &file, take_theirs).unwrap();
            assert_eq!(r.added, 2); // INC3 + INC9
            assert_eq!(r.services_added, 1);
            assert_eq!((r.replaced, r.kept), if take_theirs { (2, 0) } else { (0, 2) });
            assert_eq!(count(&mine, "SELECT COUNT(*) FROM tickets"), 4);
            let f: String = mine.query_row("SELECT c.fields_json FROM classifications c JOIN tickets t ON t.id=c.ticket_id WHERE t.ticket_no='INC2'", [], |r| r.get(0)).unwrap();
            assert_eq!(f.contains("ของเขา"), take_theirs);
            assert_eq!(count(&mine, "SELECT COUNT(*) FROM saved_views"), 1); // same name → not duplicated
        }
    }

    #[test]
    fn rejects_files_that_are_not_incask() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.incask");
        std::fs::write(&p, b"not a zip").unwrap();
        assert_eq!(inspect(&p, None).unwrap_err().code, "incask");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        z.start_file("manifest.json", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(br#"{"format":"other","version":1,"exportedAt":"","appVersion":"","from":"","to":"","service":null,"projectName":"","projectColor":"","schemaVersion":1,"tickets":0}"#).unwrap();
        z.finish().unwrap();
        assert!(inspect(&p, None).unwrap_err().message.contains("ไม่ใช่ไฟล์โปรเจกต์"));
    }
}
