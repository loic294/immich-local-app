mod commands;
mod db;
mod services;

use commands::albums::{fetch_albums, get_album_assets_paged, get_cached_album_full_grid_layout};
use commands::assets::{
    calculate_grid_layout, fetch_assets, fetch_assets_by_month, get_all_cached_assets,
    get_asset_playback, get_asset_thumbnail, get_cached_asset_days, get_cached_asset_details,
    get_cached_asset_jump_target, get_cached_assets, get_cached_calendar_full_grid_layout,
    get_cached_full_grid_layout, get_cached_timeline_layout, get_calendar_assets_paged,
    get_timeline_months, refresh_asset, update_asset_description, update_asset_favorite,
    update_asset_rating, update_asset_visibility,
};
use commands::auth::{
    authenticate, complete_oauth_flow, get_oauth_authorization_url, get_profile_image, logout,
    restore_session,
};
use commands::folders::get_cached_folder_full_grid_layout;
use commands::folders::{get_folder_assets_paged, get_unique_original_paths};
use commands::memories::fetch_memories;
use commands::settings::{get_cache_path, get_cache_stats, get_settings, update_settings};
use commands::shell::open_url;
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
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            match app.deep_link().get_current() {
                Ok(Some(urls)) => {
                    println!("[oauth:deep-link:rust] startup urls={:?}", urls);
                }
                Ok(None) => {
                    println!("[oauth:deep-link:rust] startup urls=<none>");
                }
                Err(err) => {
                    println!("[oauth:deep-link:rust] get_current error={}", err);
                }
            }

            app.deep_link().on_open_url(|event| {
                let urls = event.urls();
                println!("[oauth:deep-link:rust] on_open_url urls={:?}", urls);
            });

            Ok(())
        })
        .manage(AppState { db, immich })
        .invoke_handler(tauri::generate_handler![
            authenticate,
            restore_session,
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
            fetch_memories,
            fetch_albums,
            get_album_assets_paged,
            get_cached_album_full_grid_layout,
            get_unique_original_paths,
            get_folder_assets_paged,
            get_cached_folder_full_grid_layout,
            get_settings,
            update_settings,
            get_cache_stats,
            get_cache_path,
            open_url,
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
