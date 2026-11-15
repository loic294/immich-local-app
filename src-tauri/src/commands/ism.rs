use std::collections::HashMap;
use std::time::Duration;

use crate::services::ism::{
    run_operation, ActivityEntry, ClientInfo, ExpectedEntry, IsmClient, Location, OperationAction,
    OperationView, Provider,
};
use crate::AppState;
use serde::Serialize;

const OPERATION_WAIT: Duration = Duration::from_secs(120);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    base_url: String,
}

fn server_url(state: &AppState, account_id: &str) -> Result<String, String> {
    state
        .db
        .get_account(account_id)?
        .map(|account| account.server_url)
        .ok_or_else(|| "Immich account not found".to_string())
}

fn check_info(info: &ClientInfo) -> Result<(), String> {
    if info.api_version != 1 || info.token_kind != "ila" {
        return Err("ISM requires an ILA client token and API version 1".into());
    }
    if !info.actions.iter().any(|action| action == "read")
        || !info.actions.iter().any(|action| action == "download")
    {
        return Err("ISM token requires read and download permissions".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_ism_provider(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<ProviderSettings>, String> {
    let server = server_url(&state, &account_id)?;
    Ok(state
        .db
        .ism_provider(&server)?
        .map(|provider| ProviderSettings {
            base_url: provider.base_url,
        }))
}

#[tauri::command]
pub async fn save_ism_provider(
    account_id: String,
    base_url: String,
    token: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<ClientInfo, String> {
    let server = server_url(&state, &account_id)?;
    let existing = state.db.ism_provider(&server)?;
    let normalized = IsmClient::new(&base_url, "placeholder")?
        .base_url()
        .to_string();
    let token = match token.filter(|token| !token.is_empty()) {
        Some(token) => token,
        None => {
            let existing = existing.ok_or("Enter an ISM client token")?;
            if existing.base_url != normalized {
                return Err("Enter a new ISM client token when changing the server URL".into());
            }
            existing.client_token
        }
    };
    let client = IsmClient::new(&normalized, &token)?;
    let info = client.info().await?;
    check_info(&info)?;
    state.db.save_ism_provider(
        &server,
        &Provider {
            base_url: normalized,
            client_token: token,
        },
    )?;
    Ok(info)
}

#[tauri::command]
pub async fn test_ism_provider(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ClientInfo, String> {
    let server = server_url(&state, &account_id)?;
    let provider = state
        .db
        .ism_provider(&server)?
        .ok_or("ISM is not configured for this server")?;
    let info = IsmClient::new(&provider.base_url, &provider.client_token)?
        .info()
        .await?;
    check_info(&info)?;
    Ok(info)
}

#[tauri::command]
pub async fn remove_ism_provider(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let server = server_url(&state, &account_id)?;
    state.db.remove_ism_provider(&server)
}

fn provider_client(state: &AppState, server: &str) -> Result<IsmClient, String> {
    let provider = state
        .db
        .ism_provider(server)?
        .ok_or("ISM is not configured for this server")?;
    IsmClient::new(&provider.base_url, &provider.client_token)
}

fn asset_server_url(state: &AppState, asset_id: &str) -> Result<String, String> {
    let account_id = state
        .db
        .get_asset_account_id(asset_id)?
        .ok_or("The asset's Immich account is unknown")?;
    server_url(state, &account_id)
}

/// Persists the request, then submits it and waits a bounded time. A still-running operation
/// is returned as-is and finishes in the activity list.
async fn submit(
    state: &AppState,
    server: &str,
    client: &IsmClient,
    label: String,
    asset_id: Option<&str>,
    action: OperationAction,
) -> Result<OperationView, String> {
    let key = state
        .db
        .begin_ism_operation(server, &label, None, asset_id, vec![action])?
        .ok_or("ISM operation was already requested")?;
    run_operation(&state.db, client, &key, OPERATION_WAIT).await
}

fn join_path(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

#[tauri::command]
pub async fn get_ism_import_folder(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Location>, String> {
    state
        .db
        .ism_import_folder(&server_url(&state, &account_id)?)
}

#[tauri::command]
pub async fn set_ism_import_folder(
    account_id: String,
    folder: Option<Location>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let folder = folder.map(|folder| Location {
        root_id: folder.root_id.trim().to_string(),
        path: folder.path.trim().trim_matches('/').to_string(),
    });
    state
        .db
        .set_ism_import_folder(&server_url(&state, &account_id)?, folder.as_ref())
}

#[tauri::command]
pub async fn ism_rename_asset(
    asset_id: String,
    new_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationView, String> {
    let server = asset_server_url(&state, &asset_id)?;
    let client = provider_client(&state, &server)?;
    let original = client
        .original_location(&state.db, &server, &asset_id)
        .await?;
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.contains(['/', '\\']) {
        return Err("Enter a file name without folders".into());
    }
    let target = Location {
        root_id: original.location.root_id.clone(),
        path: join_path(&original.folder, new_name),
    };
    let action = OperationAction::Rename {
        source: original.location,
        target,
        expected_revision: Some(original.revision),
    };
    submit(
        &state,
        &server,
        &client,
        format!("Rename to {new_name}"),
        Some(&asset_id),
        action,
    )
    .await
}

#[tauri::command]
pub async fn ism_move_asset(
    asset_id: String,
    root_id: Option<String>,
    folder: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationView, String> {
    let server = asset_server_url(&state, &asset_id)?;
    let client = provider_client(&state, &server)?;
    let original = client
        .original_location(&state.db, &server, &asset_id)
        .await?;
    let folder = folder.trim().trim_matches('/');
    let name = original
        .location
        .path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let root_id = root_id
        .filter(|root| !root.trim().is_empty())
        .unwrap_or_else(|| original.location.root_id.clone());
    let action = OperationAction::Move {
        source: original.location,
        target: Location {
            root_id,
            path: join_path(folder, &name),
        },
        expected_revision: Some(original.revision),
    };
    submit(
        &state,
        &server,
        &client,
        format!("Move {name} to {folder}"),
        Some(&asset_id),
        action,
    )
    .await
}

#[tauri::command]
pub async fn ism_trash_asset(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationView, String> {
    let server = asset_server_url(&state, &asset_id)?;
    let client = provider_client(&state, &server)?;
    let original = client
        .original_location(&state.db, &server, &asset_id)
        .await?;
    let label = format!("Move {} to ISM trash", original.location.path);
    let action = OperationAction::TrashIfAssetMatches {
        source: original.location,
        expected_asset_id: asset_id.clone(),
        expected_revision: Some(original.revision).filter(|revision| !revision.is_empty()),
    };
    submit(&state, &server, &client, label, Some(&asset_id), action).await
}

#[tauri::command]
pub async fn ism_create_folder(
    account_id: String,
    root_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationView, String> {
    let server = server_url(&state, &account_id)?;
    let client = provider_client(&state, &server)?;
    let path = path.trim().trim_matches('/').to_string();
    let label = format!("Create folder {path}");
    let action = OperationAction::CreateFolder {
        target: Location { root_id, path },
    };
    submit(&state, &server, &client, label, None, action).await
}

#[tauri::command]
pub async fn ism_move_folder(
    account_id: String,
    root_id: String,
    path: String,
    target_root_id: String,
    target_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationView, String> {
    let server = server_url(&state, &account_id)?;
    let client = provider_client(&state, &server)?;
    let path = path.trim().trim_matches('/').to_string();
    let target_path = target_path.trim().trim_matches('/').to_string();
    let label = format!("Move folder {path} to {target_path}");
    let action = OperationAction::MoveFolder {
        source: Location { root_id, path },
        target: Location {
            root_id: target_root_id,
            path: target_path,
        },
    };
    submit(&state, &server, &client, label, None, action).await
}

fn folder_to_trash(root_id: String, path: &str) -> Result<Location, String> {
    let path = path.trim().trim_matches('/').to_string();
    if root_id.is_empty() || path.is_empty() {
        return Err("Choose a folder inside an ISM library".into());
    }
    Ok(Location { root_id, path })
}

/// Lists every file below a folder so the user confirms exactly what will be trashed; the
/// trash then fails with `revision_changed` if anything was added, changed or removed.
#[tauri::command]
pub async fn ism_folder_snapshot(
    account_id: String,
    root_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ExpectedEntry>, String> {
    let server = server_url(&state, &account_id)?;
    let client = provider_client(&state, &server)?;
    let info = client.info().await?;
    if !info
        .capabilities
        .iter()
        .any(|capability| capability == "trash_expectations")
    {
        return Err(
            "ISM cannot verify folder contents before trashing; update the ISM server".into(),
        );
    }
    client
        .folder_entries(&folder_to_trash(root_id, &path)?)
        .await
}

#[tauri::command]
pub async fn ism_trash_folder(
    account_id: String,
    root_id: String,
    path: String,
    expected_entries: Vec<ExpectedEntry>,
    state: tauri::State<'_, AppState>,
) -> Result<OperationView, String> {
    let server = server_url(&state, &account_id)?;
    let client = provider_client(&state, &server)?;
    let source = folder_to_trash(root_id, &path)?;
    let label = format!("Move folder {} to ISM trash", source.path);
    let action = OperationAction::TrashFolder {
        source,
        expected_entries: Some(expected_entries),
    };
    submit(&state, &server, &client, label, None, action).await
}

/// Returns the given assets whose Immich server uses ISM for file management.
#[tauri::command]
pub async fn ism_supported_assets(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut servers: HashMap<String, bool> = HashMap::new();
    let mut supported = Vec::new();
    for asset_id in asset_ids {
        let Some(account_id) = state.db.get_asset_account_id(&asset_id)? else {
            continue;
        };
        let enabled = match servers.get(&account_id) {
            Some(enabled) => *enabled,
            None => {
                let server = server_url(&state, &account_id)?;
                let enabled = state.db.ism_provider(&server)?.is_some();
                servers.insert(account_id, enabled);
                enabled
            }
        };
        if enabled {
            supported.push(asset_id);
        }
    }
    Ok(supported)
}

/// Maps an Immich folder path (as shown in the folder view) to the ISM root that contains it,
/// or `None` when ISM is not configured or no root covers the folder.
#[tauri::command]
pub async fn ism_folder_location(
    account_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Location>, String> {
    let server = server_url(&state, &account_id)?;
    if state.db.ism_provider(&server)?.is_none() {
        return Ok(None);
    }
    let info = provider_client(&state, &server)?.info().await?;
    Ok(folder_location(&info, &path))
}

fn folder_location(info: &ClientInfo, path: &str) -> Option<Location> {
    let path = path.trim_end_matches('/');
    info.roots
        .iter()
        .filter(|root| root.available)
        .filter_map(|root| {
            let prefix = root.immich_import_path.as_deref()?.trim_end_matches('/');
            let rest = if path == prefix {
                ""
            } else {
                path.strip_prefix(prefix)?.strip_prefix('/')?
            };
            Some((prefix.len(), root, rest))
        })
        .max_by_key(|(len, _, _)| *len)
        .map(|(_, root, rest)| Location {
            root_id: root.root_id.clone(),
            path: rest.to_string(),
        })
}

/// Lists recent ISM work after re-reading operations whose outcome is still pending.
#[tauri::command]
pub async fn ism_list_activity(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ActivityEntry>, String> {
    for (key, server) in state.db.ism_operation_keys_pending()? {
        let refreshed = match provider_client(&state, &server) {
            Ok(client) => run_operation(&state.db, &client, &key, Duration::ZERO)
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        };
        if let Err(error) = refreshed {
            log::warn!("[ism] operation refresh failed key={key}: {error}");
        }
    }
    state.db.ism_activity()
}

#[tauri::command]
pub async fn ism_dismiss_activity(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.db.dismiss_ism_activity(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_location_uses_the_longest_matching_import_path() {
        let info: ClientInfo = serde_json::from_value(serde_json::json!({
            "instance_id": "i", "instance_name": "ISM", "version": "1", "api_version": 1,
            "token_kind": "ila", "actions": ["read"], "capabilities": [],
            "roots": [
                { "root_id": "all", "name": "All", "immich_import_path": "/library",
                  "opm_prefix": null, "available": true, "direct_writes": "enabled" },
                { "root_id": "photos", "name": "Photos", "immich_import_path": "/library/photos/",
                  "opm_prefix": null, "available": true, "direct_writes": "enabled" }
            ]
        }))
        .unwrap();
        let location = folder_location(&info, "/library/photos/2025/Trip").unwrap();
        assert_eq!(
            (location.root_id.as_str(), location.path.as_str()),
            ("photos", "2025/Trip")
        );
        let location = folder_location(&info, "/library/photos").unwrap();
        assert_eq!(
            (location.root_id.as_str(), location.path.as_str()),
            ("photos", "")
        );
        assert!(
            folder_location(&info, "/library/photosets")
                .unwrap()
                .root_id
                == "all"
        );
        assert!(folder_location(&info, "/elsewhere/2025").is_none());
    }
}
