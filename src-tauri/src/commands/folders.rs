use crate::commands::assets::AssetPage;
use crate::commands::assets::{calculate_grid_layout, GridLayoutAssetInput, GridLayoutResponse};
use crate::services::db::{normalize_folder_path, AssetFilterCriteria, SortParams};
use crate::services::immich_client::ImmichClient;
use crate::AppState;
use std::sync::Arc;
use std::time::Instant;
use tokio::task::JoinSet;

fn is_visible_in_grid(asset: &crate::services::immich_client::AssetSummary) -> bool {
    if asset.is_archived || asset.is_trashed {
        return false;
    }

    let visibility = asset
        .visibility
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    visibility != "archive"
}

#[tauri::command]
pub async fn get_folders_base_directory(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state.db.get_folders_base_directory(&account_id)
}

#[tauri::command]
pub async fn set_folders_base_directory(
    account_id: String,
    base_directory: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    log::info!("[folders.base_directory] saving account_id={account_id}");
    let account_exists = state
        .db
        .list_accounts()?
        .iter()
        .any(|account| account.id == account_id);
    if !account_exists {
        return Err("account not found".into());
    }
    let result = state
        .db
        .set_folders_base_directory(&account_id, &base_directory);
    match &result {
        Ok(path) => {
            log::info!("[folders.base_directory] saved account_id={account_id} path={path}")
        }
        Err(error) => {
            log::error!("[folders.base_directory] save failed account_id={account_id}: {error}")
        }
    }
    result
}

#[tauri::command]
pub async fn get_unique_original_paths(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state
        .db
        .get_unique_original_paths()
        .map_err(|err| format!("folder path cache read failed: {err}"))
}

#[tauri::command]
pub async fn get_folder_assets_paged(
    path: String,
    page: u32,
    page_size: u32,
    criteria: Option<AssetFilterCriteria>,
    sort_field: Option<String>,
    sort_direction: Option<String>,
    recursive: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let sort = SortParams {
        field: sort_field,
        direction: sort_direction,
    };
    let (cached_items, cached_has_next_page) = state
        .db
        .get_folder_assets(
            &path,
            page,
            page_size,
            criteria.as_ref(),
            Some(&sort),
            recursive.unwrap_or(false),
        )
        .map_err(|err| format!("folder asset cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items: cached_items,
        has_next_page: cached_has_next_page,
    })
}

/// Max concurrent `/view/folder` requests while refreshing a folder tree.
const FOLDER_TREE_REFRESH_CONCURRENCY: usize = 4;

/// Server folders inside the `root` tree: `root` itself plus every descendant.
/// `root` is always included so its direct photos refresh even if the server's
/// folder list is stale. Sibling folders sharing a name prefix are excluded.
fn folder_tree_targets(root: &str, server_folders: &[String]) -> Vec<String> {
    let descendant_prefix = format!("{root}/");
    let mut targets = std::collections::BTreeSet::new();
    targets.insert(root.to_string());
    for folder in server_folders {
        let Ok(folder) = normalize_folder_path(folder) else {
            continue;
        };
        if folder == root || folder.starts_with(&descendant_prefix) {
            targets.insert(folder);
        }
    }
    targets.into_iter().collect()
}

/// Fetches every folder in `folders` from one account with bounded concurrency
/// and upserts the assets. Returns `(asset_count, failures)`.
async fn refresh_folder_tree_for_account(
    state: &AppState,
    account_id: &str,
    client: Arc<ImmichClient>,
    folders: Vec<String>,
) -> Result<(u32, Vec<String>), String> {
    let mut refreshed = 0u32;
    let mut failures = Vec::new();
    let mut pending = folders.into_iter();
    let mut tasks = JoinSet::new();
    loop {
        while tasks.len() < FOLDER_TREE_REFRESH_CONCURRENCY {
            let Some(folder) = pending.next() else {
                break;
            };
            let client = client.clone();
            tasks.spawn(async move {
                let result = client.get_assets_by_original_path(&folder).await;
                (folder, result)
            });
        }
        let Some(joined) = tasks.join_next().await else {
            break;
        };
        match joined {
            Ok((_, Ok(assets))) => {
                state
                    .db
                    .upsert_assets(account_id, &assets)
                    .map_err(|err| format!("folder cache write failed: {err}"))?;
                refreshed += assets.len() as u32;
            }
            Ok((folder, Err(err))) => {
                log::warn!(
                    "[folders.refresh_folder_assets] fetch failed account={account_id} folder={folder}: {err}"
                );
                failures.push(format!("account {account_id} folder {folder}: {err}"));
            }
            Err(err) => {
                log::error!(
                    "[folders.refresh_folder_assets] fetch task failed account={account_id}: {err}"
                );
                failures.push(format!("account {account_id}: {err}"));
            }
        }
    }
    Ok((refreshed, failures))
}

