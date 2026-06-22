use crate::services::immich_client::MemorySummary;
use crate::AppState;

#[tauri::command]
pub async fn fetch_memories(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MemorySummary>, String> {
    let accounts = state.sync_accounts();
    if accounts.is_empty() {
        return Err("offline: no account available".to_string());
    }

    let mut all_memories: Vec<MemorySummary> = Vec::new();
    let mut any_online = false;

    for (account_id, client) in accounts {
        // Local-first: skip accounts whose server is currently unreachable so a
        // single offline account doesn't fail the whole strip.
        let server_url = state
            .db
            .get_account(&account_id)
            .ok()
            .flatten()
            .map(|account| account.server_url);
        let online = match &server_url {
            Some(url) => client.ping(url).await,
            None => false,
        };
        if !online {
            log::warn!(
                "[memories.fetch_memories] account {} unreachable — skipping (offline)",
                account_id
            );
            continue;
        }
        any_online = true;

        match client.get_memories().await {
            Ok(memories) => {
                log::info!(
                    "[memories.fetch_memories] account {} returned {} memories",
                    account_id,
                    memories.len()
                );
                // Tag each memory with its owning account so the frontend can
                // route thumbnail loads to the correct server session.
                all_memories.extend(memories.into_iter().map(|mut memory| {
                    memory.account_id = account_id.clone();
                    memory
                }));
            }
            Err(err) => {
                log::warn!(
                    "[memories.fetch_memories] fetch failed for account {}: {}",
                    account_id, err
                );
            }
        }
    }

    if !any_online {
        return Err("offline: server unreachable".to_string());
    }

    // Newest memories first across all accounts.
    all_memories.sort_by(|a, b| b.memory_at.cmp(&a.memory_at));

    log::info!(
        "[memories.fetch_memories] aggregated {} memories across accounts",
        all_memories.len()
    );

    Ok(all_memories)
}
