//! Routes edited-photo uploads through the account that owns the original.
//!
//! Immich only stacks assets owned by the same user, so an edit must land in
//! the original owner's library. The cached `assets.account_id` is
//! last-writer-wins across signed-in accounts (a shared or partner photo can be
//! cached under a reader), so ownership is resolved from the server instead.

use crate::services::{immich_client::ImmichClient, media::UploadJob};
use crate::AppState;
use rusqlite::params;
use std::sync::Arc;

pub(super) const OWNER_NOT_SIGNED_IN: &str = "This photo belongs to another Immich user who isn't signed in to Immich Local. Sign in to the photo owner's account, then retry the upload.";

/// Returns the job and client that must upload and stack this edit. Non-edit
/// jobs and edits already owned by the job account are returned unchanged.
/// When the owner differs, a copy previously uploaded to the wrong library is
/// moved to Immich trash and the job is reassigned to the owner's account.
pub(super) async fn route_edit_to_owner(
    state: &AppState,
    job: UploadJob,
    client: Arc<ImmichClient>,
    server_url: &str,
) -> Result<(UploadJob, Arc<ImmichClient>), String> {
    let Some(original) = job.original_asset_id.clone() else {
        return Ok((job, client));
    };
    let owner_user = client.get_asset_owner_id(&original).await?;
    let Some(owner) = state.db.find_account_by_user(server_url, &owner_user)? else {
        log::error!(
            "[media:upload:owner] owner account missing job={} original={} owner_user={} account={}",
            job.id, original, owner_user, job.account_id
        );
        return Err(OWNER_NOT_SIGNED_IN.into());
    };
    if owner.id == job.account_id {
        log::info!(
            "[media:upload:owner] owner matches job={} original={} account={}",
            job.id, original, job.account_id
        );
        return Ok((job, client));
    }
    let owner_client = state
        .accounts
        .client(&owner.id)
        .or_else(|| owner.is_primary.then(|| state.immich.clone()));
    let owner_client = match owner_client {
        Some(owner_client) if owner_client.session.lock().await.is_some() => owner_client,
        _ => {
            log::error!(
                "[media:upload:owner] owner account not signed in job={} original={} owner_account={}",
                job.id, original, owner.id
            );
            return Err(OWNER_NOT_SIGNED_IN.into());
        }
    };
    log::info!(
        "[media:upload:owner] rerouting job={} original={} from={} to={} misplaced={}",
        job.id,
        original,
        job.account_id,
        owner.id,
        job.server_asset_id.as_deref().unwrap_or("none")
    );
    if let Some(misplaced) = job.server_asset_id.as_deref() {
        discard_misplaced_upload(state, &job, &client, server_url, misplaced).await?;
    }
    state
        .db
        .open()?
        .execute(
            "UPDATE media_uploads SET account_id=?1,server_asset_id=NULL WHERE id=?2",
            params![owner.id, job.id],
        )
        .map_err(|e| e.to_string())?;
    let job = UploadJob {
        account_id: owner.id,
        server_asset_id: None,
        ..job
    };
    Ok((job, owner_client))
}

/// Moves a wrong-library upload to Immich trash (recoverable) and drops its
/// local cache rows. The retained edit file on disk is never touched.
async fn discard_misplaced_upload(
    state: &AppState,
    job: &UploadJob,
    client: &ImmichClient,
    server_url: &str,
    asset_id: &str,
) -> Result<(), String> {
    if let Err(error) = client.trash_asset(asset_id).await {
        if !client.ping(server_url).await {
            return Err(format!("offline: could not trash misplaced edit {asset_id}: {error}"));
        }
        log::warn!(
            "[media:upload:owner] could not trash misplaced edit asset={} job={} account={}: {}",
            asset_id, job.id, job.account_id, error
        );
        return Ok(());
    }
    log::info!(
        "[media:upload:owner] trashed misplaced edit asset={} job={} account={}",
        asset_id, job.id, job.account_id
    );
    let cleanup = state
        .db
        .delete_assets_and_links_by_ids(&[asset_id.to_string()])
        .and_then(|_| state.db.delete_local_saved_asset_by_path(asset_id, &job.local_path));
    if let Err(error) = cleanup {
        log::warn!(
            "[media:upload:owner] could not drop cached misplaced edit asset={} job={}: {}",
            asset_id, job.id, error
        );
    }
    Ok(())
}

/// Adds an uploaded edit to an album as its owner, falling back to the
/// album's cached account when the owner cannot contribute (for example a
/// reader-owned album holding a partner's photo).
pub(super) async fn add_edit_to_album(
    state: &AppState,
    client: &ImmichClient,
    account_id: &str,
    album_id: &str,
    asset_id: &str,
) -> Result<(), String> {
    let ids = [asset_id.to_string()];
    let error = match client.add_assets_to_album(album_id, &ids).await {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    let (album_account, album_client) = state.account_and_client_for_album(album_id);
    if album_account == account_id {
        return Err(error);
    }
    log::warn!(
        "[media:upload:owner] album add rejected for owner; retrying with album account album={} asset={} owner_account={} album_account={}: {}",
        album_id, asset_id, account_id, album_account, error
    );
    album_client.add_assets_to_album(album_id, &ids).await
}

#[cfg(test)]
#[path = "edit_owner_tests.rs"]
mod tests;
