//! IncAsk — classify incident/ticket files with the company LLM Gateway, summarise as a pivot.
//! Sibling app of DocAsk: same shell, Gateway client, key storage and redaction.

pub mod commands;
pub mod config;
pub mod errors;
pub mod gateway_test;
pub mod llm;
pub mod redact;
pub mod secrets;
pub mod updater;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let state = AppState::new().map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::save_settings,
            commands::get_gateway,
            commands::set_gateway_url,
            commands::save_api_key,
            commands::remove_api_key,
            commands::check_gateway,
            commands::gateway_status,
            commands::gateway_models,
            commands::test_gateway,
            commands::gateway_key_usage,
            updater::check_update,
            updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running IncAsk");
}
