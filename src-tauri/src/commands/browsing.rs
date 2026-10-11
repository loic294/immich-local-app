use crate::commands::assets::{calculate_grid_layout, GridLayoutAssetInput, GridLayoutResponse};
use crate::services::browsing::{BrowsingPerson, MapBounds, MapMarker};
use crate::services::immich_client::AssetSummary;
use crate::AppState;

fn finish_map_refresh(
    refreshed: usize,
    mut failures: Vec<String>,
    offline: Vec<String>,
) -> Result<usize, String> {
    if !failures.is_empty() {
        failures.extend(offline);
        let error = format!(
            "map refresh failed; {refreshed} refreshed, failures: {}",
            failures.join("; ")
        );
        log::warn!("[browsing.map] {error}");
        return Err(error);
    }
    if !offline.is_empty() {
        let error = format!(
            "offline: map refresh incomplete; {refreshed} refreshed, {}",
            offline.join("; ")
        );
        log::warn!("[browsing.map] {error}");
        return Err(error);
    }
    log::info!("[browsing.map] bounded refresh complete count={refreshed}");
    Ok(refreshed)
}

#[tauri::command]
pub async fn get_cached_people(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BrowsingPerson>, String> {
    state.db.browsing_people()
}

#[tauri::command]
pub async fn refresh_people(state: tauri::State<'_, AppState>) -> Result<(), String> {
    log::info!("[browsing.people] refresh start");
    let mut refreshed = 0;
    for account in state.db.list_accounts()? {
        let client = state.client_for(Some(&account.id));
        if !client.ping(&account.server_url).await {
            log::info!(
                "[browsing.people] account={} offline; preserving cache",
                account.id
            );
            continue;
        }
        let people = client.get_all_people().await.map_err(|e| {
            log::warn!(
                "[browsing.people] account={} refresh failed: {}",
                account.id,
                e
            );
            e
        })?;
        state.db.upsert_people(&account.id, &people)?;
        refreshed += 1;
        log::info!(
            "[browsing.people] account={} refreshed count={}",
            account.id,
            people.len()
        );
    }
    if refreshed == 0 {
        return Err("offline: people refresh unavailable; using cached people".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_cached_map_markers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MapMarker>, String> {
    state.db.browsing_map_markers()
}

#[tauri::command]
pub async fn get_cached_map_assets(
    bounds: MapBounds,
    asset_ids: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AssetSummary>, String> {
    state.db.browsing_map_assets(&bounds, asset_ids.as_deref())
}

#[tauri::command]
pub async fn get_cached_map_full_grid_layout(
    bounds: MapBounds,
    asset_ids: Option<Vec<String>>,
    container_width: f64,
    state: tauri::State<'_, AppState>,
) -> Result<GridLayoutResponse, String> {
    let assets = state
        .db
        .browsing_map_assets(&bounds, asset_ids.as_deref())?;
    calculate_grid_layout(
        assets
            .into_iter()
            .map(|a| GridLayoutAssetInput {
                id: a.id,
                file_created_at: a.file_created_at,
                r#type: a.r#type,
                width: a.width,
                height: a.height,
                thumbhash: a.thumbhash,
            })
            .collect(),
        container_width,
    )
}

#[tauri::command]
pub async fn refresh_map_assets(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let ids: std::collections::HashSet<_> = asset_ids.into_iter().take(100).collect();
    log::info!("[browsing.map] bounded refresh start count={}", ids.len());
    if ids.is_empty() {
        return Ok(0);
    }
    let mut refreshed = 0;
    let mut failures = Vec::new();
    let mut offline = Vec::new();
    let mut reachability = std::collections::HashMap::new();
    for id in &ids {
        let result = async {
            let account_id = state
                .db
                .get_asset_account_id(id)?
                .ok_or_else(|| "cached asset has no account".to_string())?;
            let account = state
                .db
                .get_account(&account_id)?
                .ok_or_else(|| format!("account={} is not configured", account_id))?;
            let client = state.client_for(Some(&account_id));
            let reachable = if let Some(reachable) = reachability.get(&account_id) {
                *reachable
            } else {
                let reachable = client.ping(&account.server_url).await;
                reachability.insert(account_id.clone(), reachable);
                reachable
            };
            if !reachable {
                return Err("offline: server unreachable; cache preserved".to_string());
            }
            match client.get_asset_metadata(id).await {
                Ok(metadata) => {
                    let Some(mut asset) = state.db.get_asset_details(id)? else {
                        return Err("asset missing from local cache".into());
                    };
                    asset.description = metadata.description;
                    asset.original_path = metadata.original_path.or(asset.original_path);
                    asset.rating = metadata.rating.or(asset.rating);
                    asset.width = metadata.width.or(asset.width);
                    asset.height = metadata.height.or(asset.height);
                    asset.camera = metadata.camera;
                    asset.lens = metadata.lens;
                    asset.file_size_bytes = metadata.file_size_bytes;
                    asset.file_extension = metadata.file_extension;
                    asset.people = metadata.people;
                    asset.tags = metadata.tags;
                    asset.exif_info_json = metadata.exif_info_json;
                    state
                        .db
                        .upsert_assets_with_metadata(&account_id, &[asset])?;
                    state
                        .db
                        .replace_asset_people(&account_id, &[(id.clone(), metadata.person_ids)])?;
                    Ok(())
                }
                Err(e) => {
                    if !client.ping(&account.server_url).await {
                        reachability.insert(account_id, false);
                        Err("offline: server became unreachable; cache preserved".into())
                    } else {
                        Err(e)
                    }
                }
            }
        }
        .await;
        match result {
            Ok(()) => refreshed += 1,
            Err(error) => {
                log::warn!("[browsing.map] asset={} refresh failed: {}", id, error);
                let message = format!("asset={id}: {error}");
                if error.starts_with("offline:") {
                    offline.push(message);
                } else {
                    failures.push(message);
                }
            }
        }
    }
    finish_map_refresh(refreshed, failures, offline)
}

#[cfg(test)]
mod tests {
    use super::finish_map_refresh;
    #[test]
    fn reachable_failures_never_report_success() {
        let error =
            finish_map_refresh(1, vec!["asset=rejected: HTTP 403".into()], vec![]).unwrap_err();
        assert!(error.contains("asset=rejected"));
        assert!(!error.starts_with("offline:"));
        assert!(finish_map_refresh(0, vec!["asset=missing".into()], vec![]).is_err());
    }
    #[test]
    fn offline_failures_keep_recognizable_marker() {
        let error =
            finish_map_refresh(1, vec![], vec!["asset=offline: unreachable".into()]).unwrap_err();
        assert!(error.starts_with("offline:"));
        assert!(error.contains("asset=offline"));
        assert_eq!(finish_map_refresh(2, vec![], vec![]), Ok(2));
    }
}
