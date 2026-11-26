//! In-app updates via tauri-plugin-updater (ported from DocAsk).
//! The update URL comes from Settings (`updateUrl`), defaulting to INCASK_UPDATE_URL at build time.
//! Endpoint and pubkey ship empty — IT fills them in (SPEC §16).

use crate::commands::AppState;
use crate::errors::{AppError, AppResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

/// Override at build time: `$env:INCASK_UPDATE_URL="https://.../latest.json"; npm run tauri build`
pub const DEFAULT_UPDATE_URL: &str = match option_env!("INCASK_UPDATE_URL") {
    Some(u) => u,
    None => "",
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub done: bool,
}

fn err(e: impl std::fmt::Display) -> AppError {
    let t = e.to_string();
    let low = t.to_lowercase();
    if low.contains("connect") || low.contains("dns") || low.contains("timed out") || low.contains("resolve") {
        return AppError::new("update_unreachable", "ต่อ server อัปเดตไม่ได้ — ตรวจ VPN หรือ URL อัปเดต");
    }
    if low.contains("signature") || low.contains("pubkey") || low.contains("public key") {
        return AppError::new("update_signature", "ตรวจลายเซ็นไฟล์อัปเดตไม่ได้ — ไม่ติดตั้ง (แจ้ง IT)");
    }
    AppError::new("update", format!("อัปเดตไม่สำเร็จ: {t}"))
}

fn updater(app: &AppHandle) -> AppResult<tauri_plugin_updater::Updater> {
    let url = app.state::<AppState>().settings.lock().update_url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::new("update_no_url", "ยังไม่ได้ตั้ง URL อัปเดต — ติดต่อ IT"));
    }
    let parsed: Url = url.parse().map_err(|_| AppError::new("update_no_url", "URL อัปเดตไม่ถูกต้อง"))?;
    app.updater_builder().endpoints(vec![parsed]).map_err(err)?.build().map_err(err)
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let found = updater(&app)?.check().await.map_err(err)?;
    Ok(match found {
        Some(u) => UpdateInfo {
            available: true,
            current_version: current,
            version: Some(u.version.clone()),
            notes: u.body.clone(),
            date: u.date.map(|d| d.date().to_string()),
        },
        None => UpdateInfo { available: false, current_version: current, version: None, notes: None, date: None },
    })
}

/// Download, verify the signature, run the installer (passive), then restart.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> AppResult<()> {
    let Some(update) = updater(&app)?.check().await.map_err(err)? else {
        return Err(AppError::new("update_none", "ไม่มีเวอร์ชันใหม่"));
    };
    let mut got: u64 = 0;
    let a = app.clone();
    update
        .download_and_install(
            |chunk, total| {
                got += chunk as u64;
                let _ = a.emit("update-progress", UpdateProgress { downloaded: got, total, done: false });
            },
            || {
                let _ = a.emit("update-progress", UpdateProgress { downloaded: 0, total: None, done: true });
            },
        )
        .await
        .map_err(err)?;
    app.restart();
}
