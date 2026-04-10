use serde::Serialize;
use crate::services::db::SyncState;
use crate::AppState;
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
pub async fn get_sync_status(state: tauri::State<'_, AppState>) -> Result<SyncStatusResponse, String> {
    let sync_state = state.db.get_sync_state()?;
    Ok(SyncStatusResponse::from(sync_state))
}

#[tauri::command]
pub async fn start_asset_sync(state: tauri::State<'_, crate::AppState>) -> Result<SyncStatusResponse, String> {
    eprintln!("start_asset_sync invoked");
    start_asset_sync_internal(state, false).await
}

#[tauri::command]
pub async fn force_full_asset_sync(state: tauri::State<'_, crate::AppState>) -> Result<SyncStatusResponse, String> {
    eprintln!("force_full_asset_sync invoked");
    start_asset_sync_internal(state, true).await
}

async fn start_asset_sync_internal(
    state: tauri::State<'_, crate::AppState>,
    force_full_sync: bool,
) -> Result<SyncStatusResponse, String> {
    eprintln!("start_asset_sync_internal(force_full_sync={})", force_full_sync);
    // Get total asset count from Immich
    let statistics = state
        .immich
        .get_asset_statistics()
        .await
        .map_err(|err| {
            eprintln!("Failed to get asset statistics: {}", err);
            format!("Failed to get asset statistics: {}", err)
        })?;

    eprintln!("Got statistics, total assets: {}", statistics.total);

    let current_state = state.db.get_sync_state()
        .map_err(|err| {
            eprintln!("Failed to get sync state: {}", err);
            format!("Failed to get sync state: {}", err)
        })?;

    let is_partial_sync = !force_full_sync
        && current_state.processed_assets > 0
        && current_state.processed_assets < statistics.total;

    // Initialize or resume sync state in database
    let sync_state = if is_partial_sync {
        state.db.resume_sync_state(statistics.total)
            .map_err(|err| {
                eprintln!("Failed to resume sync state: {}", err);
                format!("Failed to resume sync state: {}", err)
            })?
    } else {
        state.db.init_sync_state(statistics.total)
            .map_err(|err| {
                eprintln!("Failed to initialize sync state: {}", err);
                format!("Failed to initialize sync state: {}", err)
            })?
    };

    eprintln!("Sync state ready (processed: {} / {})", sync_state.processed_assets, sync_state.total_assets);

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
        eprintln!("Starting background sync task from page {}", start_page);
        if let Err(e) = sync_all_assets_background(immich, db, start_page, sync_state.processed_assets).await {
            eprintln!("Background sync task failed: {}", e);
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
    match immich.get_all_people().await {
        Ok(people) => {
            if let Err(err) = db.upsert_people(&people) {
                eprintln!("Failed to cache people list: {}", err);
            }
        }
        Err(err) => eprintln!("Failed to fetch people list: {}", err),
    }

    if let Err(err) = refresh_album_cache(immich.clone(), db.clone()).await {
        eprintln!("Failed to refresh album cache: {}", err);
    }

    let mut page = start_page;
    let page_size = 100u32;
    let mut processed_count = initial_processed_count;

    loop {
        eprintln!("Fetching page {} of assets", page);
        
        // Fetch a page of assets
        let result = immich
            .get_all_assets_paginated(page, page_size)
            .await
            .map_err(|err| {
                eprintln!("Failed to fetch assets: {}", err);
                format!("Failed to fetch assets: {}", err)
            })?;

        if result.items.is_empty() {
            eprintln!("No more assets to fetch");
            break;
        }

        eprintln!("Got {} assets in page {}", result.items.len(), page);

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
                eprintln!("Failed to save assets: {}", err);
                format!("Failed to save assets: {}", err)
            })?;

        db.replace_asset_people(&asset_people_links)
            .map_err(|err| {
                eprintln!("Failed to save asset-people links: {}", err);
                format!("Failed to save asset-people links: {}", err)
            })?;

        processed_count += extended_assets.len() as i32;
        eprintln!("Processed {} total assets", processed_count);

        // Update progress in database
        db.update_sync_progress(processed_count)
            .map_err(|err| {
                eprintln!("Failed to update sync progress: {}", err);
                format!("Failed to update sync progress: {}", err)
            })?;

        if !result.has_next_page {
            eprintln!("No more pages to fetch");
            break;
        }

        page += 1;
    }

    // Mark sync as complete
    eprintln!("Sync complete, marking as finished");
    db.complete_sync()
        .map_err(|err| {
            eprintln!("Failed to complete sync: {}", err);
            format!("Failed to complete sync: {}", err)
        })?;

    eprintln!("Background sync task completed successfully");
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
        match immich.get_album_assets(&album.id).await {
            Ok(assets) => {
                eprintln!("[refresh_album_cache] album_id={} fetched {} assets", album.id, assets.len());

                // Enrich assets with full metadata (exif, people, tags, etc.)
                let enrich_started_at = Instant::now();
                let enriched_assets = enrich_assets_with_full_metadata(immich.clone(), assets.clone()).await;
                eprintln!(
                    "[refresh_album_cache] album_id={} enriched_count={} duration_ms={}",
                    album.id,
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
                if let Err(err) = db.upsert_assets_with_metadata(&extended_assets) {
                    eprintln!("Failed to cache album assets for album {}: {}", album.id, err);
                    continue;
                }

                // Store people-asset links
                if let Err(err) = db.replace_asset_people(&asset_people_links) {
                    eprintln!("Failed to cache asset-people links for album {}: {}", album.id, err);
                }

                // Store album-asset relationships
                let asset_ids = extended_assets.iter().map(|asset| asset.id.clone()).collect::<Vec<_>>();
                if let Err(err) = db.replace_album_assets(&album.id, &asset_ids) {
                    eprintln!(
                        "Failed to cache album asset links for album {}: {}",
                        album.id, err
                    );
                }

                eprintln!("[refresh_album_cache] album_id={} completed successfully", album.id);
            }
            Err(err) => {
                eprintln!("Failed to fetch assets for album {}: {}", album.id, err);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn check_for_new_assets(state: tauri::State<'_, AppState>) -> Result<SyncStatusResponse, String> {
    let check_started_at = Instant::now();
    eprintln!("[sync.check_for_new_assets] start");

    // Mark check as in progress
    state.db.start_check()?;
    eprintln!("[sync.check_for_new_assets] status set to checking");

    // Get current statistics from Immich
    let statistics = state
        .immich
        .get_asset_statistics()
        .await
        .map_err(|_| {
            // Mark check as failed
            let _ = state.db.fail_check();
            "Failed to get asset statistics".to_string()
        })?;

    eprintln!(
        "[sync.check_for_new_assets] server statistics total={} photos={:?} videos={:?}",
        statistics.total,
        statistics.photos,
        statistics.videos
    );

    // Get current sync state
    let current_state = state.db.get_sync_state()
        .map_err(|err| {
            let _ = state.db.fail_check();
            format!("Failed to get sync state: {}", err)
        })?;

    eprintln!(
        "[sync.check_for_new_assets] current sync state total_assets={} processed_assets={} is_syncing={} check_status={}",
        current_state.total_assets,
        current_state.processed_assets,
        current_state.is_syncing,
        current_state.check_status
    );

    // Check if there are new assets
    if statistics.total <= current_state.total_assets {
        // No new assets, just update checked timestamp
        let updated_state = state.db.complete_check(statistics.total)?;
        eprintln!(
            "[sync.check_for_new_assets] no new assets detected (server_total={} local_total={}) duration_ms={}",
            statistics.total,
            current_state.total_assets,
            check_started_at.elapsed().as_millis()
        );
        return Ok(SyncStatusResponse::from(updated_state));
    }

    eprintln!(
        "[sync.check_for_new_assets] new assets detected delta={}",
        statistics.total - current_state.total_assets
    );

    // New assets detected - fetch them in the background
    // Sync new assets in the foreground for now to keep it simple
    let people_started_at = Instant::now();
    if let Ok(people) = state.immich.get_all_people().await {
        let people_count = people.len();
        let _ = state.db.upsert_people(&people);
        eprintln!(
            "[sync.check_for_new_assets] refreshed people count={} duration_ms={}",
            people_count,
            people_started_at.elapsed().as_millis()
        );
    } else {
        eprintln!(
            "[sync.check_for_new_assets] people refresh failed duration_ms={}",
            people_started_at.elapsed().as_millis()
        );
    }

    let album_refresh_started_at = Instant::now();
    if let Err(err) = refresh_album_cache(state.immich.clone(), state.db.clone()).await {
        eprintln!("Failed to refresh album cache during new asset check: {}", err);
    } else {
        eprintln!(
            "[sync.check_for_new_assets] album cache refresh done duration_ms={}",
            album_refresh_started_at.elapsed().as_millis()
        );
    }

    let mut page = 0u32;
    let page_size = 100u32;
    let mut total_fetched_items: usize = 0;
    let mut total_written_items: usize = 0;

    loop {
        let page_started_at = Instant::now();
        eprintln!(
            "[sync.check_for_new_assets] fetching page={} page_size={}",
            page,
            page_size
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
        let first_id = result.items.first().map(|asset| asset.id.as_str()).unwrap_or("<none>");
        let last_id = result.items.last().map(|asset| asset.id.as_str()).unwrap_or("<none>");
        total_fetched_items += item_count;

        eprintln!(
            "[sync.check_for_new_assets] fetched page={} item_count={} has_next_page={} first_id={} last_id={} fetch_duration_ms={}",
            page,
            item_count,
            result.has_next_page,
            first_id,
            last_id,
            page_started_at.elapsed().as_millis()
        );

        if result.items.is_empty() {
            eprintln!("[sync.check_for_new_assets] stopping because page {} returned no items", page);
            break;
        }

        // Hydrate each asset with full metadata from asset detail endpoint.
        let enrich_started_at = Instant::now();
        let enriched_assets = enrich_assets_with_full_metadata(state.immich.clone(), result.items).await;
        eprintln!(
            "[sync.check_for_new_assets] enriched page={} enriched_count={} duration_ms={}",
            page,
            enriched_assets.len(),
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
        state.db.upsert_assets_with_metadata(&extended_assets)
            .map_err(|err| {
                let _ = state.db.fail_check();
                format!("Failed to save assets: {}", err)
            })?;

        state.db.replace_asset_people(&asset_people_links)
            .map_err(|err| {
                let _ = state.db.fail_check();
                format!("Failed to save asset-people links: {}", err)
            })?;

        total_written_items += extended_assets.len();
        eprintln!(
            "[sync.check_for_new_assets] wrote page={} asset_rows={} people_links={} write_duration_ms={}",
            page,
            extended_assets.len(),
            asset_people_links.len(),
            write_started_at.elapsed().as_millis()
        );

        if !result.has_next_page {
            eprintln!(
                "[sync.check_for_new_assets] stopping because has_next_page=false on page={}",
                page
            );
            break;
        }

        page += 1;
    }

    // Complete the check
    let updated_state = state.db.complete_check(statistics.total)?;
    eprintln!(
        "[sync.check_for_new_assets] complete fetched_items={} written_items={} duration_ms={}",
        total_fetched_items,
        total_written_items,
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
                    eprintln!(
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
            Err(err) => eprintln!("Metadata enrichment task join failed: {}", err),
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
        rating: metadata
            .as_ref()
            .and_then(|m| m.rating)
            .or(asset.rating),
        width: metadata
            .as_ref()
            .and_then(|m| m.width)
            .or(asset.width),
        height: metadata
            .as_ref()
            .and_then(|m| m.height)
            .or(asset.height),
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
