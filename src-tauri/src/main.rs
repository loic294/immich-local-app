mod commands;
mod db;
mod services;

use commands::albums::{fetch_albums, get_album_assets};
use commands::assets::{
    fetch_assets, get_asset_playback, get_asset_thumbnail, get_cached_assets, get_timeline_months,
};
use commands::auth::authenticate;
use commands::folders::{get_assets_by_original_path, get_unique_original_paths};
use commands::memories::fetch_memories;
use services::db::Database;
use services::immich_client::ImmichClient;

struct AppState {
    db: Database,
    immich: ImmichClient,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn main() {
    let db = Database::new().expect("failed to initialize sqlite");
    let immich = ImmichClient::new();

    tauri::Builder::default()
        .manage(AppState { db, immich })
        .invoke_handler(tauri::generate_handler![
            authenticate,
            fetch_assets,
            get_cached_assets,
            get_asset_thumbnail,
            get_asset_playback,
            get_timeline_months,
            fetch_memories,
            fetch_albums,
            get_album_assets,
            get_unique_original_paths,
            get_assets_by_original_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
