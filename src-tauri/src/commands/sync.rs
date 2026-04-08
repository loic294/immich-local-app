use serde::Serialize;
use crate::services::db::SyncState;
use crate::AppState;

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

    let is_partial_sync = current_state.processed_assets > 0
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

        // Convert to extended assets with metadata and save
        let extended_assets: Vec<crate::services::db::AssetSummaryExtended> = result
            .items
            .iter()
            .map(|asset| crate::services::db::AssetSummaryExtended {
                id: asset.id.clone(),
                original_file_name: asset.original_file_name.clone(),
                file_created_at: asset.file_created_at.clone(),
                checksum: asset.checksum.clone(),
                r#type: asset.r#type.clone(),
                duration: asset.duration.clone(),
                is_favorite: asset.is_favorite,
                is_archived: asset.is_archived,
                visibility: asset.visibility.clone(),
                rating: asset.rating,
                camera: None,
                lens: None,
                file_size_bytes: None,
                file_extension: None,
                people: None,
                tags: None,
            })
            .collect();

        // Save assets to database
        db.upsert_assets_with_metadata(&extended_assets)
            .map_err(|err| {
                eprintln!("Failed to save assets: {}", err);
                format!("Failed to save assets: {}", err)
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

#[tauri::command]
pub async fn check_for_new_assets(state: tauri::State<'_, AppState>) -> Result<SyncStatusResponse, String> {
    // Mark check as in progress
    state.db.start_check()?;

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

    // Get current sync state
    let current_state = state.db.get_sync_state()
        .map_err(|err| {
            let _ = state.db.fail_check();
            format!("Failed to get sync state: {}", err)
        })?;

    // Check if there are new assets
    if statistics.total <= current_state.total_assets {
        // No new assets, just update checked timestamp
        let updated_state = state.db.complete_check(statistics.total)?;
        return Ok(SyncStatusResponse::from(updated_state));
    }

    // New assets detected - fetch them in the background
    // Sync new assets in the foreground for now to keep it simple
    let mut page = 0u32;
    let page_size = 100u32;

    loop {
        let result = state
            .immich
            .get_all_assets_paginated(page, page_size)
            .await
            .map_err(|err| {
                let _ = state.db.fail_check();
                format!("Failed to fetch assets: {}", err)
            })?;

        if result.items.is_empty() {
            break;
        }

        // Convert to extended assets with metadata and save
        let extended_assets: Vec<crate::services::db::AssetSummaryExtended> = result
            .items
            .iter()
            .map(|asset| crate::services::db::AssetSummaryExtended {
                id: asset.id.clone(),
                original_file_name: asset.original_file_name.clone(),
                file_created_at: asset.file_created_at.clone(),
                checksum: asset.checksum.clone(),
                r#type: asset.r#type.clone(),
                duration: asset.duration.clone(),
                is_favorite: asset.is_favorite,
                is_archived: asset.is_archived,
                visibility: asset.visibility.clone(),
                rating: asset.rating,
                camera: None,
                lens: None,
                file_size_bytes: None,
                file_extension: None,
                people: None,
                tags: None,
            })
            .collect();

        // Save assets to database
        state.db.upsert_assets_with_metadata(&extended_assets)
            .map_err(|err| {
                let _ = state.db.fail_check();
                format!("Failed to save assets: {}", err)
            })?;

        if !result.has_next_page {
            break;
        }

        page += 1;
    }

    // Complete the check
    let updated_state = state.db.complete_check(statistics.total)?;
    Ok(SyncStatusResponse::from(updated_state))
}
