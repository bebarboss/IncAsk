//! IncAsk — classify incident/ticket files with the company LLM Gateway, summarise as a pivot.
//! Sibling app of DocAsk: same shell, Gateway client, key storage and redaction.

pub mod classify;
pub mod commands;
pub mod config;
pub mod config_backup;
pub mod db;
pub mod errors;
pub mod export;
pub mod gateway_test;
pub mod ingest;
pub mod llm;
pub mod pivot;
pub mod redact;
pub mod results;
pub mod secrets;
pub mod taxonomy;
pub mod updater;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // a second launch (double-clicking a .incask while IncAsk is open) hands its file to this one
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(p) = commands::incask_arg(args) {
                let _ = tauri::Emitter::emit(app, "open-incask", p);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            commands::reset_gateway_url,
            commands::save_api_key,
            commands::remove_api_key,
            commands::check_gateway,
            commands::gateway_status,
            commands::gateway_models,
            commands::test_gateway,
            commands::gateway_key_usage,
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            commands::list_services,
            commands::project_months,
            commands::list_taxonomy,
            commands::create_service,
            commands::update_service,
            commands::delete_service,
            commands::set_service_columns,
            commands::save_taxonomy_row,
            commands::taxonomy_row_usage,
            commands::delete_taxonomy_row,
            commands::preview_taxonomy_import,
            commands::apply_taxonomy_import,
            commands::save_taxonomy_template,
            commands::import_preview,
            commands::import_analyze,
            commands::import_commit,
            commands::list_patterns,
            commands::update_pattern,
            commands::delete_pattern,
            commands::start_classify,
            commands::classify_status,
            commands::pause_classify,
            commands::resume_classify,
            commands::cancel_classify,
            commands::reclassify,
            commands::classify_trial,
            commands::get_pref,
            commands::set_pref,
            commands::query_results,
            commands::source_columns,
            commands::set_category,
            commands::pivot_query,
            commands::pivot_drill,
            commands::pivot_charts,
            commands::pivot_values,
            commands::list_views,
            commands::save_view,
            commands::delete_view,
            commands::export_default_name,
            commands::export_csv,
            commands::export_incask,
            commands::export_html,
            commands::reveal_file,
            commands::inspect_incask,
            commands::import_incask,
            commands::merge_incask,
            commands::pending_open_file,
            commands::export_config,
            commands::config_diff,
            commands::config_apply,
            updater::check_update,
            updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running IncAsk");
}
