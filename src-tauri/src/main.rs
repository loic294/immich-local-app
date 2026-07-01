#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod services;
mod util;

use commands::albums::{
    add_assets_to_album, add_user_to_album, can_manage_album_sharing, create_album_with_assets,
    create_share_link_for_assets, delete_local_album, fetch_albums, get_album_assets_paged,
    get_album_share_link, get_album_share_users, get_cached_album_full_grid_layout,
    get_or_create_album_share_link, get_shareable_users, remove_user_from_album,
    save_album_locally,
};
use commands::assets::{
    calculate_grid_layout, fetch_assets, fetch_assets_by_month, flush_pending_mutations,
    get_all_cached_assets, get_asset_playback, get_asset_thumbnail, get_cached_asset_days,
    get_cached_asset_details, get_cached_asset_jump_target, get_cached_assets,
    get_cached_calendar_full_grid_layout, get_cached_full_grid_layout, get_cached_timeline_layout,
    get_calendar_assets_paged, get_cameras_in_scope, get_pending_mutation_count,
    is_video_download_complete,
    get_people_in_scope, get_person_thumbnail, get_timeline_months, refresh_asset,
    update_asset_description, update_asset_favorite, update_asset_rating, update_asset_visibility,
};
use commands::auth::{
    add_account_complete_oauth, add_account_oauth_url, add_account_with_key,
    add_account_with_password, authenticate, authenticate_with_password, check_server_connection,
    complete_oauth_flow, get_oauth_authorization_url, get_profile_image, list_accounts, logout,
    remove_account, restore_session, set_primary_account,
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
    apply_saved_local_file_changes, cancel_asset_sync, check_for_new_assets,
    dismiss_saved_local_file_changes, force_full_asset_sync, get_saved_local_file_changes,
    get_sync_status, refresh_album_assets, refresh_album_list, scan_saved_local_files,
    start_asset_sync,
};
use services::db::Database;
use services::account_manager::AccountManager;
use services::immich_client::ImmichClient;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri_plugin_deep_link::DeepLinkExt;

/// Directory inside the user's "Cache Location" where application log files are
/// written in production builds. Mirrors the cache root used for thumbnails,
/// videos, etc. so all on-disk app data lives under one place.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn cache_logs_dir() -> Option<PathBuf> {
    crate::util::home_dir().map(|home| {
        home.join(".config")
            .join("immich-local-app")
            .join("logs")
    })
}

/// Build the logging plugin.
///
/// In production builds, both Rust (`log::*`) and frontend (`console.*`, routed
/// through `@tauri-apps/plugin-log`) records are written to rotating files in
/// the user's Cache Location (`<cache>/logs`). In debug builds we keep the
/// developer-friendly Stdout + default app log dir targets instead.
fn build_log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_log::Builder::new().level(log::LevelFilter::Info);

    #[cfg(debug_assertions)]
    let builder = builder
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("immich-local-app".to_string()),
            },
        ));

    #[cfg(not(debug_assertions))]
    let builder = {
        let target = match cache_logs_dir() {
            Some(dir) => {
                // Best-effort: ensure the directory exists so the first write
                // doesn't fail silently. The plugin also creates it, but this
                // logs an early, actionable error if the path is unusable.
                if let Err(err) = std::fs::create_dir_all(&dir) {
                    eprintln!(
                        "[logging] failed to create cache logs dir {}: {}",
                        dir.display(),
                        err
                    );
                }
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                    path: dir,
                    file_name: Some("immich-local-app".to_string()),
                })
            }
            // Fall back to the platform default log dir if the home directory
            // cannot be resolved, so production logging never silently breaks.
            None => tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("immich-local-app".to_string()),
            }),
        };
        builder.target(target)
    };

    builder.build()
}

pub struct AppState {
    pub db: Arc<Database>,
    pub immich: Arc<ImmichClient>,
    pub accounts: Arc<AccountManager>,
    /// Cooperative cancellation flag for the background asset sync task. Set to
    /// `true` by `cancel_asset_sync` and checked at each page boundary in the
    /// sync loop; reset to `false` whenever a new sync starts.
    pub sync_cancel: Arc<AtomicBool>,
}

