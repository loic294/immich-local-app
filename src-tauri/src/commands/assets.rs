use serde::Serialize;

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
