use crate::commands::assets::AssetPage;
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
pub async fn get_folder_assets_paged(
    path: String,
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let result = state
        .immich
        .get_folder_assets_paged(&path, page, page_size)
        .await
        .map_err(|err| format!("fetch folder assets failed: {err}"))?;

    state
        .db
        .upsert_assets(&result.items)
        .map_err(|err| format!("cache write failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items: result.items,
        has_next_page: result.has_next_page,
    })
}