use crate::services::{
    db::Account,
    immich_client::{AlbumSummary, ImmichClient},
};
use crate::AppState;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

pub(super) fn account_client(
    state: &AppState,
    account: &Account,
) -> Result<Arc<ImmichClient>, String> {
    state
        .accounts
        .client(&account.id)
        .or_else(|| account.is_primary.then(|| state.immich.clone()))
        .ok_or_else(|| {
            format!(
                "Account {} is not signed in. Sign in again before adding photos.",
                account.id
            )
        })
}

pub(super) struct Contribution {
    pub account: Account,
    pub client: Arc<ImmichClient>,
    pub asset_ids: Vec<String>,
}

pub(super) fn contributions(
    state: &AppState,
    server_url: &str,
    asset_ids: &[String],
) -> Result<Vec<Contribution>, String> {
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    let mut seen = HashSet::new();
    for id in asset_ids {
        if !seen.insert(id) {
            continue;
        }
        let account_id = state.db.get_asset_account_id(id)?.ok_or_else(|| {
            format!("Photo {id} has no cached account. Refresh its view before adding it.")
        })?;
        groups.entry(account_id).or_default().push(id.clone());
    }
    groups
        .into_iter()
        .map(|(id, asset_ids)| {
            let account = state
                .db
                .get_account(&id)?
                .ok_or_else(|| format!("Photo account {id} no longer exists. Sign in again."))?;
            if account.server_url.trim_end_matches('/') != server_url.trim_end_matches('/') {
                return Err(
                    "Photos from different Immich servers cannot be added to the same album."
                        .into(),
                );
            }
            let client = account_client(state, &account)?;
            Ok(Contribution {
                account,
                client,
                asset_ids,
            })
        })
        .collect()
}

pub(super) async fn create_album_with_assets_internal(
    album_name: &str,
    asset_ids: &[String],
    state: &AppState,
) -> Result<AlbumSummary, String> {
    let result = create(album_name, asset_ids, state).await;
    if let Err(error) = &result {
        log::error!(
            "[albums.create] failed selected_count={}: {error}",
            asset_ids.len()
        );
    }
    result
}

pub(super) async fn resolve_contributors(
    state: &AppState,
    groups: Vec<Contribution>,
) -> Result<Vec<Contribution>, String> {
    let mut resolved = BTreeMap::<String, Contribution>::new();
    for group in groups {
        for id in group.asset_ids {
            // Album/partner refreshes can attribute a cached photo to its reader,
            // not its owner. Resolve ownership before any album mutation.
            let user_id = group.client.get_asset_owner_id(&id).await?;
            let account = match state
                .db
                .find_account_by_user(&group.account.server_url, &user_id)?
            {
                Some(account) => account,
                None => {
                    // A partner may grant sharing rights without a local login.
                    // The server still validates AssetShare in the add response.
                    log::info!("[albums.contributors] photo={id} owner_not_signed_in={user_id} using_access_account={}", group.account.id);
                    group.account.clone()
                }
            };
            if let Some(contribution) = resolved.get_mut(&account.id) {
                contribution.asset_ids.push(id);
            } else {
                let client = account_client(state, &account)?;
                resolved.insert(
                    account.id.clone(),
                    Contribution {
                        account,
                        client,
                        asset_ids: vec![id],
                    },
                );
            }
        }
    }
    Ok(resolved.into_values().collect())
}

