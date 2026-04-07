use crate::services::immich_client::AssetSummary;
use crate::AppState;

#[tauri::command]
pub async fn get_unique_original_paths(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state
        .immich
        .get_unique_original_paths()
        .await
        .map_err(|err| format!("fetch folder paths failed: {err}"))
}

#[tauri::command]
pub async fn get_assets_by_original_path(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AssetSummary>, String> {
    state
        .immich
        .get_assets_by_original_path(&path)
        .await
        .map_err(|err| format!("fetch folder assets failed: {err}"))
}