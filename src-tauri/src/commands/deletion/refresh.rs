use super::DeleteBehavior;
use crate::commands::asset_owner::signed_in_client;
use crate::services::immich_client::{AssetSummary, ImmichClient};
use crate::AppState;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

#[derive(Default)]
struct Snapshot {
    fresh: Vec<AssetSummary>,
    deleted: Vec<String>,
    absent: Vec<String>,
}

pub(in crate::commands) async fn refresh_deleted_assets_inner(
    mode: DeleteBehavior,
    state: &AppState,
) -> Result<(), String> {
    log::info!("[assets.deleted-refresh] start mode={mode:?}");
    let mut servers = BTreeMap::<String, Vec<(String, Arc<ImmichClient>)>>::new();
    for (id, _) in state.sync_accounts() {
        let account = state
            .db
            .get_account(&id)?
            .ok_or("Unknown deleted-items account")?;
        let client = signed_in_client(state, &account).await?;
        servers
            .entry(account.server_url)
            .or_default()
            .push((id, client));
    }
    let mut errors = Vec::new();
    for (server, accounts) in servers {
        if let Err(error) = refresh_server(state, mode, &server, &accounts).await {
            log::warn!("[assets.deleted-refresh] failed mode={mode:?}: {error}");
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

async fn refresh_server(
    state: &AppState,
    mode: DeleteBehavior,
    server: &str,
    accounts: &[(String, Arc<ImmichClient>)],
) -> Result<(), String> {
    // Collect the whole server snapshot before reconciling. A shared photo may
    // be cached under a reader but appear only in its owner's deleted listing.
    let mut listed = BTreeMap::new();
    let mut snapshots = BTreeMap::<String, Snapshot>::new();
    for (account, client) in accounts {
        if !client.ping(server).await {
            return Err(format!(
                "offline: Deleted items for account {account} are cached"
            ));
        }
        let assets = match client.get_deleted_assets(mode).await {
            Ok(assets) => assets,
            Err(error) => {
                if !client.ping(server).await {
                    return Err(format!(
                        "offline: Deleted items for account {account} are cached: {error}"
                    ));
                }
                return Err(format!("Deleted refresh for account {account}: {error}"));
            }
        };
        for asset in assets {
            listed.insert(asset.id.clone(), (account.clone(), asset));
        }
        snapshots.insert(account.clone(), Snapshot::default());
    }
    let pending = state
        .db
        .list_pending_mutations()?
        .into_iter()
        .map(|mutation| mutation.asset_id)
        .collect::<HashSet<_>>();
    let listed_ids = listed.keys().cloned().collect::<HashSet<_>>();
    for (_, (source_account, asset)) in listed {
        let account = state
            .db
            .get_asset_account_id(&asset.id)?
            .unwrap_or(source_account);
        let cached = state
            .db
            .get_account(&account)?
            .ok_or("Unknown cached photo account")?;
        if cached.server_url != server {
            return Err(format!(
                "Deleted refresh cannot reassign asset {} across servers",
                asset.id
            ));
        }
        let snapshot = snapshots.entry(account).or_default();
        snapshot.deleted.push(asset.id.clone());
        if !pending.contains(&asset.id) {
            snapshot.fresh.push(asset);
        }
    }
    for (account, snapshot) in &mut snapshots {
        for id in state.db.deleted_ids(account, mode)? {
            if listed_ids.contains(&id) || pending.contains(&id) {
                continue;
            }
            // A reader's 404 alone does not mean a trashed photo was purged.
            let mut found = None;
            let mut error = None;
            for (_, client) in accounts {
                match client.get_asset_for_reconciliation(&id).await {
                    Ok(Some(asset)) => {
                        found = Some(asset);
                        break;
                    }
                    Ok(None) => {}
                    Err(cause) => {
                        if !client.ping(server).await {
                            return Err(format!("offline: Deleted items are cached: {cause}"));
                        }
                        error = Some(cause);
                    }
                }
            }
            match found {
                Some(asset) => {
                    let still_deleted = match mode {
                        DeleteBehavior::Trash => asset.is_trashed,
                        DeleteBehavior::Archive => {
                            !asset.is_trashed
                                && (asset.is_archived
                                    || asset.visibility.as_deref() == Some("archive"))
                        }
                    };
                    if still_deleted {
                        snapshot.deleted.push(id);
                    }
                    snapshot.fresh.push(asset);
                }
                None => {
                    if let Some(error) = error {
                        return Err(error);
                    }
                    snapshot.absent.push(id);
                }
            }
        }
    }
    for (account, snapshot) in snapshots {
        state.db.upsert_assets(&account, &snapshot.fresh)?;
        state.db.evict_absent_deleted(&account, &snapshot.absent)?;
        state
            .db
            .reconcile_deleted(&account, &snapshot.deleted, mode)?;
        log::info!(
            "[assets.deleted-refresh] complete account={account} mode={mode:?} count={}",
            snapshot.deleted.len()
        );
    }
    Ok(())
}
