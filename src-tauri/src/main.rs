mod commands;
mod db;
mod services;

use commands::assets::{fetch_assets, get_asset_thumbnail, get_cached_assets};
use commands::auth::authenticate;
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
            get_asset_thumbnail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
