use serde::Serialize;
use tauri::Emitter;

use crate::services::activity_log::{self, ActivityEntry, FrontendInput, SessionInfo};

/// Broadcast to every window when the Verbose switch changes so the main window's sink can follow it.
pub const VERBOSE_EVENT: &str = "activity-log:verbose";

// These commands run on a timer while the Activity Log window is open, so none of them may record
// entries of their own: that would make the log grow by merely being watched.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntriesResponse {
    pub entries: Vec<ActivityEntry>,
    pub last_id: u64,
    pub verbose: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordFrontendResponse {
    pub verbose: bool,
}

#[tauri::command]
pub async fn get_activity_log_entries(
    since_id: Option<u64>,
    limit: Option<usize>,
) -> ActivityEntriesResponse {
    let since = activity_log::entries_since(
        since_id.unwrap_or(0),
        limit.unwrap_or(activity_log::DEFAULT_ENTRIES_LIMIT),
    );
    ActivityEntriesResponse {
        entries: since.entries,
        last_id: since.last_id,
        verbose: activity_log::is_verbose(),
    }
}

#[tauri::command]
pub async fn get_activity_log_history(limit: Option<usize>) -> Result<Vec<ActivityEntry>, String> {
    let limit = limit.unwrap_or(activity_log::store::HISTORY_LIMIT);
    tauri::async_runtime::spawn_blocking(move || activity_log::history(limit))
        .await
        .map_err(|err| format!("could not read the previous activity log: {err}"))
}

#[tauri::command]
pub async fn get_activity_log_info() -> SessionInfo {
    activity_log::session_info()
}

#[tauri::command]
pub async fn record_frontend_activity(entries: Vec<FrontendInput>) -> RecordFrontendResponse {
    activity_log::ingest_frontend(entries);
    RecordFrontendResponse {
        verbose: activity_log::is_verbose(),
    }
}

#[tauri::command]
pub async fn set_activity_log_verbose(enabled: bool, app: tauri::AppHandle) -> bool {
    let value = activity_log::set_verbose(enabled);
    if let Err(err) = app.emit(VERBOSE_EVENT, value) {
        activity_log::warn(
            "activity_log",
            &format!("could not broadcast the verbose setting: {err}"),
        );
    }
    value
}

#[tauri::command]
pub async fn clear_activity_log() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(activity_log::clear)
        .await
        .map_err(|err| format!("could not clear the activity log: {err}"))
}
