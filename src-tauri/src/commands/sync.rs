use crate::services::db::SyncState;
use crate::AppState;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{Instant, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSavedFileChangeResponse {
    pub id: i64,
    pub asset_id: String,
    pub local_path: String,
    pub file_name: String,
    pub change_kind: String,
    pub details_json: String,
    pub detected_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySavedLocalFileChangesInput {
    pub change_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySavedLocalFileChangesResult {
    pub applied_count: u32,
    pub failed_count: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResponse {
    pub total_assets: i32,
    pub processed_assets: i32,
    pub is_syncing: bool,
    pub last_sync_completed_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub check_status: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<SyncState> for SyncStatusResponse {
    fn from(state: SyncState) -> Self {
        SyncStatusResponse {
            total_assets: state.total_assets,
            processed_assets: state.processed_assets,
            is_syncing: state.is_syncing,
            last_sync_completed_at: state.last_sync_completed_at,
            last_checked_at: state.last_checked_at,
            check_status: state.check_status,
            created_at: state.created_at,
            updated_at: state.updated_at,
        }
    }
}

#[tauri::command]
pub async fn get_sync_status(
    state: tauri::State<'_, AppState>,
) -> Result<SyncStatusResponse, String> {
    let sync_state = state.db.get_sync_state()?;
    Ok(SyncStatusResponse::from(sync_state))
}

#[tauri::command]
pub async fn start_asset_sync(
    state: tauri::State<'_, crate::AppState>,
) -> Result<SyncStatusResponse, String> {
    log::warn!("start_asset_sync invoked");
    start_asset_sync_internal(state, false).await
}

#[tauri::command]
pub async fn force_full_asset_sync(
    state: tauri::State<'_, crate::AppState>,
) -> Result<SyncStatusResponse, String> {
    log::warn!("force_full_asset_sync invoked");
    start_asset_sync_internal(state, true).await
}

async fn start_asset_sync_internal(
    state: tauri::State<'_, crate::AppState>,
    force_full_sync: bool,
) -> Result<SyncStatusResponse, String> {
    log::warn!(
        "start_asset_sync_internal(force_full_sync={})",
        force_full_sync
    );

    // Local-first: never hard-fail a sync attempt when the server is simply
    // unreachable. Surface a recognizable offline marker so the UI can show an
    // offline state instead of a scary error, and leave the cache untouched.
    if let Ok(Some((server_url, _token, _is_oauth))) = state.db.get_auth_credentials() {
        if !state.immich.ping(&server_url).await {
            log::warn!("[sync] server unreachable — skipping sync (offline)");
            return Err("offline: server unreachable".to_string());
        }
    }

    // Get total asset count from Immich
    let statistics = state.immich.get_asset_statistics().await.map_err(|err| {
        log::warn!("Failed to get asset statistics: {}", err);
        format!("Failed to get asset statistics: {}", err)
    })?;

    log::warn!("Got statistics, total assets: {}", statistics.total);

    let current_state = state.db.get_sync_state().map_err(|err| {
        log::warn!("Failed to get sync state: {}", err);
        format!("Failed to get sync state: {}", err)
    })?;

    let is_partial_sync = !force_full_sync
        && current_state.processed_assets > 0
        && current_state.processed_assets < statistics.total;

    log::warn!(
        "[sync] start_asset_sync_internal: force_full_sync={} resuming_partial={} (cached processed={} server_total={})",
        force_full_sync,
        is_partial_sync,
        current_state.processed_assets,
        statistics.total
    );

    // Initialize or resume sync state in database
    let sync_state = if is_partial_sync {
        state
            .db
            .resume_sync_state(statistics.total)
            .map_err(|err| {
                log::warn!("Failed to resume sync state: {}", err);
                format!("Failed to resume sync state: {}", err)
            })?
    } else {
        state.db.init_sync_state(statistics.total).map_err(|err| {
            log::warn!("Failed to initialize sync state: {}", err);
            format!("Failed to initialize sync state: {}", err)
        })?
    };

    log::warn!(
        "Sync state ready (processed: {} / {})",
        sync_state.processed_assets, sync_state.total_assets
    );

    let page_size = 100u32;
    let start_page = if is_partial_sync {
        (sync_state.processed_assets as u32) / page_size
    } else {
        0
    };

    // Spawn background task to fetch and save assets
    let db = state.db.clone();
    let immich = state.immich.clone();

    tauri::async_runtime::spawn(async move {
        log::warn!("Starting background sync task from page {}", start_page);
        if let Err(e) =
            sync_all_assets_background(immich, db, start_page, sync_state.processed_assets).await
        {
            log::warn!("Background sync task failed: {}", e);
        }
    });

    Ok(SyncStatusResponse::from(sync_state))
}

async fn sync_all_assets_background(
    immich: std::sync::Arc<crate::services::immich_client::ImmichClient>,
    db: std::sync::Arc<crate::services::db::Database>,
    start_page: u32,
    initial_processed_count: i32,
) -> Result<(), String> {
    // On a fresh full sync (start_page == 0) we refresh the people list and the
    // album caches up front. On a RESUMED sync (start_page > 0) those already
    // completed during the original run — they run before any asset page is
    // processed, so a non-zero start_page proves they finished — and only the
    // asset page loop was interrupted. Skipping them lets a resumed sync jump
    // straight back to the page where it stopped instead of redoing all that
    // work (which would otherwise look like a full restart).
    let is_resume = start_page > 0;
    if is_resume {
        log::warn!(
            "[sync] resuming interrupted full sync at page {} ({} assets already processed) — skipping people/album refresh",
            start_page,
            initial_processed_count
        );
    } else {
        match immich.get_all_people().await {
            Ok(people) => {
                if let Err(err) = db.upsert_people(&people) {
                    log::warn!("Failed to cache people list: {}", err);
                }
            }
            Err(err) => log::warn!("Failed to fetch people list: {}", err),
        }

        if let Err(err) = refresh_album_cache(immich.clone(), db.clone()).await {
            log::warn!("Failed to refresh album cache: {}", err);
        }
    }

    let mut page = start_page;
    let page_size = 100u32;
    let mut processed_count = initial_processed_count;

    loop {
        log::warn!("Fetching page {} of assets", page);

        // Fetch a page of assets
        let result = immich
            .get_all_assets_paginated(page, page_size)
            .await
            .map_err(|err| {
                log::warn!("Failed to fetch assets: {}", err);
                format!("Failed to fetch assets: {}", err)
            })?;

        if result.items.is_empty() {
            log::warn!("No more assets to fetch");
            break;
        }

        log::warn!("Got {} assets in page {}", result.items.len(), page);

        // Hydrate each asset with full metadata from asset detail endpoint.
        let enriched_assets = enrich_assets_with_full_metadata(immich.clone(), result.items).await;
        let extended_assets: Vec<crate::services::db::AssetSummaryExtended> = enriched_assets
            .iter()
            .map(|value| value.asset.clone())
            .collect();
        let asset_people_links: Vec<(String, Vec<String>)> = enriched_assets
            .iter()
            .map(|value| (value.asset.id.clone(), value.person_ids.clone()))
            .collect();

        // Save assets to database
        db.upsert_assets_with_metadata(&extended_assets)
            .map_err(|err| {
                log::warn!("Failed to save assets: {}", err);
                format!("Failed to save assets: {}", err)
            })?;

        db.replace_asset_people(&asset_people_links)
            .map_err(|err| {
                log::warn!("Failed to save asset-people links: {}", err);
                format!("Failed to save asset-people links: {}", err)
            })?;

        processed_count += extended_assets.len() as i32;
        log::warn!("Processed {} total assets", processed_count);

        // Update progress in database
        db.update_sync_progress(processed_count).map_err(|err| {
            log::warn!("Failed to update sync progress: {}", err);
            format!("Failed to update sync progress: {}", err)
        })?;

        if !result.has_next_page {
            log::warn!("No more pages to fetch");
            break;
        }

        page += 1;
    }

    // Mark sync as complete
    log::warn!("Sync complete, marking as finished");
    db.complete_sync().map_err(|err| {
        log::warn!("Failed to complete sync: {}", err);
        format!("Failed to complete sync: {}", err)
    })?;

    log::warn!("Background sync task completed successfully");
    Ok(())
}

async fn refresh_album_cache(
    immich: std::sync::Arc<crate::services::immich_client::ImmichClient>,
    db: std::sync::Arc<crate::services::db::Database>,
) -> Result<(), String> {
    let albums = immich
        .get_albums()
        .await
        .map_err(|err| format!("fetch albums failed: {}", err))?;

    db.upsert_albums(&albums)
        .map_err(|err| format!("cache album list failed: {}", err))?;

    for album in &albums {
        if let Err(err) = refresh_single_album(immich.clone(), db.clone(), &album.id).await {
            log::warn!("Failed to refresh album {}: {}", album.id, err);
        }
    }

    Ok(())
}

/// Refresh the cached assets (and people/album links) for a single album from
/// the server. Used both by the full album-cache refresh and by the on-demand
/// lazy refresh triggered when the user opens an album.
async fn refresh_single_album(
    immich: std::sync::Arc<crate::services::immich_client::ImmichClient>,
    db: std::sync::Arc<crate::services::db::Database>,
    album_id: &str,
) -> Result<(), String> {
    let assets = immich
        .get_album_assets(album_id)
        .await
        .map_err(|err| format!("fetch album assets failed: {}", err))?;

    log::warn!(
        "[refresh_single_album] album_id={} fetched {} assets",
        album_id,
        assets.len()
    );

    // Enrich assets with full metadata (exif, people, tags, etc.)
    let enrich_started_at = Instant::now();
    let enriched_assets = enrich_assets_with_full_metadata(immich.clone(), assets.clone()).await;
    log::warn!(
        "[refresh_single_album] album_id={} enriched_count={} duration_ms={}",
        album_id,
        enriched_assets.len(),
        enrich_started_at.elapsed().as_millis()
    );

    // Extract extended assets and people links
    let extended_assets: Vec<crate::services::db::AssetSummaryExtended> = enriched_assets
        .iter()
        .map(|value| value.asset.clone())
        .collect();
    let asset_people_links: Vec<(String, Vec<String>)> = enriched_assets
        .iter()
        .map(|value| (value.asset.id.clone(), value.person_ids.clone()))
        .collect();

    // Store enriched assets in database
    db.upsert_assets_with_metadata(&extended_assets)
        .map_err(|err| format!("cache album assets failed: {}", err))?;

    // Store people-asset links
    if let Err(err) = db.replace_asset_people(&asset_people_links) {
        log::warn!(
            "Failed to cache asset-people links for album {}: {}",
            album_id, err
        );
    }

    // Store album-asset relationships
    let asset_ids = extended_assets
        .iter()
        .map(|asset| asset.id.clone())
        .collect::<Vec<_>>();
    if let Err(err) = db.replace_album_assets(album_id, &asset_ids) {
        log::warn!(
            "Failed to cache album asset links for album {}: {}",
            album_id, err
        );
    }

    log::warn!(
        "[refresh_single_album] album_id={} completed successfully",
        album_id
    );

    Ok(())
}

/// Lazily refresh a single album's assets from the server (local-first).
///
/// Called when the user opens an album. The UI renders from the local cache
/// first; this command updates that cache in the background. When the server is
/// unreachable it returns an `offline:`-prefixed marker so the caller can keep
/// showing cached content instead of surfacing an error.
#[tauri::command]
pub async fn refresh_album_assets(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log::warn!("[sync.refresh_album_assets] album_id={} start", album_id);

    if let Ok(Some((server_url, _token, _is_oauth))) = state.db.get_auth_credentials() {
        if !state.immich.ping(&server_url).await {
            log::warn!(
                "[sync.refresh_album_assets] server unreachable — skipping (offline) album_id={}",
                album_id
            );
            return Err("offline: server unreachable".to_string());
        }
    }

    refresh_single_album(state.immich.clone(), state.db.clone(), &album_id).await?;

    log::warn!("[sync.refresh_album_assets] album_id={} done", album_id);
    Ok(())
}

/// Refresh only the album LIST metadata (names, counts, ownership, etc.) and
/// cache it locally. This does not refresh each album's assets.
#[tauri::command]
pub async fn refresh_album_list(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let started_at = Instant::now();
    log::warn!("[sync.refresh_album_list] start");

    if let Ok(Some((server_url, _token, _is_oauth))) = state.db.get_auth_credentials() {
        if !state.immich.ping(&server_url).await {
            log::warn!("[sync.refresh_album_list] server unreachable — skipping (offline)");
            return Err("offline: server unreachable".to_string());
        }
    }

    let albums = state
        .immich
        .get_albums()
        .await
        .map_err(|err| format!("fetch albums failed: {err}"))?;

    state
        .db
        .upsert_albums(&albums)
        .map_err(|err| format!("cache album list failed: {err}"))?;

    log::warn!(
        "[sync.refresh_album_list] complete album_count={} duration_ms={}",
        albums.len(),
        started_at.elapsed().as_millis()
    );

    Ok(albums.len() as u32)
}

#[tauri::command]
pub async fn scan_saved_local_files(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let tracked = state.db.list_local_saved_assets()?;
    let mut created_changes = 0u32;

    for item in tracked {
        let path = Path::new(&item.local_path);
        if !path.exists() {
            let details_json = json!({
                "previousMtimeMs": item.last_known_mtime_ms,
                "previousSizeBytes": item.last_known_size_bytes,
                "message": "File deleted locally"
            })
            .to_string();
            state.db.upsert_unresolved_local_saved_asset_change(
                &item.asset_id,
                &item.local_path,
                &item.file_name,
                "deleted",
                &details_json,
            )?;
            created_changes += 1;
            continue;
        }

        let (current_mtime_ms, current_size_bytes) = get_file_snapshot(path);
        let changed = current_mtime_ms != item.last_known_mtime_ms
            || current_size_bytes != item.last_known_size_bytes;

        if changed {
            let details_json = json!({
                "previousMtimeMs": item.last_known_mtime_ms,
                "currentMtimeMs": current_mtime_ms,
                "previousSizeBytes": item.last_known_size_bytes,
                "currentSizeBytes": current_size_bytes,
                "message": "File metadata changed locally"
            })
            .to_string();
            state.db.upsert_unresolved_local_saved_asset_change(
                &item.asset_id,
                &item.local_path,
                &item.file_name,
                "modified",
                &details_json,
            )?;
            created_changes += 1;
        } else {
            state
                .db
                .resolve_unresolved_local_saved_asset_change(&item.asset_id, &item.local_path, "deleted")?;
            state
                .db
                .resolve_unresolved_local_saved_asset_change(&item.asset_id, &item.local_path, "modified")?;
        }
    }

    Ok(created_changes)
}

#[tauri::command]
pub async fn get_saved_local_file_changes(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LocalSavedFileChangeResponse>, String> {
    let changes = state.db.list_unresolved_local_saved_asset_changes()?;
    Ok(changes
        .into_iter()
        .map(|item| LocalSavedFileChangeResponse {
            id: item.id,
            asset_id: item.asset_id,
            local_path: item.local_path,
            file_name: item.file_name,
            change_kind: item.change_kind,
            details_json: item.details_json,
            detected_at: item.detected_at,
        })
        .collect())
}

#[tauri::command]
pub async fn apply_saved_local_file_changes(
    input: ApplySavedLocalFileChangesInput,
    state: tauri::State<'_, AppState>,
) -> Result<ApplySavedLocalFileChangesResult, String> {
    let mut applied_count = 0u32;
    let mut failed_count = 0u32;
    let mut errors = Vec::new();

    for change_id in input.change_ids {
        let Some(change) = state.db.get_local_saved_asset_change_by_id(change_id)? else {
            continue;
        };

        if change.resolved_at.is_some() {
            continue;
        }

        match change.change_kind.as_str() {
            "deleted" => {
                // Archive in local cache immediately.
                if let Err(err) = state.db.update_asset_visibility(&change.asset_id, "archive") {
                    failed_count += 1;
                    errors.push(format!(
                        "failed to update local visibility for asset {}: {}",
                        change.asset_id, err
                    ));
                    continue;
                }

                // Try server update; if unreachable enqueue mutation.
                match state
                    .immich
                    .update_asset_visibility(&change.asset_id, "archive")
                    .await
                {
                    Ok(_) => {}
                    Err(err) => {
                        let server_reachable = if let Ok(Some((server_url, _token, _is_oauth))) =
                            state.db.get_auth_credentials()
                        {
                            state.immich.ping(&server_url).await
                        } else {
                            false
                        };

                        if server_reachable {
                            log::warn!(
                                "[sync.apply_saved_local_file_changes] archive rejected while online asset_id={} err={}",
                                change.asset_id,
                                err
                            );
                            failed_count += 1;
                            let err_lc = err.to_ascii_lowercase();
                            let reason = if err_lc.contains("asset.update access") {
                                "asset update permission denied (shared/read-only asset)".to_string()
                            } else {
                                err.clone()
                            };
                            errors.push(format!(
                                "failed to archive asset {} while server is reachable: {}",
                                change.asset_id, reason
                            ));
                            continue;
                        }

                        let payload_json = json!({ "visibility": "archive" }).to_string();
                        log::warn!(
                            "[sync.apply_saved_local_file_changes] offline while archiving asset_id={} queueing mutation",
                            change.asset_id
                        );
                        if let Err(queue_err) = state
                            .db
                            .enqueue_mutation(&change.asset_id, "visibility", &payload_json)
                        {
                            failed_count += 1;
                            errors.push(format!(
                                "failed to archive asset {} offline and queue mutation: {} / {}",
                                change.asset_id, err, queue_err
                            ));
                            continue;
                        }
                    }
                }

                // Remove all tracked local copies for this asset from disk.
                match state.db.list_local_saved_asset_paths_for_asset(&change.asset_id) {
                    Ok(paths) => {
                        for path in paths {
                            if let Err(err) = fs::remove_file(&path) {
                                if Path::new(&path).exists() {
                                    log::warn!(
                                        "[saved-local-files] failed to delete path={} err={}",
                                        path,
                                        err
                                    );
                                }
                            }
                        }
                    }
                    Err(err) => {
                        log::warn!(
                            "[saved-local-files] failed to list tracked paths for asset={} err={}",
                            change.asset_id,
                            err
                        );
                    }
                }

                if let Err(err) = state.db.delete_local_saved_assets_for_asset(&change.asset_id) {
                    failed_count += 1;
                    errors.push(format!(
                        "failed to clear tracked local copies for asset {}: {}",
                        change.asset_id, err
                    ));
                    continue;
                }

                if let Err(err) = state
                    .db
                    .resolve_local_saved_asset_changes_by_ids(&[change.id])
                {
                    failed_count += 1;
                    errors.push(format!(
                        "failed to resolve change {}: {}",
                        change.id, err
                    ));
                    continue;
                }

                applied_count += 1;
            }
            "modified" => {
                let path = Path::new(&change.local_path);
                let (mtime_ms, size_bytes) = get_file_snapshot(path);
                if let Err(err) = state.db.update_local_saved_asset_snapshot(
                    &change.asset_id,
                    &change.local_path,
                    mtime_ms,
                    size_bytes,
                ) {
                    failed_count += 1;
                    errors.push(format!(
                        "failed to update local snapshot for asset {}: {}",
                        change.asset_id, err
                    ));
                    continue;
                }

                // Record the applied local metadata drift on the asset
                // description so the change is reflected both in local cache
                // and on the Immich server (or queued if offline).
                let applied_note = format!(
                    "[local-file-sync] Applied local file metadata change for '{}' (path: {}).",
                    change.file_name, change.local_path
                );
                let next_description = match state.db.get_asset_details(&change.asset_id) {
                    Ok(Some(details)) => match details.description {
                        Some(existing) if !existing.trim().is_empty() => {
                            format!("{}\n\n{}", existing, applied_note)
                        }
                        _ => applied_note.clone(),
                    },
                    _ => applied_note.clone(),
                };

                if let Err(err) = state
                    .db
                    .update_asset_description(&change.asset_id, Some(&next_description))
                {
                    failed_count += 1;
                    errors.push(format!(
                        "failed to persist local metadata note for asset {}: {}",
                        change.asset_id, err
                    ));
                    continue;
                }

                match state
                    .immich
                    .update_asset_description(&change.asset_id, Some(next_description.as_str()))
                    .await
                {
                    Ok(_) => {}
                    Err(err) => {
                        let server_reachable = if let Ok(Some((server_url, _token, _is_oauth))) =
                            state.db.get_auth_credentials()
                        {
                            state.immich.ping(&server_url).await
                        } else {
                            false
                        };

                        if server_reachable {
                            log::warn!(
                                "[sync.apply_saved_local_file_changes] metadata-note update rejected while online asset_id={} err={}",
                                change.asset_id,
                                err
                            );
                            failed_count += 1;
                            let err_lc = err.to_ascii_lowercase();
                            let reason = if err_lc.contains("asset.update access") {
                                "asset update permission denied (shared/read-only asset)".to_string()
                            } else {
                                err.clone()
                            };
                            errors.push(format!(
                                "failed to update asset {} metadata note while server is reachable: {}",
                                change.asset_id, reason
                            ));
                            continue;
                        }

                        let payload_json =
                            json!({ "description": next_description }).to_string();
                        log::warn!(
                            "[sync.apply_saved_local_file_changes] offline while updating metadata note asset_id={} queueing mutation",
                            change.asset_id
                        );
                        if let Err(queue_err) = state
                            .db
                            .enqueue_mutation(&change.asset_id, "description", &payload_json)
                        {
                            failed_count += 1;
                            errors.push(format!(
                                "failed to queue metadata-note mutation for asset {} offline: {} / {}",
                                change.asset_id, err, queue_err
                            ));
                            continue;
                        }
                    }
                }

                if let Err(err) = state
                    .db
                    .resolve_local_saved_asset_changes_by_ids(&[change.id])
                {
                    failed_count += 1;
                    errors.push(format!(
                        "failed to resolve change {}: {}",
                        change.id, err
                    ));
                    continue;
                }

                applied_count += 1;
            }
            other => {
                failed_count += 1;
                errors.push(format!("unsupported change kind for {}: {}", change.id, other));
            }
        }
    }

    Ok(ApplySavedLocalFileChangesResult {
        applied_count,
        failed_count,
        errors,
    })
}

#[tauri::command]
pub async fn check_for_new_assets(
    state: tauri::State<'_, AppState>,
) -> Result<SyncStatusResponse, String> {
    let check_started_at = Instant::now();
    log::warn!("[sync.check_for_new_assets] start (quick sync)");

    // Local-first: never hard-fail when the server is simply unreachable. Surface
    // a recognizable offline marker so the UI keeps showing cached content.
    if let Ok(Some((server_url, _token, _is_oauth))) = state.db.get_auth_credentials() {
        if !state.immich.ping(&server_url).await {
            log::warn!("[sync.check_for_new_assets] server unreachable — skipping (offline)");
            return Err("offline: server unreachable".to_string());
        }
    }

    // Mark check as in progress
    state.db.start_check()?;
    log::warn!("[sync.check_for_new_assets] status set to checking");

    // Get current statistics from Immich
    let statistics = state.immich.get_asset_statistics().await.map_err(|_| {
        // Mark check as failed
        let _ = state.db.fail_check();
        "Failed to get asset statistics".to_string()
    })?;

    log::warn!(
        "[sync.check_for_new_assets] server statistics total={} photos={:?} videos={:?}",
        statistics.total, statistics.photos, statistics.videos
    );

    // Get current sync state
    let current_state = state.db.get_sync_state().map_err(|err| {
        let _ = state.db.fail_check();
        format!("Failed to get sync state: {}", err)
    })?;

    log::warn!(
        "[sync.check_for_new_assets] current sync state total_assets={} processed_assets={} is_syncing={} check_status={}",
        current_state.total_assets,
        current_state.processed_assets,
        current_state.is_syncing,
        current_state.check_status
    );

    // Quick sync is intentionally cheap: it only scans the newest assets (which
    // the metadata search returns first) and stops as soon as it reaches a page
    // made entirely of assets we already cache. It does NOT re-enrich the whole
    // library and does NOT refresh every album — albums/calendar months are
    // refreshed lazily when the user opens them, and a full re-scan is only done
    // via "Force Full Sync". This is what keeps the app from continuously
    // re-syncing all files.
    const QUICK_SYNC_MAX_PAGES: u32 = 10;
    const QUICK_SYNC_OVERLAP_HOURS: i64 = 24;

    // Refresh the people list once (single cheap request) so faces on any newly
    // discovered assets resolve correctly.
    let people_started_at = Instant::now();
    if let Ok(people) = state.immich.get_all_people().await {
        let people_count = people.len();
        let _ = state.db.upsert_people(&people);
        log::warn!(
            "[sync.check_for_new_assets] refreshed people count={} duration_ms={}",
            people_count,
            people_started_at.elapsed().as_millis()
        );
    } else {
        log::warn!(
            "[sync.check_for_new_assets] people refresh failed duration_ms={}",
            people_started_at.elapsed().as_millis()
        );
    }

    let mut page = 0u32;
    let page_size = 100u32;
    let mut total_fetched_items: usize = 0;
    let mut total_written_items: usize = 0;
    let mut total_new_items: usize = 0;
    let mut overlap_window_start: Option<DateTime<Utc>> = None;
    let mut overlap_window_end: Option<DateTime<Utc>> = None;
    let mut overlap_window_reached = false;
    let mut overlap_remote_ids: HashSet<String> = HashSet::new();

    loop {
        let page_started_at = Instant::now();
        log::warn!(
            "[sync.check_for_new_assets] fetching page={} page_size={}",
            page, page_size
        );

        let result = state
            .immich
            .get_all_assets_paginated(page, page_size)
            .await
            .map_err(|err| {
                let _ = state.db.fail_check();
                format!("Failed to fetch assets: {}", err)
            })?;

        let item_count = result.items.len();
        total_fetched_items += item_count;

        let page_timestamps: Vec<DateTime<Utc>> = result
            .items
            .iter()
            .filter_map(|asset| parse_asset_created_at_utc(asset.file_created_at.as_deref()))
            .collect();

        if page == 0 {
            if let Some(latest_on_first_page) = page_timestamps.iter().max().cloned() {
                let window_start = latest_on_first_page - Duration::hours(QUICK_SYNC_OVERLAP_HOURS);
                overlap_window_start = Some(window_start);
                overlap_window_end = Some(latest_on_first_page);
                log::warn!(
                    "[sync.check_for_new_assets] overlap window anchored latest={} window_start={} hours={}",
                    latest_on_first_page.to_rfc3339(),
                    window_start.to_rfc3339(),
                    QUICK_SYNC_OVERLAP_HOURS
                );
            } else {
                log::warn!(
                    "[sync.check_for_new_assets] page=0 had no parseable file_created_at timestamps; overlap-window stop condition disabled"
                );
            }
        }

        if let (Some(window_start), Some(oldest_on_page)) = (
            overlap_window_start,
            page_timestamps.iter().min().cloned(),
        ) {
            if oldest_on_page <= window_start {
                overlap_window_reached = true;
                log::warn!(
                    "[sync.check_for_new_assets] overlap window reached on page={} oldest_on_page={} window_start={}",
                    page,
                    oldest_on_page.to_rfc3339(),
                    window_start.to_rfc3339()
                );
            }
        }

        if let (Some(window_start), Some(window_end)) = (overlap_window_start, overlap_window_end) {
            for asset in &result.items {
                let Some(created_at) = parse_asset_created_at_utc(asset.file_created_at.as_deref()) else {
                    continue;
                };

                if created_at >= window_start && created_at <= window_end {
                    overlap_remote_ids.insert(asset.id.clone());
                }
            }
        }

        log::warn!(
            "[sync.check_for_new_assets] fetched page={} item_count={} has_next_page={} fetch_duration_ms={}",
            page,
            item_count,
            result.has_next_page,
            page_started_at.elapsed().as_millis()
        );

        if result.items.is_empty() {
            log::warn!(
                "[sync.check_for_new_assets] stopping because page {} returned no items",
                page
            );
            break;
        }

        // Determine how many assets on this page are not yet cached. Because the
        // newest assets come first, a page with zero new ids means we have
        // reached already-known territory and can stop early.
        let page_ids: Vec<String> = result.items.iter().map(|asset| asset.id.clone()).collect();
        let new_on_page = state
            .db
            .count_new_asset_ids(&page_ids)
            .unwrap_or(page_ids.len());
        total_new_items += new_on_page;

        // Quick sync must stay cheap. Re-fetching full metadata for every asset
        // on the page means one HTTP request per asset (100/page), which makes
        // the sidebar "Check for New Photos" button appear to hang for tens of
        // seconds even when nothing changed. Only enrich assets that are either
        // genuinely new OR fall inside the recent overlap window (so recent
        // edits to already-cached assets are still picked up). Already-cached
        // assets outside the window are left untouched.
        let existing_ids = state
            .db
            .get_existing_asset_ids(&page_ids)
            .unwrap_or_default();

        let (assets_to_enrich, skipped_cached): (
            Vec<crate::services::immich_client::AssetSummary>,
            usize,
        ) = {
            let mut to_enrich = Vec::with_capacity(result.items.len());
            let mut skipped = 0usize;
            for asset in result.items {
                let is_new = !existing_ids.contains(&asset.id);
                let in_overlap_window = overlap_remote_ids.contains(&asset.id);
                if is_new || in_overlap_window {
                    to_enrich.push(asset);
                } else {
                    skipped += 1;
                }
            }
            (to_enrich, skipped)
        };

        // Hydrate the new / recently-edited assets with full metadata and upsert.
        let enrich_started_at = Instant::now();
        let enriched_assets =
            enrich_assets_with_full_metadata(state.immich.clone(), assets_to_enrich).await;
        log::warn!(
            "[sync.check_for_new_assets] enriched page={} enriched_count={} skipped_cached={} new_on_page={} duration_ms={}",
            page,
            enriched_assets.len(),
            skipped_cached,
            new_on_page,
            enrich_started_at.elapsed().as_millis()
        );

        let extended_assets: Vec<crate::services::db::AssetSummaryExtended> = enriched_assets
            .iter()
            .map(|value| value.asset.clone())
            .collect();
        let asset_people_links: Vec<(String, Vec<String>)> = enriched_assets
            .iter()
            .map(|value| (value.asset.id.clone(), value.person_ids.clone()))
            .collect();

        // Save assets to database
        let write_started_at = Instant::now();
        state
            .db
            .upsert_assets_with_metadata(&extended_assets)
            .map_err(|err| {
                let _ = state.db.fail_check();
                format!("Failed to save assets: {}", err)
            })?;

        state
            .db
            .replace_asset_people(&asset_people_links)
            .map_err(|err| {
                let _ = state.db.fail_check();
                format!("Failed to save asset-people links: {}", err)
            })?;

        total_written_items += extended_assets.len();
        log::warn!(
            "[sync.check_for_new_assets] wrote page={} asset_rows={} people_links={} write_duration_ms={}",
            page,
            extended_assets.len(),
            asset_people_links.len(),
            write_started_at.elapsed().as_millis()
        );

        // Stop once we reach a page that contains nothing new (we've caught up).
        if new_on_page == 0 {
            if overlap_window_start.is_some() && !overlap_window_reached {
                log::warn!(
                    "[sync.check_for_new_assets] continuing despite no new assets on page {}: overlap window not fully scanned yet",
                    page
                );
            } else {
                log::warn!(
                    "[sync.check_for_new_assets] stopping early: page {} had no new assets and overlap window is covered",
                    page
                );
                break;
            }
        }

        if !result.has_next_page {
            log::warn!(
                "[sync.check_for_new_assets] stopping because has_next_page=false on page={}",
                page
            );
            break;
        }

        page += 1;
        if page >= QUICK_SYNC_MAX_PAGES {
            log::warn!(
                "[sync.check_for_new_assets] stopping at quick-sync page cap ({} pages). Run a full sync to scan everything.",
                QUICK_SYNC_MAX_PAGES
            );
            break;
        }
    }

    if let (Some(window_start), Some(window_end)) = (overlap_window_start, overlap_window_end) {
        if overlap_window_reached {
            let prune_started_at = Instant::now();
            let local_ids = state
                .db
                .get_asset_ids_in_created_at_window(
                    &window_start.to_rfc3339(),
                    &window_end.to_rfc3339(),
                )
                .map_err(|err| {
                    let _ = state.db.fail_check();
                    format!("Failed to list local assets for quick-sync prune: {}", err)
                })?;

            let stale_ids: Vec<String> = local_ids
                .into_iter()
                .filter(|id| !overlap_remote_ids.contains(id))
                .collect();

            if stale_ids.is_empty() {
                log::warn!(
                    "[sync.check_for_new_assets] prune overlap window found no stale assets duration_ms={}",
                    prune_started_at.elapsed().as_millis()
                );
            } else {
                let deleted_count = state
                    .db
                    .delete_assets_and_links_by_ids(&stale_ids)
                    .map_err(|err| {
                        let _ = state.db.fail_check();
                        format!("Failed to prune deleted assets during quick sync: {}", err)
                    })?;

                log::warn!(
                    "[sync.check_for_new_assets] pruned stale assets in overlap window stale_count={} deleted_rows={} duration_ms={}",
                    stale_ids.len(),
                    deleted_count,
                    prune_started_at.elapsed().as_millis()
                );
            }
        } else {
            log::warn!(
                "[sync.check_for_new_assets] skipped overlap-window prune because overlap window was not fully scanned"
            );
        }
    }

    // Complete the check
    let updated_state = state.db.complete_check(statistics.total)?;
    log::warn!(
        "[sync.check_for_new_assets] complete fetched_items={} written_items={} new_items={} duration_ms={}",
        total_fetched_items,
        total_written_items,
        total_new_items,
        check_started_at.elapsed().as_millis()
    );
    Ok(SyncStatusResponse::from(updated_state))
}

async fn enrich_assets_with_full_metadata(
    immich: std::sync::Arc<crate::services::immich_client::ImmichClient>,
    assets: Vec<crate::services::immich_client::AssetSummary>,
) -> Vec<EnrichedAssetRecord> {
    const MAX_CONCURRENT_METADATA_REQUESTS: usize = 8;

    let total_assets = assets.len();
    let semaphore = std::sync::Arc::new(Semaphore::new(MAX_CONCURRENT_METADATA_REQUESTS));
    let mut join_set = JoinSet::new();

    for asset in assets {
        let immich_client = immich.clone();
        let semaphore_ref = semaphore.clone();

        join_set.spawn(async move {
            let _permit = semaphore_ref.acquire_owned().await.ok();

            let metadata = match immich_client.get_asset_metadata(&asset.id).await {
                Ok(value) => value,
                Err(err) => {
                    log::warn!(
                        "Failed to fetch metadata for asset {}: {}. Falling back to summary fields.",
                        asset.id, err
                    );
                    return to_enriched_asset_record(asset, None);
                }
            };

            to_enriched_asset_record(asset, Some(metadata))
        });
    }

    let mut enriched_assets = Vec::with_capacity(total_assets);
    while let Some(join_result) = join_set.join_next().await {
        match join_result {
            Ok(asset) => enriched_assets.push(asset),
            Err(err) => log::warn!("Metadata enrichment task join failed: {}", err),
        }
    }

    enriched_assets
}

fn get_file_snapshot(path: &Path) -> (Option<i64>, Option<i64>) {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(_) => return (None, None),
    };

    let size_bytes = i64::try_from(metadata.len()).ok();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_millis()).ok());

    (mtime_ms, size_bytes)
}

#[derive(Debug, Clone)]
struct EnrichedAssetRecord {
    asset: crate::services::db::AssetSummaryExtended,
    person_ids: Vec<String>,
}

fn to_enriched_asset_record(
    asset: crate::services::immich_client::AssetSummary,
    metadata: Option<crate::services::immich_client::AssetMetadata>,
) -> EnrichedAssetRecord {
    EnrichedAssetRecord {
        asset: crate::services::db::AssetSummaryExtended {
            id: asset.id,
            original_file_name: asset.original_file_name.clone(),
            description: metadata.as_ref().and_then(|m| m.description.clone()),
            original_path: metadata
                .as_ref()
                .and_then(|m| m.original_path.clone())
                .or(asset.original_path),
            file_created_at: asset.file_created_at,
            checksum: asset.checksum,
            r#type: asset.r#type,
            duration: asset.duration,
            is_favorite: asset.is_favorite,
            is_archived: asset.is_archived,
            visibility: asset.visibility,
            rating: metadata.as_ref().and_then(|m| m.rating).or(asset.rating),
            width: metadata.as_ref().and_then(|m| m.width).or(asset.width),
            height: metadata.as_ref().and_then(|m| m.height).or(asset.height),
            thumbhash: asset.thumbhash,
            camera: metadata.as_ref().and_then(|m| m.camera.clone()),
            lens: metadata.as_ref().and_then(|m| m.lens.clone()),
            file_size_bytes: metadata.as_ref().and_then(|m| m.file_size_bytes),
            file_extension: metadata.as_ref().and_then(|m| m.file_extension.clone()),
            people: metadata.as_ref().and_then(|m| m.people.clone()),
            tags: metadata.as_ref().and_then(|m| m.tags.clone()),
            exif_info_json: metadata.as_ref().and_then(|m| m.exif_info_json.clone()),
            is_my_photo: false,
        },
        person_ids: metadata
            .as_ref()
            .map(|m| m.person_ids.clone())
            .unwrap_or_default(),
    }
}

fn parse_asset_created_at_utc(value: Option<&str>) -> Option<DateTime<Utc>> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }

    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}
