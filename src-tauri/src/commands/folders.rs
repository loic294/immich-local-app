use crate::commands::assets::AssetPage;
use crate::AppState;

#[tauri::command]
pub async fn get_unique_original_paths(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state
        .db
        .get_unique_original_paths()
        .map_err(|err| format!("folder path cache read failed: {err}"))
}

#[tauri::command]
pub async fn get_folder_assets_paged(
    path: String,
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let (cached_items, cached_has_next_page) = state
        .db
        .get_folder_assets(&path, page, page_size)
        .map_err(|err| format!("folder asset cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items: cached_items,
        has_next_page: cached_has_next_page,
    })
}