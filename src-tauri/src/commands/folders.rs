use crate::commands::assets::AssetPage;
use crate::AppState;

#[tauri::command]
pub async fn get_unique_original_paths(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let cached_paths = state
        .db
        .get_unique_original_paths()
        .map_err(|err| format!("folder path cache read failed: {err}"))?;

    if !cached_paths.is_empty() {
        return Ok(cached_paths);
    }

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
    let (cached_items, cached_has_next_page) = state
        .db
        .get_folder_assets(&path, page, page_size)
        .map_err(|err| format!("folder asset cache read failed: {err}"))?;

    if page > 0 || !cached_items.is_empty() {
        return Ok(AssetPage {
            page,
            page_size,
            items: cached_items,
            has_next_page: cached_has_next_page,
        });
    }

    let result = state
        .immich
        .get_folder_assets_paged(&path, page, page_size)
        .await
        .map_err(|err| format!("fetch folder assets failed: {err}"))?;

    state
        .db
        .upsert_assets(&result.items)
        .map_err(|err| format!("cache write failed: {err}"))?;

    let (items, has_next_page) = state
        .db
        .get_folder_assets(&path, page, page_size)
        .map_err(|err| format!("folder asset cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items,
        has_next_page,
    })
}