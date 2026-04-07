use crate::services::immich_client::AlbumSummary;
use crate::AppState;

#[tauri::command]
pub async fn fetch_albums(state: tauri::State<'_, AppState>) -> Result<Vec<AlbumSummary>, String> {
    state
        .immich
        .get_albums()
        .await
        .map_err(|err| format!("fetch albums failed: {err}"))
}

#[tauri::command]
pub async fn get_album_assets(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::services::immich_client::AssetSummary>, String> {
    state
        .immich
        .get_album_assets(&album_id)
        .await
        .map_err(|err| format!("fetch album assets failed: {err}"))
}