use chrono::{DateTime, Datelike, Local, Utc};
use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::services::db::{AssetFilterCriteria, ViewScope};
use crate::services::immich_client::{AssetSummary, PersonSummary};
use crate::AppState;

/// Probe whether the configured Immich server is currently reachable. Used by
/// the mutation commands to decide between surfacing a server error (online) and
/// queuing the change for later replay (offline).
async fn server_reachable(state: &tauri::State<'_, AppState>) -> bool {
    match state.db.get_auth_credentials() {
        Ok(Some((server_url, _token, _is_oauth))) => state.immich.ping(&server_url).await,
        _ => false,
    }
}

fn is_visible_in_grid(asset: &AssetSummary) -> bool {
    if asset.is_archived {
        return false;
    }

    let visibility = asset.visibility.as_deref().unwrap_or_default().to_ascii_lowercase();
    visibility != "archive"
}

#[derive(Clone, Copy, Debug)]
enum AssetFilter {
    All,
    Favorites,
    Archived,
}

fn parse_asset_filter(filter: Option<&str>) -> AssetFilter {
    match filter
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("all")
        .to_ascii_lowercase()
        .as_str()
    {
        "favorites" => AssetFilter::Favorites,
        "archived" => AssetFilter::Archived,
        _ => AssetFilter::All,
    }
}

