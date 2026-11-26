//! Config backup / import (SPEC §12): `incask-config.json` with each project's services, category
//! columns, categories, colours, report patterns and saved views. Never the key, the Gateway URL,
//! tickets or results. Import shows a diff first, then applies it.

use crate::db::projects::Registry;
use crate::errors::{AppError, AppResult};
use crate::ingest::patterns::{self, RoleMap};
use crate::taxonomy::{self, ColumnSpec, RowInput, Values};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FORMAT: &str = "incask-config";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CatRow {
    pub values: Values,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub examples: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServiceConf {
    pub name: String,
    pub color: String,
    pub columns: Vec<String>,
    pub categories: Vec<CatRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PatternConf {
    pub name: String,
    pub headers: Vec<String>,
    pub roles: RoleMap,
    pub date_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ViewConf {
    pub name: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectConf {
    pub name: String,
    pub color: String,
    pub services: Vec<ServiceConf>,
    #[serde(default)]
    pub patterns: Vec<PatternConf>,
    #[serde(default)]
    pub views: Vec<ViewConf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub projects: Vec<ProjectConf>,
}

fn project_conf(conn: &Connection, name: &str, color: &str) -> AppResult<ProjectConf> {
    let mut services = vec![];
    for s in taxonomy::list_services(conn)? {
        let categories = taxonomy::list_taxonomy(conn, &s.id)?.into_iter().map(|r| CatRow { values: r.values, description: r.description, examples: r.examples }).collect();
        services.push(ServiceConf { name: s.name, color: s.color, columns: s.columns, categories });
    }
    let patterns = patterns::list(conn)?.into_iter().map(|p| PatternConf { name: p.name, headers: p.headers, roles: p.roles, date_format: p.date_format }).collect();
    let views = crate::pivot::list_views(conn)?.into_iter().map(|v| ViewConf { name: v.name, config: v.config }).collect();
    Ok(ProjectConf { name: name.into(), color: color.into(), services, patterns, views })
}

/// `only` = project ids to include (None = every project).
pub fn export(reg: &Registry, only: Option<&[String]>, out: &Path) -> AppResult<usize> {
    let mut projects = vec![];
    for p in reg.list() {
        if only.is_some_and(|ids| !ids.contains(&p.id)) {
            continue;
        }
        let conn = crate::db::open(&reg.db_path(&p.id)?)?;
        projects.push(project_conf(&conn, &p.name, &p.color)?);
    }
    let exported_at = Connection::open_in_memory()?.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| r.get(0))?;
    let file = ConfigFile { format: FORMAT.into(), version: 1, exported_at, projects };
    crate::config::write_json(out, &file)?;
    Ok(file.projects.len())
}

pub fn read(path: &Path) -> AppResult<ConfigFile> {
    let f: ConfigFile = crate::config::read_json(path)?.ok_or_else(|| AppError::new("not_found", "ไม่พบไฟล์"))?;
    if f.format != FORMAT {
        return Err(AppError::new("config_file", "ไม่ใช่ไฟล์คอนฟิกของ IncAsk"));
    }
    if f.version > 1 {
        return Err(AppError::new("config_file", "ไฟล์คอนฟิกมาจาก IncAsk รุ่นใหม่กว่า — อัปเดตโปรแกรมก่อน"));
    }
    Ok(f)
}

// ---------------------------------------------------------------- diff / apply

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiff {
    pub name: String,
    /// the project doesn't exist here yet → it will be created
    pub new_project: bool,
    pub services_added: usize,
    pub services_changed: usize,
    pub categories_added: usize,
    pub categories_changed: usize,
    pub categories_removed: usize,
    /// tickets that lose their category because a category they use is removed (classified again later)
    pub tickets_affected: usize,
    pub patterns_added: usize,
    pub patterns_changed: usize,
    pub views_added: usize,
    pub views_changed: usize,
}

impl ProjectDiff {
    pub fn is_empty(&self) -> bool {
        !self.new_project
            && self.services_added + self.services_changed + self.categories_added + self.categories_changed + self.categories_removed + self.patterns_added + self.patterns_changed + self.views_added + self.views_changed
                == 0
    }
}

fn same_values(a: &Values, b: &Values, cols: &[String]) -> bool {
    cols.iter().all(|c| a.get(c).map(|s| s.trim()).unwrap_or("") == b.get(c).map(|s| s.trim()).unwrap_or(""))
}

/// Compare one project's config with what's in `conn` (or with nothing, for a new project);
/// `apply` makes the changes as it goes.
fn sync(conn: Option<&mut Connection>, pc: &ProjectConf, apply: bool) -> AppResult<ProjectDiff> {
    let mut d = ProjectDiff { name: pc.name.clone(), new_project: conn.is_none(), ..Default::default() };
    let Some(conn) = conn else {
        d.services_added = pc.services.len();
        d.categories_added = pc.services.iter().map(|s| s.categories.len()).sum();
        d.patterns_added = pc.patterns.len();
        d.views_added = pc.views.len();
        return Ok(d);
    };
    for sc in &pc.services {
        let existing = taxonomy::find_service_by_name(conn, &sc.name)?;
        let svc = match existing {
            None => {
                d.services_added += 1;
                d.categories_added += sc.categories.len();
                if !apply {
                    continue;
                }
                taxonomy::create_service(conn, &sc.name, Some(&sc.color), &sc.columns)?
            }
            Some(s) => {
                if s.color.to_uppercase() != sc.color.to_uppercase() || s.columns != sc.columns {
                    d.services_changed += 1;
                    if apply {
                        if s.color.to_uppercase() != sc.color.to_uppercase() {
                            taxonomy::update_service(conn, &s.id, None, Some(&sc.color))?;
                        }
                        if s.columns != sc.columns {
                            let specs: Vec<ColumnSpec> = sc.columns.iter().map(|c| ColumnSpec { from: s.columns.contains(c).then(|| c.clone()), name: c.clone() }).collect();
                            taxonomy::set_columns(conn, &s.id, &specs)?;
                        }
                    }
                }
                if apply { taxonomy::get_service(conn, &s.id)? } else { s }
            }
        };
        let cols = &sc.columns;
        let mine = taxonomy::list_taxonomy(conn, &svc.id)?;
        for cat in &sc.categories {
            match mine.iter().find(|m| same_values(&m.values, &cat.values, cols)) {
                None => {
                    d.categories_added += 1;
                    if apply {
                        taxonomy::save_row(conn, &svc.id, &RowInput { id: None, values: cat.values.clone(), description: cat.description.clone(), examples: cat.examples.clone() })?;
                    }
                }
                Some(m) if m.description.trim() != cat.description.trim() || m.examples.trim() != cat.examples.trim() => {
                    d.categories_changed += 1;
                    if apply {
                        taxonomy::save_row(conn, &svc.id, &RowInput { id: Some(m.id.clone()), values: m.values.clone(), description: cat.description.clone(), examples: cat.examples.clone() })?;
                    }
                }
                Some(_) => {}
            }
        }
        for m in mine.iter().filter(|m| !sc.categories.iter().any(|c| same_values(&m.values, &c.values, cols))) {
            d.categories_removed += 1;
            d.tickets_affected += taxonomy::row_usage(conn, &m.id)?.len();
            if apply {
                taxonomy::delete_row(conn, &m.id, None)?;
            }
        }
    }
    let my_patterns = patterns::list(conn)?;
    for p in &pc.patterns {
        match my_patterns.iter().find(|m| patterns::header_signature(&m.headers) == patterns::header_signature(&p.headers)) {
            None => d.patterns_added += 1,
            Some(m) if m.name != p.name || m.roles != p.roles || m.date_format != p.date_format => d.patterns_changed += 1,
            Some(_) => continue,
        }
        if apply {
            patterns::save(conn, &p.name, &p.headers, &p.roles, p.date_format.as_deref())?;
        }
    }
    let my_views = crate::pivot::list_views(conn)?;
    for v in &pc.views {
        let existing = my_views.iter().find(|m| m.name == v.name);
        match existing {
            None => d.views_added += 1,
            Some(m) if m.config != v.config => d.views_changed += 1,
            Some(_) => continue,
        }
        if apply {
            crate::pivot::save_view(conn, existing.map(|m| m.id.as_str()), &v.name, &v.config)?;
        }
    }
    Ok(d)
}

fn find_project(reg: &Registry, name: &str) -> Option<String> {
    reg.list().into_iter().find(|p| p.name.eq_ignore_ascii_case(name.trim())).map(|p| p.id)
}

pub fn diff(reg: &Registry, file: &ConfigFile) -> AppResult<Vec<ProjectDiff>> {
    let mut out = vec![];
    for pc in &file.projects {
        let mut conn = match find_project(reg, &pc.name) {
            Some(id) => Some(crate::db::open(&reg.db_path(&id)?)?),
            None => None,
        };
        out.push(sync(conn.as_mut(), pc, false)?);
    }
    Ok(out)
}

/// Projects are matched by name; missing ones are created. Services in the file are added or
/// updated and their categories made to match the file. Services, patterns and views that only
/// exist here are left alone.
pub fn apply(reg: &mut Registry, file: &ConfigFile) -> AppResult<Vec<ProjectDiff>> {
    let mut out = vec![];
    for pc in &file.projects {
        let (id, created) = match find_project(reg, &pc.name) {
            Some(id) => (id, false),
            None => (reg.create(&pc.name, Some(&pc.color))?.id, true),
        };
        let mut conn = crate::db::open(&reg.db_path(&id)?)?;
        let mut d = sync(Some(&mut conn), pc, true)?;
        d.new_project = created;
        out.push(d);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Registry, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut reg = Registry::load(&dir.path().join("projects")).unwrap();
        let p = reg.create("Call Center A", Some("#217346")).unwrap();
        let src = dir.path().join("seed");
        std::fs::create_dir_all(&src).unwrap();
        let (seed_path, seed) = crate::export::testdata::project(&src, "seed");
        drop(seed);
        std::fs::copy(&seed_path, reg.db_path(&p.id).unwrap()).unwrap();
        (dir, reg, p.id)
    }

    #[test]
    fn exported_config_has_no_secrets_tickets_or_results() {
        let (dir, reg, _) = setup();
        let out = dir.path().join("incask-config.json");
        assert_eq!(export(&reg, None, &out).unwrap(), 1);
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(!regex::Regex::new(r"sk-[A-Za-z0-9]{6,}").unwrap().is_match(&text));
        for banned in ["INC1", "apiKey", "agent-gateway", "classifications", "confidence", "ปัญหา\" INC"] {
            assert!(!text.contains(banned), "{banned}");
        }
        let f = read(&out).unwrap();
        assert_eq!(f.projects[0].services.len(), 2);
        assert_eq!(f.projects[0].services[0].categories[0].description, "หลุดเป็นช่วง");
        assert_eq!(f.projects[0].views[0].name, "รายงานประจำเดือน");
    }

    #[test]
    fn import_shows_a_diff_then_applies_it() {
        let (dir, mut reg, id) = setup();
        let out = dir.path().join("c.json");
        export(&reg, Some(std::slice::from_ref(&id)), &out).unwrap();
        let mut f = read(&out).unwrap();
        // nothing differs yet
        assert!(diff(&reg, &f).unwrap()[0].is_empty());
        // edit the file: change a description, add a category, drop one (in use), add a service + new project
        let net = &mut f.projects[0].services[0];
        net.categories[0].description = "ใหม่".into();
        net.categories.push(CatRow { values: crate::export::testdata::vals("ความเร็ว", "เน็ตช้า"), description: "ช้า".into(), examples: String::new() });
        let removed = net.categories.remove(0);
        net.categories.insert(0, CatRow { description: "ใหม่".into(), ..removed });
        f.projects[0].services[1].categories = vec![];
        f.projects[0].services.push(ServiceConf { name: "Mobile".into(), color: "#C2631A".into(), columns: vec!["หัวข้อหลัก".into()], categories: vec![CatRow { values: [("หัวข้อหลัก".to_string(), "สัญญาณ".to_string())].into_iter().collect(), description: String::new(), examples: String::new() }] });
        f.projects.push(ProjectConf { name: "NOC Incident".into(), color: "#4A5A7A".into(), services: vec![], patterns: vec![], views: vec![] });
        // remove the only Internet category from the file → its 2 classified tickets are affected
        let mut g = f.clone();
        g.projects[0].services[0].categories.retain(|c| c.values.get("หัวข้อย่อย").map(|s| s.as_str()) != Some("เน็ตหลุด"));
        let d = diff(&reg, &g).unwrap();
        assert_eq!((d[0].services_added, d[0].categories_added, d[0].categories_removed, d[0].tickets_affected), (1, 2, 1, 2));
        assert!(d[1].new_project);
        let d = diff(&reg, &f).unwrap();
        assert_eq!((d[0].categories_changed, d[0].categories_added, d[0].categories_removed), (1, 2, 0));
        apply(&mut reg, &f).unwrap();
        assert!(diff(&reg, &f).unwrap().iter().all(|x| x.is_empty()));
        assert_eq!(reg.list().len(), 2);
        let c = crate::db::open(&reg.db_path(&id).unwrap()).unwrap();
        assert_eq!(taxonomy::list_services(&c).unwrap().len(), 3);
    }

    #[test]
    fn rejects_other_json() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.json");
        std::fs::write(&p, r#"{"format":"something","version":1,"exportedAt":"","projects":[]}"#).unwrap();
        assert_eq!(read(&p).unwrap_err().code, "config_file");
    }
}
