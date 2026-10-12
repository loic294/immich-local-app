use crate::commands::settings::DeleteBehavior;
use crate::services::immich_client::AssetSummary;
use crate::AppState;

#[tauri::command]
pub async fn delete_asset(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    let behavior = state.db.get_settings()?.delete_behavior;
    change_deleted_state(asset_id, behavior, false, state).await
}

#[tauri::command]
pub async fn restore_deleted_asset(
    asset_id: String,
    mode: DeleteBehavior,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    change_deleted_state(asset_id, mode, true, state).await
}

async fn change_deleted_state(
    id: String,
    behavior: DeleteBehavior,
    restore: bool,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    state
        .db
        .get_asset_summary(&id)?
        .ok_or("Asset not found in cache")?;
    // An original in an edit stack is never a deletable version.
    if !restore && state.db.protected_original(&id)? {
        return Err("The original version cannot be deleted".into());
    }
    if !restore && state.db.is_deletable_edit_version(&id)? {
        crate::commands::media::delete_edit_version(id.clone(), state.clone()).await?;
        return state
            .db
            .get_asset_summary(&id)?
            .ok_or("Deleted version missing from cache".into());
    }
    let (account, client) = state.account_and_client_for_asset(&id);
    if account.is_empty() {
        return Err("Cannot identify the owning account".into());
    }
    let server = state
        .db
        .get_account(&account)?
        .ok_or("Unknown account")?
        .server_url;
    log::info!(
        "[assets.delete] start asset={id} account={account} mode={behavior:?} restore={restore}"
    );
    let kind = if restore {
        "restore_deleted"
    } else {
        "delete_asset"
    };
    let payload = serde_json::json!({"mode": behavior}).to_string();
    let result = client.change_deleted_state(&id, behavior, restore).await;
    let queue = match result {
        Ok(()) => None,
        Err(error) => {
            if client.ping(&server).await {
                log::warn!("[assets.delete] rejected asset={id} mode={behavior:?}: {error}");
                return Err(error);
            }
            log::info!("[assets.delete] offline queue asset={id} mode={behavior:?}");
            Some((kind, payload.as_str()))
        }
    };
    state
        .db
        .apply_deleted_state(&account, &id, behavior, restore, queue)?;
    log::info!(
        "[assets.delete] complete asset={id} queued={}",
        queue.is_some()
    );
    state
        .db
        .get_asset_summary(&id)?
        .ok_or("Asset missing from cache".into())
}

#[tauri::command]
pub async fn refresh_deleted_assets(
    mode: DeleteBehavior,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log::info!("[assets.deleted-refresh] start mode={mode:?}");
    let mut errors = Vec::new();
    for (account, client) in state.sync_accounts() {
        let Some(record) = state.db.get_account(&account)? else {
            errors.push(format!("Unknown account {account}"));
            continue;
        };
        if !client.ping(&record.server_url).await {
            errors.push(format!(
                "offline: Deleted items for account {account} are cached"
            ));
            continue;
        }
        match client.get_deleted_assets(mode).await {
            Ok(assets) => {
                let ids = assets.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
                // Do not overwrite optimistic decisions with stale server data.
                let pending = state.db.list_pending_mutations()?;
                let mut fresh = assets
                    .into_iter()
                    .filter(|a| {
                        !pending
                            .iter()
                            .any(|p| p.account_id == account && p.asset_id == a.id)
                    })
                    .collect::<Vec<_>>();
                let mut absent = Vec::new();
                let mut failed = None;
                for id in state.db.deleted_ids(&account, mode)? {
                    if ids.contains(&id)
                        || pending
                            .iter()
                            .any(|p| p.account_id == account && p.asset_id == id)
                    {
                        continue;
                    }
                    match client.get_asset_for_reconciliation(&id).await {
                        Ok(Some(asset)) => fresh.push(asset),
                        Ok(None) => absent.push(id),
                        Err(error) => {
                            failed = Some(error);
                            break;
                        }
                    }
                }
                if let Some(error) = failed {
                    log::warn!(
                        "[assets.deleted-refresh] reconciliation failed account={account}: {error}"
                    );
                    errors.push(error);
                    continue;
                }
                let mut ownership_conflict = None;
                for asset in &fresh {
                    if let Some(cached) = state.db.get_asset_details(&asset.id)? {
                        if cached.account_id != account {
                            ownership_conflict = Some(asset.id.clone());
                            break;
                        }
                    }
                }
                if let Some(id) = ownership_conflict {
                    let error =
                        format!("Deleted refresh cannot reassign asset {id} to account {account}");
                    log::warn!("[assets.deleted-refresh] {error}");
                    errors.push(error);
                    continue;
                }
                state.db.upsert_assets(&account, &fresh)?;
                state.db.evict_absent_deleted(&account, &absent)?;
                state.db.reconcile_deleted(&account, &ids, mode)?;
                log::info!(
                    "[assets.deleted-refresh] complete account={account} mode={mode:?} count={}",
                    ids.len()
                );
            }
            Err(error) => {
                log::warn!(
                    "[assets.deleted-refresh] failed account={account} mode={mode:?}: {error}"
                );
                errors.push(format!("Deleted refresh for account {account}: {error}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}
