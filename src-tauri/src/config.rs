//! Paths and app settings (`%APPDATA%\IncAsk\app.json`). No secrets in any file.
//! Ported from DocAsk (config.rs): data_dir/read_json/write_json, gateway URL rules and the
//! default model list. DocAsk's models.json/VS Code import, embedding and chat options are dropped;
//! IncAsk keeps the Gateway URL inside app.json (SPEC §4.1).

use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const GROUP_NAME: &str = "Gosoft Agent Gateway";
pub const DEFAULT_GATEWAY_URL: &str = "https://agent-gateway.gosoft.co.th";
/// DocAsk SPEC §3 model list — used when the Gateway's `/v1/models` is empty or unreachable.
pub const MODEL_IDS: [&str; 6] = ["godev1", "godev2", "godev3", "gothink1", "gothink2", "gothink3"];
pub const CONCURRENCY_CHOICES: [u32; 3] = [4, 8, 16];

/// `%APPDATA%\IncAsk` (override with INCASK_DATA_DIR for tests/portable use).
pub fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("INCASK_DATA_DIR") {
        return PathBuf::from(p);
    }
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("IncAsk")
}

pub fn projects_dir() -> PathBuf {
    data_dir().join("projects")
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> AppResult<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Atomic write (tmp + rename) so a crash never leaves half a config file.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ---------------------------------------------------------------- settings

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "light" | "dark" | "system"
    pub theme: String,
    /// "looped" | "sarabun" | "plex" | "system"
    pub font: String,
    pub user_name: String,
    pub setup_done: bool,
    pub gateway_url: String,
    /// model used for classification
    pub model: String,
    /// parallel requests to the Gateway: 4 | 8 | 16
    pub concurrency: u32,
    /// tickets per LLM request (1–25)
    pub batch_size: u32,
    /// latest.json URL for in-app updates (empty = updates off; IT fills it in)
    pub update_url: String,
    pub auto_check_update: bool,
    pub sidebar_collapsed: bool,
    pub last_project_id: Option<String>,
    pub last_test_at: Option<i64>,
    pub last_test_ok: Option<bool>,
    /// the model the last connection test ran on
    pub last_test_model: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            font: "looped".into(),
            user_name: std::env::var("USERNAME").unwrap_or_default(),
            setup_done: false,
            gateway_url: DEFAULT_GATEWAY_URL.into(),
            model: MODEL_IDS[0].into(),
            concurrency: 8,
            batch_size: 10,
            update_url: crate::updater::DEFAULT_UPDATE_URL.to_string(),
            auto_check_update: true,
            sidebar_collapsed: false,
            last_project_id: None,
            last_test_at: None,
            last_test_ok: None,
            last_test_model: None,
        }
    }
}

impl Settings {
    pub fn path() -> PathBuf {
        data_dir().join("app.json")
    }
    pub fn load() -> Settings {
        read_json::<Settings>(&Self::path()).ok().flatten().unwrap_or_default().sanitize()
    }
    pub fn save(&self) -> AppResult<()> {
        write_json(&Self::path(), self)
    }
    pub fn gateway_base(&self) -> String {
        normalize_base(&self.gateway_url)
    }
    pub fn chat_url(&self) -> String {
        chat_url(&self.gateway_url)
    }
    pub fn sanitize(mut self) -> Self {
        if !matches!(self.theme.as_str(), "light" | "dark" | "system") {
            self.theme = "system".into();
        }
        if !matches!(self.font.as_str(), "looped" | "sarabun" | "plex" | "system") {
            self.font = "looped".into();
        }
        if !CONCURRENCY_CHOICES.contains(&self.concurrency) {
            self.concurrency = 8;
        }
        self.batch_size = self.batch_size.clamp(1, 25);
        self.user_name = self.user_name.trim().chars().take(60).collect();
        self.model = self.model.trim().to_string();
        if self.model.is_empty() {
            self.model = MODEL_IDS[0].into();
        }
        match validate_gateway_url(&self.gateway_url) {
            Ok(u) => self.gateway_url = u,
            Err(_) => self.gateway_url = DEFAULT_GATEWAY_URL.into(),
        }
        self.update_url = self.update_url.trim().to_string();
        if !self.update_url.is_empty() && !self.update_url.starts_with("https://") {
            self.update_url.clear();
        }
        // copies installed before the release URL was baked in still find updates
        if self.update_url.is_empty() {
            self.update_url = crate::updater::DEFAULT_UPDATE_URL.into();
        }
        self
    }
}

// ---------------------------------------------------------------- gateway

/// Accepts `https://host`, `https://host/` or `https://host/v1` and returns `https://host`.
pub fn normalize_base(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if u.ends_with("/v1") {
        u.truncate(u.len() - 3);
    }
    u
}

pub fn validate_gateway_url(url: &str) -> AppResult<String> {
    let u = normalize_base(url);
    let ok = u.starts_with("https://") && u.len() > "https://".len() && !u.contains(char::is_whitespace);
    if !ok {
        return Err(AppError::new("invalid_url", "Gateway URL ต้องขึ้นต้นด้วย https:// และไม่มีช่องว่าง"));
    }
    Ok(u)
}

pub fn chat_url(base: &str) -> String {
    format!("{}/v1/chat/completions", normalize_base(base))
}

/// What the frontend may know about the Gateway: never the key, only whether one is stored + last 4.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    pub group_name: String,
    pub url: String,
    pub default_url: String,
    pub has_key: bool,
    pub key_last4: Option<String>,
    pub model: String,
    pub last_test_at: Option<i64>,
    pub last_test_ok: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base() {
        assert_eq!(normalize_base("https://a.b/v1/"), "https://a.b");
        assert_eq!(chat_url("https://a.b/"), "https://a.b/v1/chat/completions");
        assert!(validate_gateway_url("http://a.b").is_err());
        assert!(validate_gateway_url("https://").is_err());
    }

    #[test]
    fn sanitize_clamps_values() {
        let s = Settings {
            theme: "neon".into(),
            font: "comic".into(),
            concurrency: 5,
            batch_size: 99,
            gateway_url: "ftp://x".into(),
            model: "  ".into(),
            update_url: "http://insecure".into(),
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(s.theme, "system");
        assert_eq!(s.font, "looped");
        assert_eq!(s.concurrency, 8);
        assert_eq!(s.batch_size, 25);
        assert_eq!(s.gateway_url, DEFAULT_GATEWAY_URL);
        assert_eq!(s.model, "godev1");
        assert_eq!(s.update_url, "");
    }

    #[test]
    fn settings_file_never_has_a_key_field() {
        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(!json.to_lowercase().contains("apikey"));
        assert!(!json.contains("sk-"));
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("app.json");
        let s = Settings { user_name: "ทดสอบ".into(), concurrency: 16, ..Settings::default() };
        write_json(&p, &s).unwrap();
        let back: Settings = read_json(&p).unwrap().unwrap();
        assert_eq!(back, s);
    }
}