impl AppState {
    /// Resolve the [`ImmichClient`] for a specific account, falling back to the
    /// primary account's client when no account id is given or the requested
    /// account is not registered.
    pub fn client_for(&self, account_id: Option<&str>) -> Arc<ImmichClient> {
        match account_id {
            Some(id) => self
                .accounts
                .client(id)
                .unwrap_or_else(|| self.immich.clone()),
            None => self.immich.clone(),
        }
    }

    /// Resolve the locally-generated primary account id, consulting the
    /// in-memory registry first and falling back to the persisted accounts
    /// table. Returns an empty string when no account exists yet.
    pub fn primary_account_id(&self) -> String {
        self.accounts
            .primary_id()
            .or_else(|| {
                self.db
                    .get_primary_account()
                    .ok()
                    .flatten()
                    .map(|account| account.id)
            })
            .unwrap_or_default()
    }

    /// Resolve which account a cached asset belongs to plus the matching client,
    /// for routing per-asset network operations to the correct server session.
    /// Falls back to the primary account when the asset has no attribution.
    pub fn account_and_client_for_asset(&self, asset_id: &str) -> (String, Arc<ImmichClient>) {
        let account_id = self
            .db
            .get_asset_account_id(asset_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| self.primary_account_id());
        let client = self
            .accounts
            .client(&account_id)
            .unwrap_or_else(|| self.immich.clone());
        (account_id, client)
    }

    /// Resolve which account a cached album belongs to plus the matching client,
    /// for routing per-album network operations to the correct server session.
    /// Falls back to the primary account when the album has no attribution.
    pub fn account_and_client_for_album(&self, album_id: &str) -> (String, Arc<ImmichClient>) {
        let account_id = self
            .db
            .get_album_account_id(album_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| self.primary_account_id());
        let client = self
            .accounts
            .client(&account_id)
            .unwrap_or_else(|| self.immich.clone());
        (account_id, client)
    }

    /// All `(account_id, client)` pairs that should participate in a sync. Falls
    /// back to the primary account bound to the shared client when the registry
    /// has not been populated yet (e.g. immediately after a fresh login).
    pub fn sync_accounts(&self) -> Vec<(String, Arc<ImmichClient>)> {
        let registered = self.accounts.all();
        if !registered.is_empty() {
            return registered;
        }
        let primary_id = self.primary_account_id();
        if primary_id.is_empty() {
            Vec::new()
        } else {
            vec![(primary_id, self.immich.clone())]
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn main() {
    let db = Arc::new(Database::new().expect("failed to initialize sqlite"));
    let immich = Arc::new(ImmichClient::new());
    let accounts = Arc::new(AccountManager::new());
    let sync_cancel = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(build_log_plugin())
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
        .manage(AppState {
            db,
            immich,
            accounts,
            sync_cancel,
        })
        .invoke_handler(tauri::generate_handler![
            authenticate,
            authenticate_with_password,
            restore_session,
            check_server_connection,
            logout,
            get_profile_image,
            get_oauth_authorization_url,
            complete_oauth_flow,
            list_accounts,
            set_primary_account,
            remove_account,
            add_account_with_key,
            add_account_with_password,
            add_account_oauth_url,
            add_account_complete_oauth,
            fetch_assets,
            get_cached_assets,
            get_all_cached_assets,
            get_cached_asset_days,
            get_cached_asset_jump_target,
            get_cached_timeline_layout,
            get_asset_thumbnail,
            get_cameras_in_scope,
            get_people_in_scope,
            get_person_thumbnail,
            get_asset_playback,
            is_video_download_complete,
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
            delete_local_album,
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
            cancel_asset_sync,
            check_for_new_assets,
            refresh_album_assets,
            refresh_album_list,
            scan_saved_local_files,
            get_saved_local_file_changes,
            apply_saved_local_file_changes,
            dismiss_saved_local_file_changes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