fn include_archived_in_grid(filter: AssetFilter) -> bool {
    matches!(filter, AssetFilter::Archived)
}

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
    pub r#type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub thumbhash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayoutItem {
    pub id: String,
    pub width: f64,
    pub thumbhash: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDateJumpTarget {
    pub date_key: String,
    pub page: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLayoutDay {
    pub date_key: String,
    pub year: i32,
    pub month: u32,
    pub row_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLayoutMonth {
    pub month_key: String,
    pub jump_date_key: String,
    pub year: i32,
    pub month: u32,
    pub row_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLayoutResponse {
    pub total_rows: u32,
    pub days: Vec<TimelineLayoutDay>,
    pub months: Vec<TimelineLayoutMonth>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAssetDetails {
    pub id: String,
    pub original_file_name: String,
    pub description: Option<String>,
    pub original_path: Option<String>,
    pub file_created_at: Option<String>,
    pub checksum: Option<String>,
    pub r#type: Option<String>,
    pub duration: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub file_size_bytes: Option<i64>,
    pub file_extension: Option<String>,
    pub people: Option<String>,
    pub tags: Option<String>,
    pub exif_info_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetVisibilityPayload {
    pub asset_id: String,
    pub visibility: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetDescriptionPayload {
    pub asset_id: String,
    pub description: Option<String>,
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
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let (cached_items, cached_has_next_page) = state
        .db
        .get_calendar_assets(year, month, page, page_size, criteria.as_ref())
        .map_err(|err| format!("calendar cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items: cached_items,
        has_next_page: cached_has_next_page,
    })
}

#[tauri::command]
pub async fn get_cached_assets(
    page: u32,
    page_size: u32,
    search: Option<String>,
    filter: Option<String>,
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let started_at = Instant::now();
    let (items, has_next_page) = state
        .db
        .get_assets(page, page_size, search.as_deref(), filter.as_deref(), criteria.as_ref())
        .map_err(|err| format!("cache read failed: {err}"))?;

    log::warn!(
        "[assets.get_cached_assets] page={} page_size={} search={:?} filter={:?} item_count={} has_next_page={} duration_ms={}",
        page,
        page_size,
        search,
        filter,
        items.len(),
        has_next_page,
        started_at.elapsed().as_millis()
    );

    Ok(AssetPage {
        page,
        page_size,
        items,
        has_next_page,
    })
}

#[tauri::command]
pub async fn get_all_cached_assets(
    search: Option<String>,
    filter: Option<String>,
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AssetSummary>, String> {
    state
        .db
        .get_all_assets(search.as_deref(), filter.as_deref(), criteria.as_ref())
        .map_err(|err| format!("cache read failed: {err}"))
}

#[tauri::command]
pub async fn get_cached_asset_days(
    search: Option<String>,
    filter: Option<String>,
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let started_at = Instant::now();
    let result = state
        .db
        .get_asset_days(search.as_deref(), filter.as_deref(), criteria.as_ref())
        .map_err(|err| format!("asset day query failed: {err}"))?;

    log::warn!(
        "[assets.get_cached_asset_days] search={:?} filter={:?} day_count={} duration_ms={}",
        search,
        filter,
        result.len(),
        started_at.elapsed().as_millis()
    );

    Ok(result)
}

#[tauri::command]
pub async fn get_cached_asset_jump_target(
    date_key: String,
    page_size: u32,
    search: Option<String>,
    filter: Option<String>,
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<AssetDateJumpTarget>, String> {
    let started_at = Instant::now();
    let page = state
        .db
        .get_asset_jump_target_page(
            &date_key,
            page_size,
            search.as_deref(),
            filter.as_deref(),
            criteria.as_ref(),
        )
        .map_err(|err| format!("asset jump target query failed: {err}"))?;

    log::warn!(
        "[assets.get_cached_asset_jump_target] date_key={} page_size={} search={:?} filter={:?} page={:?} duration_ms={}",
        date_key,
        page_size,
        search,
        filter,
        page,
        started_at.elapsed().as_millis()
    );

    Ok(page.map(|page| AssetDateJumpTarget { date_key, page }))
}

#[tauri::command]
pub async fn get_cached_timeline_layout(
    search: Option<String>,
    container_width: f64,
    filter: Option<String>,
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<TimelineLayoutResponse, String> {
    let started_at = Instant::now();
    let parsed_filter = parse_asset_filter(filter.as_deref());
    if container_width <= 0.0 {
        return Ok(TimelineLayoutResponse {
            total_rows: 0,
            days: Vec::new(),
            months: Vec::new(),
        });
    }

    let all_assets = state
        .db
        .get_all_assets(search.as_deref(), filter.as_deref(), criteria.as_ref())
        .map_err(|err| format!("timeline layout cache read failed: {err}"))?;

    let layout_assets = all_assets
        .into_iter()
        .filter(|asset| include_archived_in_grid(parsed_filter) || is_visible_in_grid(asset))
        .map(|asset| GridLayoutAssetInput {
            id: asset.id,
            file_created_at: asset.file_created_at,
            r#type: asset.r#type,
            width: asset.width,
            height: asset.height,
            thumbhash: asset.thumbhash,
        })
        .collect::<Vec<_>>();

    let grouped_days = group_assets_by_day(&layout_assets);

    let mut total_rows: u32 = 0;
    let mut days: Vec<TimelineLayoutDay> = Vec::new();
    let mut months: Vec<TimelineLayoutMonth> = Vec::new();

    for (day_key, _label, items) in grouped_days {
        let Some((year, month)) = parse_year_month_from_day_key(&day_key) else {
            continue;
        };

        let row_count = build_justified_rows(items, container_width).len() as u32;
        if row_count == 0 {
            continue;
        }

        total_rows += row_count;

        days.push(TimelineLayoutDay {
            date_key: day_key.clone(),
            year,
            month,
            row_count,
        });

        let month_key = format!("{:04}-{:02}", year, month);
        if let Some(existing) = months.last_mut() {
            if existing.month_key == month_key {
                existing.row_count += row_count;
                continue;
            }
        }

        months.push(TimelineLayoutMonth {
            month_key,
            jump_date_key: day_key,
            year,
            month,
            row_count,
        });
    }

    let response = TimelineLayoutResponse {
        total_rows,
        days,
        months,
    };

    log::warn!(
        "[assets.get_cached_timeline_layout] search={:?} filter={:?} container_width={} days={} months={} total_rows={} duration_ms={}",
        search,
        filter,
        container_width,
        response.days.len(),
        response.months.len(),
        response.total_rows,
        started_at.elapsed().as_millis()
    );

    Ok(response)
}

#[tauri::command]
pub async fn get_cached_full_grid_layout(
    search: Option<String>,
    container_width: f64,
    filter: Option<String>,
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<GridLayoutResponse, String> {
    let started_at = Instant::now();
    let parsed_filter = parse_asset_filter(filter.as_deref());
    if container_width <= 0.0 {
        return Ok(GridLayoutResponse {
            sections: Vec::new(),
        });
    }

    let all_assets = state
        .db
        .get_all_assets(search.as_deref(), filter.as_deref(), criteria.as_ref())
        .map_err(|err| format!("full grid layout cache read failed: {err}"))?;

    let layout_assets = all_assets
        .into_iter()
        .filter(|asset| include_archived_in_grid(parsed_filter) || is_visible_in_grid(asset))
        .map(|asset| GridLayoutAssetInput {
            id: asset.id,
            file_created_at: asset.file_created_at,
            r#type: asset.r#type,
            width: asset.width,
            height: asset.height,
            thumbhash: asset.thumbhash,
        })
        .collect();

    let response = calculate_grid_layout(layout_assets, container_width)?;

    log::warn!(
        "[assets.get_cached_full_grid_layout] search={:?} filter={:?} container_width={} sections={} duration_ms={}",
        search,
        filter,
        container_width,
        response.sections.len(),
        started_at.elapsed().as_millis()
    );

    Ok(response)
}

#[tauri::command]
pub async fn get_cached_calendar_full_grid_layout(
    year: i32,
    month: u32,
    container_width: f64,
    criteria: Option<AssetFilterCriteria>,
    state: tauri::State<'_, AppState>,
) -> Result<GridLayoutResponse, String> {
    let started_at = Instant::now();
    if container_width <= 0.0 {
        return Ok(GridLayoutResponse {
            sections: Vec::new(),
        });
    }

    let all_assets = state
        .db
        .get_all_calendar_assets(year, month, criteria.as_ref())
        .map_err(|err| format!("calendar full grid layout cache read failed: {err}"))?;

    let layout_assets = all_assets
        .into_iter()
        .filter(is_visible_in_grid)
        .map(|asset| GridLayoutAssetInput {
            id: asset.id,
            file_created_at: asset.file_created_at,
            r#type: asset.r#type,
            width: asset.width,
            height: asset.height,
            thumbhash: asset.thumbhash,
        })
        .collect();

    let response = calculate_grid_layout(layout_assets, container_width)?;

    log::warn!(
        "[assets.get_cached_calendar_full_grid_layout] year={} month={} container_width={} sections={} duration_ms={}",
        year,
        month,
        container_width,
        response.sections.len(),
        started_at.elapsed().as_millis()
    );

    Ok(response)
}

#[tauri::command]
pub async fn get_asset_thumbnail(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let started_at = Instant::now();
    let result = state
        .immich
        .get_asset_thumbnail_data_url(&asset_id)
        .await
        .map_err(|err| format!("thumbnail load failed: {err}"))?;

    let elapsed_ms = started_at.elapsed().as_millis();
    if elapsed_ms >= 150 {
        log::warn!(
            "[assets.get_asset_thumbnail] asset_id={} duration_ms={}",
            asset_id, elapsed_ms
        );
    }

    Ok(result)
}

/// List the distinct camera names present in the assets of a given view scope
/// (all / album / folder / month). Powers the Camera filter dropdown. Reads only
/// from the local cache so it works offline.
#[tauri::command]
pub async fn get_cameras_in_scope(
    scope: ViewScope,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let started_at = Instant::now();
    let result = state
        .db
        .get_cameras_in_scope(&scope)
        .map_err(|err| format!("camera list query failed: {err}"))?;

    log::warn!(
        "[assets.get_cameras_in_scope] kind={} camera_count={} duration_ms={}",
        scope.kind,
        result.len(),
        started_at.elapsed().as_millis()
    );

    Ok(result)
}

/// List the people that appear in the assets of a given view scope. Powers the
/// People filter dropdown. Reads only from the local cache so it works offline.
#[tauri::command]
pub async fn get_people_in_scope(
    scope: ViewScope,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PersonSummary>, String> {
    let started_at = Instant::now();
    let result = state
        .db
        .get_people_in_scope(&scope)
        .map_err(|err| format!("people list query failed: {err}"))?;

    log::warn!(
        "[assets.get_people_in_scope] kind={} people_count={} duration_ms={}",
        scope.kind,
        result.len(),
        started_at.elapsed().as_millis()
    );

    Ok(result)
}

/// Return a data URL for a person's face thumbnail (local-first cached).
#[tauri::command]
pub async fn get_person_thumbnail(
    person_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let started_at = Instant::now();
    let result = state
        .immich
        .get_person_thumbnail_data_url(&person_id)
        .await
        .map_err(|err| format!("person thumbnail load failed: {err}"))?;

    let elapsed_ms = started_at.elapsed().as_millis();
    if elapsed_ms >= 150 {
        log::warn!(
            "[assets.get_person_thumbnail] person_id={} duration_ms={}",
            person_id, elapsed_ms
        );
    }

    Ok(result)
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
pub async fn get_cached_asset_details(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CachedAssetDetails>, String> {
    let details = state
        .db
        .get_asset_details(&asset_id)
        .map_err(|err| format!("asset details cache read failed: {err}"))?;

    Ok(details.map(|asset| CachedAssetDetails {
        id: asset.id,
        original_file_name: asset.original_file_name,
        description: asset.description,
        original_path: asset.original_path,
        file_created_at: asset.file_created_at,
        checksum: asset.checksum,
        r#type: asset.r#type,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        camera: asset.camera,
        lens: asset.lens,
        file_size_bytes: asset.file_size_bytes,
        file_extension: asset.file_extension,
        people: asset.people,
        tags: asset.tags,
        exif_info_json: asset.exif_info_json,
    }))
}

#[tauri::command]
pub async fn update_asset_description(
    payload: UpdateAssetDescriptionPayload,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    match state
        .immich
        .update_asset_description(&payload.asset_id, payload.description.as_deref())
        .await
    {
        Ok(_) => {
            state
                .db
                .update_asset_description(&payload.asset_id, payload.description.as_deref())
                .map_err(|err| format!("failed to cache updated description: {err}"))?;
            Ok(())
        }
        Err(err) => {
            // Distinguish an unreachable server (queue + apply locally) from a
            // genuine server-side rejection (surface the error).
            if server_reachable(&state).await {
                return Err(format!("description update failed: {err}"));
            }
            log::warn!(
                "[assets.update_asset_description] offline — queuing mutation asset_id={} err={}",
                payload.asset_id, err
            );
            state
                .db
                .update_asset_description(&payload.asset_id, payload.description.as_deref())
                .map_err(|e| format!("failed to cache updated description: {e}"))?;
            let body = serde_json::json!({ "description": payload.description });
            state
                .db
                .enqueue_mutation(&payload.asset_id, "description", &body.to_string())
                .map_err(|e| format!("failed to queue description update: {e}"))?;
            Ok(())
        }
    }
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
    match state.immich.update_asset_favorite(&asset_id, is_favorite).await {
        Ok(updated_asset) => {
            state
                .db
                .upsert_assets(&[updated_asset.clone()])
                .map_err(|err| format!("failed to cache updated asset: {err}"))?;
            Ok(updated_asset)
        }
        Err(err) => {
            if server_reachable(&state).await {
                return Err(format!("favorite update failed: {err}"));
            }
            log::warn!(
                "[assets.update_asset_favorite] offline — queuing mutation asset_id={} err={}",
                asset_id, err
            );
            state
                .db
                .update_asset_favorite(&asset_id, is_favorite)
                .map_err(|e| format!("failed to cache updated asset: {e}"))?;
            let body = serde_json::json!({ "isFavorite": is_favorite });
            state
                .db
                .enqueue_mutation(&asset_id, "favorite", &body.to_string())
                .map_err(|e| format!("failed to queue favorite update: {e}"))?;
            state
                .db
                .get_asset_summary(&asset_id)
                .map_err(|e| format!("failed to read cached asset: {e}"))?
                .ok_or_else(|| "asset not found in cache".to_string())
        }
    }
}

#[tauri::command]
pub async fn update_asset_visibility(
    payload: UpdateAssetVisibilityPayload,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    match state
        .immich
        .update_asset_visibility(&payload.asset_id, &payload.visibility)
        .await
    {
        Ok(updated_asset) => {
            state
                .db
                .upsert_assets(&[updated_asset.clone()])
                .map_err(|err| format!("failed to cache updated asset: {err}"))?;
            Ok(updated_asset)
        }
        Err(err) => {
            if server_reachable(&state).await {
                return Err(format!("visibility update failed: {err}"));
            }
            log::warn!(
                "[assets.update_asset_visibility] offline — queuing mutation asset_id={} err={}",
                payload.asset_id, err
            );
            state
                .db
                .update_asset_visibility(&payload.asset_id, &payload.visibility)
                .map_err(|e| format!("failed to cache updated asset: {e}"))?;
            let body = serde_json::json!({ "visibility": payload.visibility });
            state
                .db
                .enqueue_mutation(&payload.asset_id, "visibility", &body.to_string())
                .map_err(|e| format!("failed to queue visibility update: {e}"))?;
            state
                .db
                .get_asset_summary(&payload.asset_id)
                .map_err(|e| format!("failed to read cached asset: {e}"))?
                .ok_or_else(|| "asset not found in cache".to_string())
        }
    }
}

#[tauri::command]
pub async fn update_asset_rating(
    asset_id: String,
    rating: Option<i32>,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    match state.immich.update_asset_rating(&asset_id, rating).await {
        Ok(updated_asset) => {
            state
                .db
                .upsert_assets(&[updated_asset.clone()])
                .map_err(|err| format!("failed to cache updated asset: {err}"))?;
            Ok(updated_asset)
        }
        Err(err) => {
            if server_reachable(&state).await {
                return Err(format!("rating update failed: {err}"));
            }
            log::warn!(
                "[assets.update_asset_rating] offline — queuing mutation asset_id={} err={}",
                asset_id, err
            );
            state
                .db
                .update_asset_rating(&asset_id, rating)
                .map_err(|e| format!("failed to cache updated asset: {e}"))?;
            let body = serde_json::json!({ "rating": rating });
            state
                .db
                .enqueue_mutation(&asset_id, "rating", &body.to_string())
                .map_err(|e| format!("failed to queue rating update: {e}"))?;
            state
                .db
                .get_asset_summary(&asset_id)
                .map_err(|e| format!("failed to read cached asset: {e}"))?
                .ok_or_else(|| "asset not found in cache".to_string())
        }
    }
}

/// Number of asset mutations queued locally while offline, awaiting replay.
#[tauri::command]
pub async fn get_pending_mutation_count(
    state: tauri::State<'_, AppState>,
) -> Result<i64, String> {
    state
        .db
        .count_pending_mutations()
        .map_err(|err| format!("failed to count pending mutations: {err}"))
}

/// Replay every queued offline mutation against the server in creation order.
/// Stops early and returns the remaining count if the server becomes
/// unreachable again. Returns the number of mutations still pending afterwards.
#[tauri::command]
pub async fn flush_pending_mutations(
    state: tauri::State<'_, AppState>,
) -> Result<i64, String> {
    let pending = state
        .db
        .list_pending_mutations()
        .map_err(|err| format!("failed to list pending mutations: {err}"))?;

    if pending.is_empty() {
        return Ok(0);
    }

    log::info!(
        "[assets.flush_pending_mutations] replaying {} queued mutation(s)",
        pending.len()
    );

    for mutation in pending {
        let payload: serde_json::Value = serde_json::from_str(&mutation.payload_json)
            .map_err(|err| format!("invalid queued payload: {err}"))?;

        let result = match mutation.kind.as_str() {
            "favorite" => {
                let is_favorite = payload
                    .get("isFavorite")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                state
                    .immich
                    .update_asset_favorite(&mutation.asset_id, is_favorite)
                    .await
                    .map(Some)
            }
            "visibility" => {
                let visibility = payload
                    .get("visibility")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("timeline")
                    .to_string();
                state
                    .immich
                    .update_asset_visibility(&mutation.asset_id, &visibility)
                    .await
                    .map(Some)
            }
            "rating" => {
                let rating = payload
                    .get("rating")
                    .and_then(|v| v.as_i64().map(|n| n as i32));
                state
                    .immich
                    .update_asset_rating(&mutation.asset_id, rating)
                    .await
                    .map(Some)
            }
            "description" => {
                let description = payload.get("description").and_then(serde_json::Value::as_str);
                state
                    .immich
                    .update_asset_description(&mutation.asset_id, description)
                    .await
                    .map(Some)
            }
            other => {
                log::warn!(
                    "[assets.flush_pending_mutations] dropping unknown mutation kind={}",
                    other
                );
                // Drop unrecognized entries so the queue cannot get stuck.
                let _ = state.db.delete_pending_mutation(mutation.id);
                continue;
            }
        };

        match result {
            Ok(updated) => {
                if let Some(asset) = updated {
                    if let Err(err) = state.db.upsert_assets(&[asset]) {
                        log::warn!(
                            "[assets.flush_pending_mutations] cache write failed asset_id={} err={}",
                            mutation.asset_id, err
                        );
                    }
                }
                state
                    .db
                    .delete_pending_mutation(mutation.id)
                    .map_err(|err| format!("failed to dequeue mutation: {err}"))?;
            }
            Err(err) => {
                // If the server is unreachable again, stop and keep the queue.
                if !server_reachable(&state).await {
                    log::warn!(
                        "[assets.flush_pending_mutations] server unreachable — pausing replay: {}",
                        err
                    );
                    break;
                }
                // Server is reachable but rejected this mutation; drop it so the
                // queue cannot get permanently stuck on a bad entry.
                log::warn!(
                    "[assets.flush_pending_mutations] server rejected mutation id={} asset_id={} kind={} — dropping: {}",
                    mutation.id, mutation.asset_id, mutation.kind, err
                );
                state
                    .db
                    .delete_pending_mutation(mutation.id)
                    .map_err(|e| format!("failed to dequeue rejected mutation: {e}"))?;
            }
        }
    }

    let remaining = state
        .db
        .count_pending_mutations()
        .map_err(|err| format!("failed to count pending mutations: {err}"))?;

    log::info!(
        "[assets.flush_pending_mutations] replay complete — {} mutation(s) remaining",
        remaining
    );

    Ok(remaining)
}

#[tauri::command]
pub fn calculate_grid_layout(
    assets: Vec<GridLayoutAssetInput>,
    container_width: f64,
) -> Result<GridLayoutResponse, String> {
    if container_width <= 0.0 || assets.is_empty() {
        return Ok(GridLayoutResponse {
            sections: Vec::new(),
        });
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
    let target_row_height = if container_width < 700.0 {
        120.0
    } else {
        210.0
    };
    let mut rows: Vec<GridLayoutRow> = Vec::new();

    let mut row_items: Vec<&GridLayoutAssetInput> = Vec::new();
    let mut row_ratio_sum = 0.0;

    for item in items {
        let ratio = get_asset_ratio(item);
        row_items.push(item);
        row_ratio_sum += ratio;

        let projected_width =
            row_ratio_sum * target_row_height + gap * (row_items.len() as f64 - 1.0);
        if projected_width >= container_width && row_items.len() > 1 {
            let row_height = ((container_width - gap * (row_items.len() as f64 - 1.0))
                / row_ratio_sum)
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
            thumbhash: item.thumbhash.clone(),
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
        _ => {
            let is_video = asset
                .r#type
                .as_deref()
                .map(|value| value.eq_ignore_ascii_case("video"))
                .unwrap_or(false);

            if is_video {
                16.0 / 9.0
            } else {
                4.0 / 3.0
            }
        }
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

fn parse_year_month_from_day_key(day_key: &str) -> Option<(i32, u32)> {
    let mut parts = day_key.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }

    Some((year, month))
}