/// Lazily refresh a folder and all of its subfolders from the server (local-first).
///
/// Called when a folder-backed view (Phone Photos) opens. The UI renders from the
/// local cache first; this only updates that one folder tree and never triggers a
/// library sync. Returns an `offline:`-prefixed error when no server is reachable.
#[tauri::command]
pub async fn refresh_folder_assets(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<u32, String> {
    let started_at = Instant::now();
    let path = normalize_folder_path(&path)?;
    if path.is_empty() {
        return Err("A folder path is required".into());
    }
    log::info!("[folders.refresh_folder_assets] start path={path}");

    let mut refreshed = 0u32;
    let mut any_online = false;
    let mut failures = Vec::new();
    let mut folder_count = 0usize;
    for (account_id, client) in state.sync_accounts() {
        let server_url = state
            .db
            .get_account(&account_id)
            .ok()
            .flatten()
            .map(|account| account.server_url);
        let online = match &server_url {
            Some(url) => client.ping(url).await,
            None => false,
        };
        if !online {
            log::warn!(
                "[folders.refresh_folder_assets] account {account_id} unreachable — skipping (offline)"
            );
            continue;
        }
        any_online = true;

        let server_folders = match client.get_unique_original_paths().await {
            Ok(folders) => folders,
            Err(err) => {
                log::warn!(
                    "[folders.refresh_folder_assets] folder list failed account={account_id}, refreshing root only: {err}"
                );
                Vec::new()
            }
        };
        let targets = folder_tree_targets(&path, &server_folders);
        log::info!(
            "[folders.refresh_folder_assets] account={account_id} path={path} folders={}",
            targets.len()
        );
        folder_count += targets.len();

        let (count, account_failures) =
            refresh_folder_tree_for_account(&state, &account_id, client, targets).await?;
        refreshed += count;
        failures.extend(account_failures);
    }

    if !any_online {
        return Err("offline: server unreachable".into());
    }
    if refreshed == 0 && !failures.is_empty() {
        return Err(format!("folder refresh failed: {}", failures.join("; ")));
    }

    log::info!(
        "[folders.refresh_folder_assets] done path={path} folders={folder_count} assets={refreshed} failures={} duration_ms={}",
        failures.len(),
        started_at.elapsed().as_millis()
    );
    Ok(refreshed)
}

#[tauri::command]
pub async fn get_cached_folder_full_grid_layout(
    path: String,
    container_width: f64,
    criteria: Option<AssetFilterCriteria>,
    sort_field: Option<String>,
    sort_direction: Option<String>,
    recursive: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<GridLayoutResponse, String> {
    let started_at = Instant::now();
    let recursive = recursive.unwrap_or(false);
    if container_width <= 0.0 {
        return Ok(GridLayoutResponse {
            sections: Vec::new(),
        });
    }

    let sort = SortParams {
        field: sort_field,
        direction: sort_direction,
    };
    let all_assets = state
        .db
        .get_all_folder_assets(&path, criteria.as_ref(), Some(&sort), recursive)
        .map_err(|err| format!("folder full grid layout cache read failed: {err}"))?;

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
        "[folders.get_cached_folder_full_grid_layout] path={} recursive={} container_width={} sections={} duration_ms={}",
        path,
        recursive,
        container_width,
        response.sections.len(),
        started_at.elapsed().as_millis()
    );

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::folder_tree_targets;

    #[test]
    fn folder_tree_targets_include_root_and_all_descendants_only() {
        let server_folders = vec![
            "/nas/Phone/iPhone/2026/09".to_string(),
            "/nas/Phone/iPhone/2026/08/".to_string(),
            r"\nas\Phone\iPhone".to_string(),
            "/nas/Phone".to_string(),
            "/nas/Phone 2/2026".to_string(),
            "/nas/Phones".to_string(),
            "/other".to_string(),
        ];
        assert_eq!(
            folder_tree_targets("/nas/Phone", &server_folders),
            vec![
                "/nas/Phone",
                "/nas/Phone/iPhone",
                "/nas/Phone/iPhone/2026/08",
                "/nas/Phone/iPhone/2026/09",
            ]
        );
        assert_eq!(folder_tree_targets("/nas/Phone", &[]), vec!["/nas/Phone"]);
    }
}
