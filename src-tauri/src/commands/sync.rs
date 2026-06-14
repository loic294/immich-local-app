use crate::services::db::SyncState;
use crate::AppState;
use serde::Serialize;
use std::time::Instant;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

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

        // Hydrate each asset with full metadata and upsert (also refreshes recent
        // edits to already-cached assets on the first page).
        let enrich_started_at = Instant::now();
        let enriched_assets =
            enrich_assets_with_full_metadata(state.immich.clone(), result.items).await;
        log::warn!(
            "[sync.check_for_new_assets] enriched page={} enriched_count={} new_on_page={} duration_ms={}",
            page,
            enriched_assets.len(),
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
            log::warn!(
                "[sync.check_for_new_assets] stopping early: page {} had no new assets (caught up)",
                page
            );
            break;
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
        },
        person_ids: metadata
            .as_ref()
            .map(|m| m.person_ids.clone())
            .unwrap_or_default(),
    }
}
