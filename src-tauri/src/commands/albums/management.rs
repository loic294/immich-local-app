use crate::services::immich_client::ImmichClient;
use crate::AppState;
use std::sync::Arc;

/// A cached album resolved to the signed-in account that can act on it.
struct AlbumTarget {
    server_url: String,
    client: Arc<ImmichClient>,
}

fn resolve_target(state: &AppState, album_id: &str, action: &str) -> Result<AlbumTarget, String> {
    let account_id = state
        .db
        .get_album_account_id(album_id)?
        .ok_or("Album has no cached account. Refresh the album list and try again.")?;
    let account = state
        .db
        .get_account(&account_id)?
        .ok_or("Album account no longer exists.")?;
    let client = state
        .accounts
        .client(&account.id)
        .or_else(|| account.is_primary.then(|| state.immich.clone()))
        .ok_or_else(|| {
            format!(
                "Account {} is not signed in. Sign in again to {action}.",
                account.id
            )
        })?;
    Ok(AlbumTarget {
        server_url: account.server_url,
        client,
    })
}

/// Renames an album on its server, then mirrors the saved name into the cache.
/// Returns the saved name. Needs connectivity; nothing is queued while offline.
pub(super) async fn rename_album_internal(
    album_id: &str,
    album_name: &str,
    state: &AppState,
) -> Result<String, String> {
    let album_name = album_name.trim();
    if album_name.is_empty() {
        return Err("Enter an album name.".into());
    }
    log::info!("[albums.rename] start album_id={album_id}");
    let target = resolve_target(state, album_id, "rename this album")?;
    if !target.client.ping(&target.server_url).await {
        log::warn!("[albums.rename] offline album_id={album_id}");
        return Err("offline: Connect to the album's server to rename it.".into());
    }
    let saved_name = target
        .client
        .rename_album(album_id, album_name)
        .await
        .map_err(|error| {
            format!(
                "Renaming album {album_id} failed: {error}. Only the album owner can rename it, and the API key needs the album.update permission."
            )
        })?;
    state
        .db
        .rename_cached_album(album_id, &saved_name)
        .map_err(|error| {
            log::error!("[albums.rename] cache update failed album_id={album_id}: {error}");
            format!("Album {album_id} was renamed, but updating the local cache failed: {error}")
        })?;
    log::info!("[albums.rename] complete album_id={album_id}");
    Ok(saved_name)
}

/// Deletes an album on its server, then drops it from the cache. Photos stay in
/// the library and locally saved files are never touched. Needs connectivity;
/// a destructive delete is never queued for later.
pub(super) async fn delete_album_internal(album_id: &str, state: &AppState) -> Result<(), String> {
    log::info!("[albums.delete] start album_id={album_id}");
    let target = resolve_target(state, album_id, "delete this album")?;
    if !target.client.ping(&target.server_url).await {
        log::warn!("[albums.delete] offline album_id={album_id}");
        return Err("offline: Connect to the album's server to delete it.".into());
    }
    target.client.delete_album(album_id).await.map_err(|error| {
        format!(
            "Deleting album {album_id} failed: {error}. Only the album owner can delete it, and the API key needs the album.delete permission."
        )
    })?;
    state.db.delete_cached_album(album_id).map_err(|error| {
        log::error!("[albums.delete] cache cleanup failed album_id={album_id}: {error}");
        format!("Album {album_id} was deleted, but clearing the local cache failed: {error}")
    })?;
    log::info!("[albums.delete] complete album_id={album_id}");
    Ok(())
}
