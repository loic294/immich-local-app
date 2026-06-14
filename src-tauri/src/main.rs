#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod services;
mod util;

use commands::albums::{
    add_assets_to_album, add_user_to_album, can_manage_album_sharing, create_album_with_assets,
    create_share_link_for_assets, fetch_albums, get_album_assets_paged,
    get_album_share_link, get_album_share_users, get_cached_album_full_grid_layout,
    get_or_create_album_share_link, get_shareable_users, remove_user_from_album,
    save_album_locally,
};
use commands::assets::{
    calculate_grid_layout, fetch_assets, fetch_assets_by_month, flush_pending_mutations,
    get_all_cached_assets, get_asset_playback, get_asset_thumbnail, get_cached_asset_days,
    get_cached_asset_details, get_cached_asset_jump_target, get_cached_assets,
    get_cached_calendar_full_grid_layout, get_cached_full_grid_layout, get_cached_timeline_layout,
    get_calendar_assets_paged, get_pending_mutation_count, get_timeline_months, refresh_asset,
    update_asset_description, update_asset_favorite, update_asset_rating, update_asset_visibility,
};
use commands::auth::{
    authenticate, check_server_connection, complete_oauth_flow, get_oauth_authorization_url,
    get_profile_image, logout, restore_session,
};
use commands::folders::get_cached_folder_full_grid_layout;
use commands::folders::{get_folder_assets_paged, get_unique_original_paths};
use commands::memories::fetch_memories;
use commands::settings::{get_cache_path, get_cache_stats, get_settings, update_settings};
use commands::shell::{
    copy_assets_to_clipboard, copy_assets_to_local_folder, copy_text_to_clipboard,
    open_folder_in_file_explorer, open_url,
};
use commands::sync::{
    check_for_new_assets, force_full_asset_sync, get_sync_status, start_asset_sync,
};
use services::db::Database;
use services::immich_client::ImmichClient;
use std::sync::Arc;
use tauri_plugin_deep_link::DeepLinkExt;

pub struct AppState {
    pub db: Arc<Database>,
    pub immich: Arc<ImmichClient>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn main() {
    let db = Arc::new(Database::new().expect("failed to initialize sqlite"));
    let immich = Arc::new(ImmichClient::new());

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("immich-local-app".to_string()),
                    },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            match app.deep_link().get_current() {
                Ok(Some(urls)) => {
                    log::info!("[oauth:deep-link:rust] startup urls={:?}", urls);
                }
                Ok(None) => {
                    log::info!("[oauth:deep-link:rust] startup urls=<none>");
                }
                Err(err) => {
                    log::error!("[oauth:deep-link:rust] get_current error={}", err);
                }
            }

            app.deep_link().on_open_url(|event| {
                let urls = event.urls();
                log::info!("[oauth:deep-link:rust] on_open_url urls={:?}", urls);
            });

            Ok(())
        })
        .manage(AppState { db, immich })
        .invoke_handler(tauri::generate_handler![
            authenticate,
            restore_session,
            check_server_connection,
            logout,
            get_profile_image,
            get_oauth_authorization_url,
            complete_oauth_flow,
            fetch_assets,
            get_cached_assets,
            get_all_cached_assets,
            get_cached_asset_days,
            get_cached_asset_jump_target,
            get_cached_timeline_layout,
            get_asset_thumbnail,
            get_asset_playback,
            get_cached_asset_details,
            refresh_asset,
            get_timeline_months,
            update_asset_favorite,
            update_asset_visibility,
            update_asset_rating,
            update_asset_description,
            flush_pending_mutations,
            get_pending_mutation_count,
            fetch_memories,
            fetch_albums,
            get_album_assets_paged,
            get_cached_album_full_grid_layout,
            create_album_with_assets,
            add_assets_to_album,
            create_share_link_for_assets,
            can_manage_album_sharing,
            get_album_share_link,
            get_or_create_album_share_link,
            get_album_share_users,
            get_shareable_users,
            add_user_to_album,
            remove_user_from_album,
            save_album_locally,
            get_unique_original_paths,
            get_folder_assets_paged,
            get_cached_folder_full_grid_layout,
            get_settings,
            update_settings,
            get_cache_stats,
            get_cache_path,
            open_url,
            open_folder_in_file_explorer,
            copy_assets_to_clipboard,
            copy_assets_to_local_folder,
            copy_text_to_clipboard,
            fetch_assets_by_month,
            get_calendar_assets_paged,
            calculate_grid_layout,
            get_cached_full_grid_layout,
            get_cached_calendar_full_grid_layout,
            get_sync_status,
            start_asset_sync,
            force_full_asset_sync,
            check_for_new_assets
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
