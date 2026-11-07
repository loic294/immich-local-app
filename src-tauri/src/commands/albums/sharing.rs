use super::creation::account_client;
use crate::services::db::Account;
use crate::services::immich_client::{AlbumUserCandidate, ImmichClient};
use crate::AppState;
use std::sync::Arc;

/// The account that owns a cached album, when it is a different account on the
/// same server than the one the album happens to be cached under. Shared-album
/// refreshes can cache an album under a reader's account, but only the owner
/// may rename, delete or share it.
pub(super) fn owner_account(
    state: &AppState,
    album_id: &str,
    cached_account_id: &str,
) -> Result<Option<Account>, String> {
    let Some(owner_user_id) = state.db.get_album_owner_id(album_id)? else {
        return Ok(None);
    };
    let Some(cached) = state.db.get_account(cached_account_id)? else {
        return Ok(None);
    };
    let owner = state
        .db
        .find_account_by_user(&cached.server_url, &owner_user_id)?;
    Ok(owner.filter(|owner| owner.id != cached.id))
}

/// Client for an album's sharing calls. Prefers the signed-in account that
/// owns the album over the cached one, and falls back to the cached account
/// when the owner is not signed in here.
pub(super) fn sharing_client(state: &AppState, album_id: &str) -> Arc<ImmichClient> {
    let (cached_account_id, cached_client) = state.account_and_client_for_album(album_id);
    match owner_client(state, album_id, &cached_account_id) {
        Ok(Some((owner_account_id, client))) => {
            log::info!(
                "[album-share.route] album_id={album_id} cached_account_id={cached_account_id} owner_account_id={owner_account_id}"
            );
            client
        }
        Ok(None) => cached_client,
        Err(error) => {
            log::warn!(
                "[album-share.route] album_id={album_id} cached_account_id={cached_account_id} using_cached_account=true: {error}"
            );
            cached_client
        }
    }
}

fn owner_client(
    state: &AppState,
    album_id: &str,
    cached_account_id: &str,
) -> Result<Option<(String, Arc<ImmichClient>)>, String> {
    let Some(owner) = owner_account(state, album_id, cached_account_id)? else {
        return Ok(None);
    };
    let client = account_client(state, &owner)
        .map_err(|error| format!("owner account {} is unavailable: {error}", owner.id))?;
    Ok(Some((owner.id, client)))
}

/// Server users an album can be shared with, listed through the owner's login.
/// Reports `offline:` instead of an opaque failure when the server is unreachable.
pub(super) async fn album_shareable_users(
    state: &AppState,
    album_id: &str,
) -> Result<Vec<AlbumUserCandidate>, String> {
    let (cached_account_id, _) = state.account_and_client_for_album(album_id);
    let server_url = state
        .db
        .get_account(&cached_account_id)?
        .ok_or("Album account no longer exists. Sign in again.")?
        .server_url;
    let client = sharing_client(state, album_id);
    if !client.ping(&server_url).await {
        log::warn!("[album-share.candidates] offline album_id={album_id}");
        return Err("offline: Connect to the album's server to load collaborators.".into());
    }
    client.get_shareable_users().await.map_err(|error| {
        log::error!("[album-share.candidates] failed album_id={album_id}: {error}");
        format!("get shareable users failed: {error}")
    })
}

/// Changes a shared user's role through the owner's login. Only editor and
/// viewer can be granted; the owner role is never assignable.
pub(super) async fn update_user_role(
    state: &AppState,
    album_id: &str,
    user_id: &str,
    role: &str,
) -> Result<(), String> {
    if !matches!(role, "editor" | "viewer") {
        log::warn!("[album-share.role] rejected album_id={album_id} user_id={user_id} role={role}");
        return Err("Album access can only be set to editor or viewer.".into());
    }
    log::info!("[album-share.role] start album_id={album_id} user_id={user_id} role={role}");
    sharing_client(state, album_id)
        .update_album_user_role(album_id, user_id, role)
        .await
        .map_err(|error| {
            log::error!("[album-share.role] failed album_id={album_id} user_id={user_id}: {error}");
            format!("update album user role failed: {error}")
        })?;
    log::info!("[album-share.role] complete album_id={album_id} user_id={user_id} role={role}");
    Ok(())
}