async fn create(
    album_name: &str,
    asset_ids: &[String],
    state: &AppState,
) -> Result<AlbumSummary, String> {
    let album_name = album_name.trim();
    if album_name.is_empty() {
        return Err("Enter an album name.".into());
    }
    let settings = state.db.get_settings()?;
    let owner = match &settings.album_creation {
        Some(preferences) => state.db.get_account(&preferences.owner_account_id)?,
        None => state.db.get_primary_account()?,
    }
    .ok_or("Album owner account no longer exists. Choose an owner in Settings > Albums.")?;
    let client = account_client(state, &owner)?;
    let editors: BTreeSet<String> = match settings.album_creation {
        Some(preferences) => preferences.editor_user_ids,
        None => state
            .db
            .list_accounts()?
            .into_iter()
            .filter(|account| account.server_url == owner.server_url)
            .map(|account| account.user_id)
            .collect(),
    }
    .into_iter()
    .filter(|id| id != &owner.user_id)
    .collect();
    let groups = contributions(state, &owner.server_url, asset_ids)?;
    if !client.ping(&owner.server_url).await {
        return Err("offline: Connect to the album owner's server to create an album.".into());
    }
    let groups = resolve_contributors(state, groups).await?;
    for group in &groups {
        if group.account.user_id != owner.user_id && !editors.contains(&group.account.user_id) {
            return Err(format!(
                "Add photo owner {} as an album editor in Settings > Albums before creating this album.",
                group.account.user_name.as_deref().unwrap_or(&group.account.user_id)
            ));
        }
    }
    log::info!(
        "[albums.create] start owner_account_id={} editor_count={} contributing_accounts={}",
        owner.id,
        editors.len(),
        groups.len()
    );
    // Immich silently filters inaccessible assetIds during creation. Share first,
    // then let each signed-in source account contribute its own assets.
    let mut album = client.create_album_with_assets(album_name, &[]).await?;
    let mut added = Vec::new();
    let mut submitted_photos = false;
    let outcome: Result<(), String> = async {
        state
            .db
            .upsert_albums(&owner.id, std::slice::from_ref(&album))?;
        for user_id in editors {
            client
                .add_user_to_album(&album.id, &user_id, "editor")
                .await
                .map_err(|error| {
                    format!("Could not add editor {user_id}: {error}. No photos were submitted.")
                })?;
            album.shared = true;
        }
        log::info!("[albums.create] collaborators ready album_id={}", album.id);
        for group in groups {
            log::info!(
                "[albums.create] contributing album_id={} account_id={} count={}",
                album.id,
                group.account.id,
                group.asset_ids.len()
            );
            submitted_photos = true;
            group
                .client
                .add_assets_to_album(&album.id, &group.asset_ids)
                .await?;
            added.extend(group.asset_ids);
            state
                .db
                .replace_album_assets(&owner.id, &album.id, &added)?;
        }
        Ok(())
    }
    .await;
    let mut count_known = true;
    if outcome.is_err() && submitted_photos {
        // A bulk request can partially succeed, even when its HTTP status is 200.
        // Read only this new album to retain its actual membership on failure.
        match client.get_album_assets(&album.id).await {
            Ok(assets) => {
                added = assets.into_iter().map(|asset| asset.id).collect();
                state.db.replace_album_assets(&owner.id, &album.id, &added)
                    .map_err(|error| format!("Album {} exists but its partial membership could not be cached: {error}", album.id))?;
            }
            Err(error) => {
                count_known = false;
                log::error!(
                    "[albums.create] partial membership refresh failed album_id={}: {error}",
                    album.id
                );
            }
        }
    }
    album.asset_count = count_known.then_some(added.len() as u32);
    album.album_thumbnail_asset_id = added.first().cloned();
    state
        .db
        .upsert_albums(&owner.id, std::slice::from_ref(&album))
        .map_err(|error| {
            format!(
                "Album {} was created, but its cache could not be saved: {error}",
                album.id
            )
        })?;
    if let Err(error) = outcome {
        return Err(format!(
            "Album \"{}\" ({}) was created, but adding collaborators/photos did not finish: {error} Select the existing album to retry after fixing permissions.",
            album.album_name, album.id
        ));
    }
    if let Err(error) = state.db.record_recent_album(&album.id) {
        log::warn!(
            "[albums.recent] could not record created album {}: {error}",
            album.id
        );
    }
    log::info!(
        "[albums.create] complete album_id={} asset_count={}",
        album.id,
        added.len()
    );
    Ok(album)
}
