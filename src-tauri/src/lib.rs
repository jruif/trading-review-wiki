mod clip_server;
mod commands;
mod path_guard;
mod secrets;
mod settings;
mod types;

#[tauri::command]
fn clip_server_status() -> String {
    clip_server::get_daemon_status().to_string()
}

#[tauri::command]
fn get_clip_server_token() -> String {
    clip_server::get_clip_server_token()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    clip_server::start_clip_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_file,
            commands::fs::read_file_binary,
            commands::fs::parse_trade_excel,
            commands::fs::write_file,
            commands::fs::append_file,
            commands::fs::write_binary_file,
            commands::fs::list_directory,
            commands::fs::copy_file,
            commands::fs::copy_directory,
            commands::fs::preprocess_file,
            commands::fs::delete_file,
            commands::fs::find_related_wiki_pages,
            commands::fs::create_directory,
            commands::fs::rename_file,
            commands::http::post_json_via_native_http,
            commands::project::create_project,
            commands::project::open_project,
            clip_server_status,
            get_clip_server_token,
            commands::vectorstore::vector_upsert,
            commands::vectorstore::vector_search,
            commands::vectorstore::vector_delete,
            commands::vectorstore::vector_count,
            commands::vectorstore::vector_stats,
            commands::vectorstore::vector_clear,
            commands::stock_codes::sync_stock_codes,
            commands::stock_codes::lookup_stock_code,
            commands::stock_codes::get_stock_codes_status,
            commands::migrate::migrate_wiki_backup,
            commands::normalize_dirs::normalize_wiki_dirs,
            commands::body_residue::body_residue_backup,
            commands::cleanup_garbage::cleanup_garbage_backup,
            commands::fs::grant_read_path,
            commands::fs::grant_read_directory,
            commands::fs::read_file_head,
            secrets::store_secret,
            secrets::load_secret,
            secrets::delete_secret,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    let _ = window.hide();
                    api.prevent_close();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    use tauri::Manager;
                    api.prevent_close();
                    let win = window.clone();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_dialog::DialogExt;
                        let confirmed = app
                            .dialog()
                            .message("Are you sure you want to quit LLM Wiki?")
                            .title("Confirm Exit")
                            .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                            .blocking_show();

                        if confirmed {
                            let _ = win.destroy();
                        }
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    use tauri::Manager;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            let _ = (app, event); // suppress unused warnings on non-macOS
        });
}
