use crate::services::immich_client::MemorySummary;
use crate::AppState;

#[tauri::command]
pub async fn fetch_memories(state: tauri::State<'_, AppState>) -> Result<Vec<MemorySummary>, String> {
    state
        .immich
        .get_memories()
        .await
        .map_err(|err| format!("fetch memories failed: {err}"))
}
