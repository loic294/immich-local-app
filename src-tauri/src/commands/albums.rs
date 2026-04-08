use crate::commands::assets::AssetPage;
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
pub async fn get_album_assets_paged(
    album_id: String,
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let result = state
        .immich
        .get_album_assets_paged(&album_id, page, page_size)
        .await
        .map_err(|err| format!("fetch album assets failed: {err}"))?;

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