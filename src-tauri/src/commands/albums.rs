use crate::commands::assets::{
    calculate_grid_layout, AssetPage, GridLayoutAssetInput, GridLayoutResponse,
};
use crate::commands::shell::copy_assets_to_local_folder_internal;
use crate::services::db::{AssetFilterCriteria, SortParams};
use crate::services::immich_client::{
    AlbumOwnerSummary, AlbumShareUser, AlbumSummary, AlbumUserCandidate,
};
use crate::AppState;
use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::time::Instant;
use tauri::Emitter;

#[path = "albums/creation.rs"]
mod creation;
use creation::create_album_with_assets_internal;
#[path = "albums/management.rs"]
mod management;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSaveProgress {
    pub total_assets: u32,
    pub copied_count: u32,
    pub current_file: Option<String>,
    pub status: String,
}

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
pub async fn fetch_albums(state: tauri::State<'_, AppState>) -> Result<Vec<AlbumSummary>, String> {
    let cached = state
        .db
        .get_albums()
        .map_err(|err| format!("album cache read failed: {err}"))?;

    Ok(cached
        .into_iter()
        .map(|album| {
            let owner_id = album.owner_id.clone();

            AlbumSummary {
                id: album.id,
                album_name: album.album_name,
                album_thumbnail_asset_id: album.album_thumbnail_asset_id,
                owner_id,
                shared: album.shared,
                created_at: album.created_at,
                updated_at: album.updated_at,
                start_date: album.start_date,
                end_date: album.end_date,
                asset_count: album.asset_count,
                owner: Some(AlbumOwnerSummary {
                    id: album.owner_id,
                    name: album.owner_name,
                    email: album.owner_email,
                }),
                description: album.description,
                saved_local_folder_path: album.saved_local_folder_path,
                role: None,
                is_read_only: None,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn record_recent_album(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log::info!("[albums.recent] recording album_id={album_id}");
    state.db.record_recent_album(&album_id)
}

#[tauri::command]
pub async fn get_recent_albums(
    limit: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AlbumSummary>, String> {
    let recent = state
        .db
        .get_recent_albums(limit.unwrap_or(5))
        .map_err(|error| format!("recent album cache read failed: {error}"))?;
    Ok(recent
        .into_iter()
        .map(|album| AlbumSummary {
            id: album.id,
            album_name: album.album_name,
            album_thumbnail_asset_id: album.album_thumbnail_asset_id,
            owner_id: album.owner_id.clone(),
            shared: album.shared,
            created_at: album.created_at,
            updated_at: album.updated_at,
            start_date: album.start_date,
            end_date: album.end_date,
            asset_count: album.asset_count,
            owner: Some(AlbumOwnerSummary {
                id: album.owner_id,
                name: album.owner_name,
                email: album.owner_email,
            }),
            description: album.description,
            saved_local_folder_path: album.saved_local_folder_path,
            role: None,
            is_read_only: None,
        })
        .collect())
}

#[tauri::command]
pub async fn get_album_assets_paged(
    album_id: String,
    page: u32,
    page_size: u32,
    criteria: Option<AssetFilterCriteria>,
    sort_field: Option<String>,
    sort_direction: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let sort = SortParams { field: sort_field, direction: sort_direction };
    let (cached_items, cached_has_next_page) = state
        .db
        .get_album_assets(&album_id, page, page_size, criteria.as_ref(), Some(&sort))
        .map_err(|err| format!("album asset cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items: cached_items,
        has_next_page: cached_has_next_page,
    })
}

#[tauri::command]
pub async fn get_cached_album_full_grid_layout(
    album_id: String,
    container_width: f64,
    criteria: Option<AssetFilterCriteria>,
    sort_field: Option<String>,
    sort_direction: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<GridLayoutResponse, String> {
    let started_at = Instant::now();
    if container_width <= 0.0 {
        return Ok(GridLayoutResponse {
            sections: Vec::new(),
        });
    }

    let sort = SortParams { field: sort_field, direction: sort_direction };
    let all_assets = state
        .db
        .get_all_album_assets(&album_id, criteria.as_ref(), Some(&sort))
        .map_err(|err| format!("album full grid layout cache read failed: {err}"))?;

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
        "[albums.get_cached_album_full_grid_layout] album_id={} container_width={} sections={} duration_ms= {}",
        album_id,
        container_width,
        response.sections.len(),
        started_at.elapsed().as_millis()
    );

    Ok(response)
}

#[tauri::command]
pub async fn create_album_with_assets(
    album_name: String,
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<AlbumSummary, String> {
    create_album_with_assets_internal(&album_name, &asset_ids, &state).await
}

#[cfg(test)]
#[path = "albums/creation_tests.rs"]
mod creation_tests;
#[cfg(test)]
#[path = "albums/management_tests.rs"]
mod management_tests;

#[tauri::command]
pub async fn rename_album(
    album_id: String,
    album_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let result = management::rename_album_internal(&album_id, &album_name, &state).await;
    if let Err(error) = &result {
        log::error!("[albums.rename] failed album_id={album_id}: {error}");
    }
    result
}

#[tauri::command]
pub async fn delete_album(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let result = management::delete_album_internal(&album_id, &state).await;
    if let Err(error) = &result {
        log::error!("[albums.delete] failed album_id={album_id}: {error}");
    }
    result
}

#[tauri::command]
pub async fn add_assets_to_album(
    album_id: String,
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let result = add_assets_to_album_internal(&album_id, &asset_ids, &state).await;
    if let Err(error) = &result {
        log::error!("[albums.add-assets] failed album_id={album_id}: {error}");
    }
    result
}

async fn add_assets_to_album_internal(
    album_id: &str,
    asset_ids: &[String],
    state: &AppState,
) -> Result<(), String> {
    if asset_ids.is_empty() {
        return Ok(());
    }
    log::info!("[albums.add-assets] start album_id={album_id} selected_count={}", asset_ids.len());
    let account_id = state.db.get_album_account_id(album_id)?
        .ok_or("Album has no cached account. Refresh the album list before adding photos.")?;
    let mut account = state.db.get_account(&account_id)?
        .ok_or("Album account no longer exists.")?;
    let mut client = creation::account_client(state, &account)?;
    let groups = creation::contributions(state, &account.server_url, asset_ids)?;
    if !client.ping(&account.server_url).await {
        return Err("offline: Connect to the album's server to add photos.".into());
    }
    let groups = creation::resolve_contributors(state, groups).await?;
    let (mut album, users) = client.get_album_sharing(album_id).await?;
    let (configured_owner, mut editors) = creation::configuration(state)?;
    if let Some(owner) = configured_owner.filter(|owner| {
        owner.user_id == album.owner_id
            && owner.server_url.trim_end_matches('/') == account.server_url.trim_end_matches('/')
    }) {
        // Shared-album sync can cache this album under a reader's account.
        // Only the configured, actual owner may change its sharing.
        client = creation::account_client(state, &owner)?;
        account = owner;
    } else {
        editors.clear();
        log::info!("[albums.add-assets] preserving sharing album_id={album_id} owner_is_not_configured=true");
    }
    creation::validate_contributor_access(&album.owner_id, &users, &editors, &groups)?;
    let sharing = creation::ensure_editors(&client, &mut album, &editors, &users).await;
    state.db.upsert_albums(&account.id, std::slice::from_ref(&album))?;
    sharing?;

    let outcome: Result<(), String> = async {
        for group in groups {
            log::info!("[albums.add-assets] contributing album_id={album_id} account_id={} count={}", group.account.id, group.asset_ids.len());
            group.client
                .add_assets_to_album(album_id, &group.asset_ids)
                .await
                .map_err(|error| format!(
                    "Adding photos to album \"{}\" ({album_id}) failed for account {}: {error}. Check this account's album editor access and API-key albumAsset.create permission. Some photos may already have been added; retry this existing album.",
                    album.album_name,
                    group.account.user_name.as_deref().unwrap_or(&group.account.user_id)
                ))?;
        }
        Ok(())
    }.await;

    // Bulk requests can partially succeed. Reconcile only the selected album,
    // including on failure, so retrying never hides confirmed photos.
    let refresh: Result<(), String> = async {
        let assets = client.get_album_assets(album_id).await?;
        let ids: Vec<_> = assets.iter().map(|asset| asset.id.clone()).collect();
        state.db.upsert_assets(&account.id, &assets)?;
        state.db.replace_album_assets(&account.id, album_id, &ids)?;
        album.asset_count = Some(ids.len() as u32);
        if !album.album_thumbnail_asset_id.as_ref().is_some_and(|id| ids.contains(id)) {
            album.album_thumbnail_asset_id = ids.first().cloned();
        }
        state.db.upsert_albums(&account.id, std::slice::from_ref(&album))?;
        Ok(())
    }.await;
    if let Err(error) = refresh {
        log::error!("[albums.add-assets] membership refresh failed album_id={album_id}: {error}");
        return Err(match outcome {
            Err(submission_error) => format!("{submission_error} Refreshing the album cache also failed: {error}"),
            Ok(()) => format!("Photos were added to album {album_id}, but refreshing its cache failed: {error}"),
        });
    }
    outcome?;
    if let Err(error) = state.db.record_recent_album(album_id) {
        log::warn!("[albums.recent] could not record updated album {}: {}", album_id, error);
    }

    log::info!("[albums.add-assets] complete album_id={album_id}");
    Ok(())
}

#[tauri::command]
pub async fn create_share_link_for_assets(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // Share links are scoped to a single server; route via the first asset's
    // owning account.
    let client = match asset_ids.first() {
        Some(first) => state.account_and_client_for_asset(first).1,
        None => state.immich.clone(),
    };
    client
        .create_share_link_for_assets(&asset_ids)
        .await
        .map_err(|err| format!("create share link failed: {err}"))
}

#[tauri::command]
pub async fn can_manage_album_sharing(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let (_account_id, client) = state.account_and_client_for_album(&album_id);
    client
        .can_manage_album_sharing(&album_id)
        .await
        .map_err(|err| format!("can manage album sharing failed: {err}"))
}

#[tauri::command]
pub async fn get_or_create_album_share_link(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (_account_id, client) = state.account_and_client_for_album(&album_id);
    client
        .get_or_create_album_share_link(&album_id)
        .await
        .map_err(|err| format!("get or create album share link failed: {err}"))
}

#[tauri::command]
pub async fn get_album_share_link(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let (_account_id, client) = state.account_and_client_for_album(&album_id);
    client
        .get_album_share_link(&album_id)
        .await
        .map_err(|err| format!("get album share link failed: {err}"))
}

#[tauri::command]
pub async fn get_album_share_users(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AlbumShareUser>, String> {
    let (_account_id, client) = state.account_and_client_for_album(&album_id);
    client
        .get_album_share_users(&album_id)
        .await
        .map_err(|err| format!("get album share users failed: {err}"))
}

#[tauri::command]
pub async fn get_shareable_users(
    account_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AlbumUserCandidate>, String> {
    let account = match account_id {
        Some(id) => state.db.get_account(&id)?,
        None => state.db.get_primary_account()?,
    }
    .ok_or("Account no longer exists. Sign in again.")?;
    let client = creation::account_client(&state, &account)?;
    if !client.ping(&account.server_url).await {
        return Err("offline: Connect to the album owner's server to load collaborators.".into());
    }
    client
        .get_shareable_users()
        .await
        .map_err(|err| {
            log::error!("[albums.settings] list collaborators failed account_id={}: {err}", account.id);
            format!("get shareable users failed: {err}")
        })
}

#[tauri::command]
pub async fn add_user_to_album(
    album_id: String,
    user_id: String,
    role: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (_account_id, client) = state.account_and_client_for_album(&album_id);
    client
        .add_user_to_album(&album_id, &user_id, &role)
        .await
        .map_err(|err| format!("add user to album failed: {err}"))
}

#[tauri::command]
pub async fn remove_user_from_album(
    album_id: String,
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (_account_id, client) = state.account_and_client_for_album(&album_id);
    client
        .remove_user_from_album(&album_id, &user_id)
        .await
        .map_err(|err| format!("remove user from album failed: {err}"))
}

#[tauri::command]
pub async fn save_album_locally(
    album_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    log::warn!("[album-save-locally] start album_id={}", album_id);

    // Get all albums to find the one with matching ID
    let albums = state
        .db
        .get_albums()
        .map_err(|err| format!("[album-save-locally] failed to read albums from cache: {}", err))?;

    let album = albums
        .iter()
        .find(|a| a.id == album_id)
        .ok_or_else(|| format!("[album-save-locally] album not found: {}", album_id))?;

    log::warn!(
        "[album-save-locally] found album name={} start_date={:?}",
        album.album_name, album.start_date
    );

    // Get user's configured local folder path from settings
    let settings = state
        .db
        .get_settings()
        .map_err(|err| format!("[album-save-locally] failed to get settings: {}", err))?;

    let base_folder = if settings.user_local_folder_path.is_empty() {
        log::warn!("[album-save-locally] user_local_folder_path is empty, using fallback ~/Albums");
        let home = crate::util::home_dir()
            .ok_or_else(|| "[album-save-locally] cannot resolve home directory".to_string())?;
        home.join("Albums")
    } else {
        Path::new(&settings.user_local_folder_path).to_path_buf()
    };

    let destination = super::download_destination::album_local_folder(
        &album.album_name,
        album.start_date.as_deref(),
        album.saved_local_folder_path.as_deref(),
        &base_folder,
    )?;

    log::warn!(
        "[album-save-locally] creating destination folder: {}",
        destination.to_string_lossy()
    );

    // Create the destination folder if it doesn't exist
    fs::create_dir_all(&destination)
        .map_err(|err| format!("[album-save-locally] failed to create folder: {}", err))?;

    // Get all assets in the album from the album's owning account.
    let (account_id, album_client) = state.account_and_client_for_album(&album_id);
    let server_url = album_client.session.lock().await.as_ref()
        .map(|session| session.server_url.clone())
        .ok_or_else(|| "not authenticated".to_string())?;
    if !album_client.ping(&server_url).await {
        return Err("offline: album download requires a server connection".into());
    }
    let assets = album_client
        .get_album_assets(&album_id)
        .await
        .map_err(|err| format!("[album-save-locally] failed to get album assets: {}", err))?;

    let asset_ids: Vec<String> = assets.iter().map(|a| a.id.clone()).collect();
    // Album list responses can omit Live Photo metadata. Preserve enriched cached assets.
    let existing_ids = state.db.get_existing_asset_ids(&asset_ids)?;
    let new_assets: Vec<_> = assets.iter()
        .filter(|asset| !existing_ids.contains(&asset.id)).cloned().collect();
    state.db.upsert_assets(&account_id, &new_assets)?;
    state.db.replace_album_assets(&account_id, &album_id, &asset_ids)?;
    log::warn!(
        "[album-save-locally] found {} assets to copy",
        asset_ids.len()
    );

    if asset_ids.is_empty() {
        log::warn!("[album-save-locally] no assets in album, returning empty folder");
        let result = destination.to_string_lossy().to_string();
        log::warn!("[album-save-locally] done folder_path={}", result);
        return Ok(result);
    }

    let total_assets = asset_ids.len() as u32;

    // Emit initial progress event
    let _ = app.emit(
        "album_save_progress",
        AlbumSaveProgress {
            total_assets,
            copied_count: 0,
            current_file: None,
            status: "Starting download...".to_string(),
        },
    );

    // Reuse existing downloads, but never substitute previews for missing originals.
    let copy_result = copy_assets_to_local_folder_internal(
        asset_ids,
        destination.to_string_lossy().to_string(),
        false,
        state.clone(),
        Some(app.clone()),
        "album_save",
        Some(&album_id),
    )
    .await?;

    // Emit completion progress event
    let _ = app.emit(
        "album_save_progress",
        AlbumSaveProgress {
            total_assets,
            copied_count: copy_result.copied_original_count + copy_result.copied_cached_count,
            current_file: None,
            status: "Download complete".to_string(),
        },
    );

    log::warn!(
        "[album-save-locally] copy completed: copied_original={} copied_cached={} failed={}",
        copy_result.copied_original_count, copy_result.copied_cached_count, copy_result.failed_count
    );

    let result = destination.to_string_lossy().to_string();
    state
        .db
        .update_album_saved_local_folder_path(&album_id, Some(&result))
        .map_err(|err| format!("[album-save-locally] failed to persist saved folder path: {}", err))?;
    if copy_result.failed_count + copy_result.original_unavailable_count > 0 {
        let error = format!("Album download incomplete: {} files could not be downloaded",
            copy_result.failed_count + copy_result.original_unavailable_count);
        log::error!("[album-save-locally] album_id={album_id} {error}");
        return Err(error);
    }
    log::warn!("[album-save-locally] done folder_path={}", result);
    Ok(result)
}

#[tauri::command]
pub async fn delete_local_album(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log::warn!("[album-delete-local] start album_id={}", album_id);

    let albums = state
        .db
        .get_albums()
        .map_err(|err| format!("[album-delete-local] failed to read albums from cache: {}", err))?;

    let Some(album) = albums.iter().find(|a| a.id == album_id) else {
        return Err(format!("[album-delete-local] album not found: {}", album_id));
    };

    let saved_folder_path = album
        .saved_local_folder_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let tracked_paths = state
        .db
        .list_local_saved_asset_paths_for_album(&album_id)
        .map_err(|err| format!("[album-delete-local] failed to read tracked paths: {}", err))?;

    log::warn!(
        "[album-delete-local] deleting tracked files album_id={} tracked_count={} folder_path={:?}",
        album_id,
        tracked_paths.len(),
        saved_folder_path
    );

    let mut failures = Vec::new();

    for path in &tracked_paths {
        let local_path = Path::new(path);
        if !local_path.exists() {
            continue;
        }

        if let Err(err) = fs::remove_file(local_path) {
            if err.kind() != ErrorKind::NotFound {
                failures.push(format!("failed to delete file {}: {}", path, err));
            }
        }
    }

    if let Some(folder_path) = &saved_folder_path {
        let folder = Path::new(folder_path);
        if folder.exists() {
            if let Err(err) = fs::remove_dir_all(folder) {
                failures.push(format!("failed to delete folder {}: {}", folder_path, err));
            }
        }
    }

    if !failures.is_empty() {
        log::warn!(
            "[album-delete-local] failed album_id={} failure_count={}",
            album_id,
            failures.len()
        );
        return Err(failures.join("; "));
    }

    state
        .db
        .delete_unresolved_local_saved_asset_changes_for_album(&album_id)
        .map_err(|err| format!("[album-delete-local] failed to clear pending file-change rows: {}", err))?;

    state
        .db
        .delete_local_saved_assets_for_album(&album_id)
        .map_err(|err| format!("[album-delete-local] failed to clear tracked local rows: {}", err))?;

    state
        .db
        .update_album_saved_local_folder_path(&album_id, None)
        .map_err(|err| format!("[album-delete-local] failed to clear saved folder path: {}", err))?;

    log::warn!("[album-delete-local] done album_id={}", album_id);
    Ok(())
}
