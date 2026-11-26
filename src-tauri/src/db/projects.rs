//! Project registry: `projects/index.json` (id, name, colour, order) + one `<id>.sqlite` per project.
//! The project's name and colour are also kept in its own `meta` table, so a lost or damaged
//! index.json is rebuilt from the files on the next start.

use crate::config::{read_json, write_json};
use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_NAME: usize = 60;
/// default project colours: the accent green + the service palette (SPEC §11.2)
pub const PROJECT_COLORS: [&str; 8] = ["#217346", "#B4530A", "#4A5A7A", "#2F6FB0", "#7B4FB0", "#0E7C74", "#B83E78", "#8A6D1F"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct IndexFile {
    projects: Vec<Project>,
}

pub struct Registry {
    root: PathBuf,
    items: Vec<Project>,
}

/// Ids are generated here (`p-` + 12 hex). Anything else is refused before it touches a path.
pub fn valid_id(id: &str) -> bool {
    id.len() == 14 && id.starts_with("p-") && id[2..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

fn clean_name(name: &str) -> AppResult<String> {
    let n = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if n.is_empty() {
        return Err(AppError::new("invalid_name", "ใส่ชื่อโปรเจกต์ก่อน"));
    }
    if n.chars().count() > MAX_NAME {
        return Err(AppError::new("invalid_name", format!("ชื่อโปรเจกต์ยาวได้ไม่เกิน {MAX_NAME} ตัวอักษร")));
    }
    Ok(n)
}

impl Registry {
    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    pub fn db_path(&self, id: &str) -> AppResult<PathBuf> {
        if !valid_id(id) {
            return Err(AppError::new("not_found", "ไม่พบโปรเจกต์"));
        }
        Ok(self.root.join(format!("{id}.sqlite")))
    }

    /// Read index.json, add projects whose .sqlite exists but is missing from the index (from
    /// their `meta`), drop entries whose file is gone.
    pub fn load(root: &Path) -> AppResult<Registry> {
        std::fs::create_dir_all(root)?;
        let index: IndexFile = read_json(&root.join("index.json")).ok().flatten().unwrap_or_default();
        let mut reg = Registry { root: root.to_path_buf(), items: Vec::new() };
        let mut changed = false;
        for p in index.projects {
            if valid_id(&p.id) && reg.db_path(&p.id)?.is_file() && !reg.items.iter().any(|x| x.id == p.id) {
                reg.items.push(p);
            } else {
                changed = true;
            }
        }
        let mut found: Vec<String> = std::fs::read_dir(root)?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".sqlite")).map(str::to_string))
            .filter(|id| valid_id(id) && !reg.items.iter().any(|p| &p.id == id))
            .collect();
        found.sort();
        for id in found {
            let conn = super::open(&reg.db_path(&id)?)?;
            let name = super::get_meta(&conn, "project_name")?.unwrap_or_else(|| id.clone());
            let color = super::get_meta(&conn, "project_color")?.filter(|c| valid_color(c)).unwrap_or_else(|| PROJECT_COLORS[0].into());
            let sort = reg.items.iter().map(|p| p.sort + 1).max().unwrap_or(0);
            reg.items.push(Project { id, name, color, sort });
            changed = true;
        }
        reg.items.sort_by_key(|p| p.sort);
        if changed {
            reg.save()?;
        }
        Ok(reg)
    }

    fn save(&self) -> AppResult<()> {
        write_json(&self.index_path(), &IndexFile { projects: self.items.clone() })
    }

    pub fn list(&self) -> Vec<Project> {
        self.items.clone()
    }

    pub fn get(&self, id: &str) -> AppResult<Project> {
        self.items.iter().find(|p| p.id == id).cloned().ok_or_else(|| AppError::new("not_found", "ไม่พบโปรเจกต์"))
    }

    fn check_unique(&self, name: &str, except: Option<&str>) -> AppResult<()> {
        let lower = name.to_lowercase();
        if self.items.iter().any(|p| Some(p.id.as_str()) != except && p.name.to_lowercase() == lower) {
            return Err(AppError::new("duplicate_name", format!("มีโปรเจกต์ชื่อ \"{name}\" อยู่แล้ว")));
        }
        Ok(())
    }

    pub fn create(&mut self, name: &str, color: Option<&str>) -> AppResult<Project> {
        let name = clean_name(name)?;
        self.check_unique(&name, None)?;
        let color = match color {
            Some(c) if valid_color(c) => c.to_uppercase(),
            Some(_) => return Err(AppError::new("invalid_color", "สีไม่ถูกต้อง")),
            None => PROJECT_COLORS[self.items.len() % PROJECT_COLORS.len()].into(),
        };
        let id = format!("p-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let conn = super::open(&self.db_path(&id)?)?;
        super::set_meta(&conn, "project_name", &name)?;
        super::set_meta(&conn, "project_color", &color)?;
        drop(conn);
        let p = Project { id, name, color, sort: self.items.iter().map(|p| p.sort + 1).max().unwrap_or(0) };
        self.items.push(p.clone());
        self.save()?;
        Ok(p)
    }

    pub fn update(&mut self, id: &str, name: Option<&str>, color: Option<&str>) -> AppResult<Project> {
        let mut p = self.get(id)?;
        if let Some(n) = name {
            let n = clean_name(n)?;
            self.check_unique(&n, Some(id))?;
            p.name = n;
        }
        if let Some(c) = color {
            if !valid_color(c) {
                return Err(AppError::new("invalid_color", "สีไม่ถูกต้อง"));
            }
            p.color = c.to_uppercase();
        }
        let conn = super::open(&self.db_path(id)?)?;
        super::set_meta(&conn, "project_name", &p.name)?;
        super::set_meta(&conn, "project_color", &p.color)?;
        drop(conn);
        if let Some(slot) = self.items.iter_mut().find(|x| x.id == id) {
            *slot = p.clone();
        }
        self.save()?;
        Ok(p)
    }

    /// Removes the project and its database (plus WAL/SHM side files). Cannot be undone.
    pub fn delete(&mut self, id: &str) -> AppResult<()> {
        self.get(id)?;
        let db = self.db_path(id)?;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let f = PathBuf::from(format!("{}{suffix}", db.display()));
            match std::fs::remove_file(&f) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(AppError::new("io", format!("ลบไฟล์โปรเจกต์ไม่ได้ (ปิดโปรแกรมอื่นที่เปิดไฟล์อยู่แล้วลองใหม่): {e}"))),
            }
        }
        self.items.retain(|p| p.id != id);
        self.save()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_list_rename_delete_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        let a = r.create("  Call   Center A ", None).unwrap();
        let b = r.create("NOC Incident", Some("#4a5a7a")).unwrap();
        assert_eq!(a.name, "Call Center A");
        assert_eq!(b.color, "#4A5A7A");
        assert!(valid_id(&a.id));
        assert!(dir.path().join(format!("{}.sqlite", a.id)).is_file());

        // survives a reload, in order
        let mut r = Registry::load(dir.path()).unwrap();
        assert_eq!(r.list().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["Call Center A", "NOC Incident"]);

        r.update(&a.id, Some("Call Center A1"), Some("#2F6FB0")).unwrap();
        r.delete(&b.id).unwrap();
        assert!(!dir.path().join(format!("{}.sqlite", b.id)).exists());
        assert!(!dir.path().join(format!("{}.sqlite-wal", b.id)).exists());

        let r = Registry::load(dir.path()).unwrap();
        assert_eq!(r.list().len(), 1);
        assert_eq!(r.list()[0].name, "Call Center A1");
        assert_eq!(r.list()[0].color, "#2F6FB0");
    }

    #[test]
    fn names_must_be_present_short_and_unique() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        assert_eq!(r.create("   ", None).unwrap_err().code, "invalid_name");
        assert_eq!(r.create(&"ก".repeat(61), None).unwrap_err().code, "invalid_name");
        let a = r.create("Call Center A", None).unwrap();
        assert_eq!(r.create("call center a", None).unwrap_err().code, "duplicate_name");
        r.create("B", None).unwrap();
        assert_eq!(r.update(&a.id, Some("b"), None).unwrap_err().code, "duplicate_name");
        // renaming to its own name (other case) is fine
        assert!(r.update(&a.id, Some("CALL CENTER A"), None).is_ok());
        assert_eq!(r.create("C", Some("green")).unwrap_err().code, "invalid_color");
    }

    #[test]
    fn ids_cannot_escape_the_projects_folder() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        for bad in ["../app", "..\\..\\x", "p-../../evil", "p-ABCDEF123456", "index", ""] {
            assert!(r.db_path(bad).is_err(), "{bad}");
            assert!(r.delete(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn lost_index_is_rebuilt_from_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        let a = r.create("Call Center A", Some("#B4530A")).unwrap();
        std::fs::remove_file(dir.path().join("index.json")).unwrap();
        // stray files that are not projects are ignored
        std::fs::write(dir.path().join("notes.sqlite"), b"x").unwrap();
        let r = Registry::load(dir.path()).unwrap();
        assert_eq!(r.list(), vec![Project { id: a.id, name: "Call Center A".into(), color: "#B4530A".into(), sort: 0 }]);
    }

    #[test]
    fn index_entries_without_a_file_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(dir.path()).unwrap();
        let a = r.create("A", None).unwrap();
        std::fs::remove_file(dir.path().join(format!("{}.sqlite", a.id))).unwrap();
        assert!(Registry::load(dir.path()).unwrap().list().is_empty());
    }
}
