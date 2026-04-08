use serde::{Deserialize, Serialize};
use chrono::{DateTime, Datelike, Local, Utc};

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
pub struct GridLayoutAssetInput {
    pub id: String,
    pub file_created_at: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayoutItem {
    pub id: String,
    pub width: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayoutRow {
    pub height: f64,
    pub items: Vec<GridLayoutItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayoutSection {
    pub key: String,
    pub label: String,
    pub rows: Vec<GridLayoutRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayoutResponse {
    pub sections: Vec<GridLayoutSection>,
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
pub async fn fetch_assets_by_month(
    year: i32,
    month: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let result = state
        .immich
        .get_assets_by_month(year, month)
        .await
        .map_err(|err| format!("fetch assets by month failed: {err}"))?;

    state
        .db
        .upsert_assets(&result)
        .map_err(|err| format!("cache write failed: {err}"))?;

    Ok(AssetPage {
        page: 0,
        page_size: result.len() as u32,
        items: result,
        has_next_page: false,
    })
}

#[tauri::command]
pub async fn get_calendar_assets_paged(
    year: i32,
    month: u32,
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let result = state
        .immich
        .get_calendar_assets_paged(year, month, page, page_size)
        .await
        .map_err(|err| format!("fetch calendar assets failed: {err}"))?;

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

#[tauri::command]
pub fn calculate_grid_layout(
    assets: Vec<GridLayoutAssetInput>,
    container_width: f64,
) -> Result<GridLayoutResponse, String> {
    if container_width <= 0.0 || assets.is_empty() {
        return Ok(GridLayoutResponse { sections: Vec::new() });
    }

    let sections = group_assets_by_day(&assets)
        .into_iter()
        .map(|(key, label, items)| GridLayoutSection {
            key,
            label,
            rows: build_justified_rows(items, container_width),
        })
        .collect();

    Ok(GridLayoutResponse { sections })
}

fn group_assets_by_day(
    assets: &[GridLayoutAssetInput],
) -> Vec<(String, String, Vec<&GridLayoutAssetInput>)> {
    let mut sections: Vec<(String, String, Vec<&GridLayoutAssetInput>)> = Vec::new();

    let mut current_key = String::new();
    let mut current_label = String::new();
    let mut current_items: Vec<&GridLayoutAssetInput> = Vec::new();

    for asset in assets {
        let (key, label) = get_asset_day(asset.file_created_at.as_deref());

        if current_key.is_empty() {
            current_key = key.clone();
            current_label = label.clone();
        }

        if key != current_key {
            sections.push((
                std::mem::take(&mut current_key),
                std::mem::take(&mut current_label),
                std::mem::take(&mut current_items),
            ));
            current_key = key.clone();
            current_label = label.clone();
        }

        current_items.push(asset);
    }

    if !current_items.is_empty() {
        sections.push((current_key, current_label, current_items));
    }

    sections
}

fn build_justified_rows(
    items: Vec<&GridLayoutAssetInput>,
    container_width: f64,
) -> Vec<GridLayoutRow> {
    if items.is_empty() {
        return Vec::new();
    }

    let gap = 4.0;
    let target_row_height = if container_width < 700.0 { 120.0 } else { 210.0 };
    let mut rows: Vec<GridLayoutRow> = Vec::new();

    let mut row_items: Vec<&GridLayoutAssetInput> = Vec::new();
    let mut row_ratio_sum = 0.0;

    for item in items {
        let ratio = get_asset_ratio(item);
        row_items.push(item);
        row_ratio_sum += ratio;

        let projected_width = row_ratio_sum * target_row_height + gap * (row_items.len() as f64 - 1.0);
        if projected_width >= container_width && row_items.len() > 1 {
            let row_height = ((container_width - gap * (row_items.len() as f64 - 1.0)) / row_ratio_sum)
                .clamp(90.0, 280.0);
            rows.push(build_row(row_items, row_height));
            row_items = Vec::new();
            row_ratio_sum = 0.0;
        }
    }

    if !row_items.is_empty() {
        rows.push(build_row(row_items, target_row_height));
    }

    rows
}

fn build_row(items: Vec<&GridLayoutAssetInput>, row_height: f64) -> GridLayoutRow {
    let mapped = items
        .into_iter()
        .map(|item| GridLayoutItem {
            id: item.id.clone(),
            width: row_height * get_asset_ratio(item),
        })
        .collect();

    GridLayoutRow {
        height: row_height,
        items: mapped,
    }
}

fn get_asset_ratio(asset: &GridLayoutAssetInput) -> f64 {
    match (asset.width, asset.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => width as f64 / height as f64,
        _ => 4.0 / 3.0,
    }
}

fn get_asset_day(file_created_at: Option<&str>) -> (String, String) {
    let Some(raw_date) = file_created_at else {
        return ("unknown".to_string(), "Unknown date".to_string());
    };

    let parsed_utc = DateTime::parse_from_rfc3339(raw_date)
        .ok()
        .map(|value| value.with_timezone(&Utc));

    let Some(date_utc) = parsed_utc else {
        return ("unknown".to_string(), "Unknown date".to_string());
    };

    let local_date = date_utc.with_timezone(&Local);
    let key = format!(
        "{:04}-{:02}-{:02}",
        local_date.year(),
        local_date.month(),
        local_date.day()
    );

    let today = Local::now().date_naive();
    let value_date = local_date.date_naive();
    let diff_days = (today - value_date).num_days();

    let label = if diff_days == 0 {
        "Today".to_string()
    } else if diff_days == 1 {
        "Yesterday".to_string()
    } else {
        local_date.format("%a, %b %-d, %Y").to_string()
    };

    (key, label)
}
