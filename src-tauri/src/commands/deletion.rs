use crate::commands::settings::DeleteBehavior;
use crate::services::immich_client::AssetSummary;
use crate::AppState;

mod refresh;
use super::asset_owner::owner_client;
pub(super) use refresh::refresh_deleted_assets_inner;

#[tauri::command]
pub async fn delete_asset(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    let behavior = state.db.get_settings()?.delete_behavior;
    change_deleted_state(asset_id, behavior, false, &state).await
}

#[tauri::command]
pub async fn restore_deleted_asset(
    asset_id: String,
    mode: DeleteBehavior,
    state: tauri::State<'_, AppState>,
) -> Result<AssetSummary, String> {
    change_deleted_state(asset_id, mode, true, &state).await
}

pub(super) async fn change_deleted_state(
    id: String,
    behavior: DeleteBehavior,
    restore: bool,
    state: &AppState,
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
        crate::commands::media::delete_edit_version_inner(id.clone(), state).await?;
        return state
            .db
            .get_asset_summary(&id)?
            .ok_or("Deleted version missing from cache".into());
    }
    let account = state
        .db
        .get_asset_account_id(&id)?
        .ok_or("Cannot identify the photo account")?;
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
    let result = async {
        owner_client(state, &account, &id)
            .await?
            .change_deleted_state(&id, behavior, restore)
            .await
    }
    .await;
    let queue = match result {
        Ok(()) => None,
        Err(error) => {
            if state.immich.ping(&server).await {
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
    refresh_deleted_assets_inner(mode, &state).await
}
