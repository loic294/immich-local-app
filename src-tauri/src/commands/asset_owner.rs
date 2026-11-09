use crate::services::{db::Account, immich_client::ImmichClient};
use crate::AppState;
use std::sync::Arc;

pub(super) const OWNER_NOT_SIGNED_IN: &str = "The photo owner's account is not signed in. Sign in to that account in Immich Local, then retry changing the photo.";

#[derive(Clone, Copy)]
pub(super) enum AssetAccess {
    Owner,
    Share,
}

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
                "Account {} is not signed in. Sign in again before changing photos.",
                account.id
            )
        })
}

pub(super) async fn signed_in_client(
    state: &AppState,
    account: &Account,
) -> Result<Arc<ImmichClient>, String> {
    let client = account_client(state, account).map_err(|_| OWNER_NOT_SIGNED_IN)?;
    let matches_account = client.session.lock().await.as_ref().is_some_and(|session| {
        session.user_id == account.user_id
            && session.server_url.trim_end_matches('/') == account.server_url.trim_end_matches('/')
    });
    if !matches_account {
        return Err(OWNER_NOT_SIGNED_IN.into());
    }
    Ok(client)
}

/// Cache attribution identifies a server/read session, not necessarily the
/// owner of a shared photo. Never fall back to another user for a mutation.
pub(in crate::commands) async fn owner_client(
    state: &AppState,
    cached_account: &str,
    asset_id: &str,
) -> Result<Arc<ImmichClient>, String> {
    resolve_asset_account(state, cached_account, asset_id, AssetAccess::Owner)
        .await
        .map(|(_, client)| client)
}

pub(super) async fn resolve_asset_account(
    state: &AppState,
    cached_account: &str,
    asset_id: &str,
    access: AssetAccess,
) -> Result<(Account, Arc<ImmichClient>), String> {
    let result = async {
        let cached = state.db.get_account(cached_account)?.ok_or("Unknown photo account")?;
        let mut candidates = state.db.list_accounts()?;
        candidates.retain(|account| account.server_url == cached.server_url);
        candidates.sort_by_key(|account| account.id != cached.id);
        let mut last_error = OWNER_NOT_SIGNED_IN.to_string();
        for account in candidates {
            let reader = match signed_in_client(state, &account).await {
                Ok(reader) => reader,
                Err(error) => {
                    log::warn!("[assets.owner] read account unavailable asset={asset_id} account={}: {error}", account.id);
                    continue;
                }
            };
            let owner_user = match reader.get_asset_owner_id(asset_id).await {
                Ok(owner) => owner,
                Err(error) => {
                    if !reader.ping(&cached.server_url).await {
                        return Err(format!("offline: Could not resolve the owner of photo {asset_id}: {error}"));
                    }
                    log::warn!("[assets.owner] ownership read failed asset={asset_id} account={}: {error}", account.id);
                    last_error = error;
                    continue;
                }
            };
            let owner = match state.db.find_account_by_user(&cached.server_url, &owner_user)? {
                Some(owner) => owner,
                None if matches!(access, AssetAccess::Share) => {
                    // Partner sharing rights can permit adding another user's photo
                    // to an album, but never authorize updating or deleting it.
                    log::info!("[assets.owner] asset={asset_id} owner_not_signed_in={owner_user} sharing_as={}", account.id);
                    return Ok((account, reader));
                }
                None => return Err(OWNER_NOT_SIGNED_IN.into()),
            };
            let client = signed_in_client(state, &owner).await?;
            log::info!(
                "[assets.owner] asset={asset_id} cached_account={cached_account} owner_account={}",
                owner.id
            );
            return Ok((owner, client));
        }
        Err(last_error)
    }.await;
    if let Err(error) = &result {
        log::warn!(
            "[assets.owner] failed asset={asset_id} cached_account={cached_account}: {error}"
        );
    }
    result
}

#[cfg(test)]
#[path = "asset_owner/tests.rs"]
mod tests;
