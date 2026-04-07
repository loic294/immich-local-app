use serde::{Deserialize, Serialize};

use crate::services::immich_client::AssetSummary;
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPage {
    pub page: u32,
    pub page_size: u32,
    pub items: Vec<AssetSummary>,
    pub has_next_page: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMonths {
    pub newest_month: Option<String>,
    pub oldest_month: Option<String>,
    pub months: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetVisibilityPayload {
    pub asset_id: String,
    pub visibility: String,
}

#[tauri::command]
pub async fn fetch_assets(
    page: u32,
    page_size: u32,
    search: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let result = state
        .immich
        .get_assets(page, page_size, search.as_deref())
        .await
        .map_err(|err| format!("fetch assets failed: {err}"))?;

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

#[tauri::command]
pub async fn get_cached_assets(
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let items = state
        .db
        .get_assets(page, page_size)
        .map_err(|err| format!("cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items,
        has_next_page: false,
    })
}

#[tauri::command]
pub async fn get_asset_thumbnail(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .immich
        .get_asset_thumbnail_data_url(&asset_id)
        .await
        .map_err(|err| format!("thumbnail load failed: {err}"))
}

#[tauri::command]
pub async fn get_asset_playback(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .immich
        .get_asset_playback_file_path(&asset_id)
        .await
        .map_err(|err| format!("video playback load failed: {err}"))
}

#[tauri::command]
pub async fn refresh_asset(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    // Fetch the latest asset metadata from the server
    let asset = state
        .immich
        .get_asset(&asset_id)
        .await
        .map_err(|err| format!("refresh asset failed: {err}"))?;

    // Update the cache with the latest metadata
    state
        .db
        .upsert_assets(&[asset.clone()])
        .map_err(|err| format!("failed to cache refreshed asset: {err}"))?;

    Ok(asset)
}

#[tauri::command]
pub async fn get_timeline_months(
    state: tauri::State<'_, AppState>,
) -> Result<TimelineMonths, String> {
    let (newest_month, oldest_month, months) = state
        .db
        .get_timeline_months()
        .map_err(|err| format!("timeline query failed: {err}"))?;

    Ok(TimelineMonths {
        newest_month,
        oldest_month,
        months,
    })
}

#[tauri::command]
pub async fn update_asset_favorite(
    asset_id: String,
    is_favorite: bool,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    let updated_asset = state
        .immich
        .update_asset_favorite(&asset_id, is_favorite)
        .await
        .map_err(|err| format!("favorite update failed: {err}"))?;

    // Cache the updated asset
    state
        .db
        .upsert_assets(&[updated_asset.clone()])
        .map_err(|err| format!("failed to cache updated asset: {err}"))?;

    Ok(updated_asset)
}

#[tauri::command]
pub async fn update_asset_visibility(
    payload: UpdateAssetVisibilityPayload,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    let updated_asset = state
        .immich
        .update_asset_visibility(&payload.asset_id, &payload.visibility)
        .await
        .map_err(|err| format!("visibility update failed: {err}"))?;

    // Cache the updated asset
    state
        .db
        .upsert_assets(&[updated_asset.clone()])
        .map_err(|err| format!("failed to cache updated asset: {err}"))?;

    Ok(updated_asset)
}

#[tauri::command]
pub async fn update_asset_rating(
    asset_id: String,
    rating: Option<i32>,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    let updated_asset = state
        .immich
        .update_asset_rating(&asset_id, rating)
        .await
        .map_err(|err| format!("rating update failed: {err}"))?;

    // Cache the updated asset
    state
        .db
        .upsert_assets(&[updated_asset.clone()])
        .map_err(|err| format!("failed to cache updated asset: {err}"))?;

    Ok(updated_asset)
}
