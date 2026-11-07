use crate::services::storage::{self, FeaturePreferences, StorageSummary};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub async fn get_feature_preferences(
    state: tauri::State<'_, AppState>,
) -> Result<FeaturePreferences, String> {
    state.db.get_feature_preferences()
}

#[tauri::command]
pub async fn update_feature_preferences(
    preferences: FeaturePreferences,
    state: tauri::State<'_, AppState>,
) -> Result<FeaturePreferences, String> {
    let previous_limit = state.db.get_feature_preferences()?.max_cache_bytes;
    let saved = state.db.update_feature_preferences(&preferences)?;
    if previous_limit != saved.max_cache_bytes {
        storage::evict(&state.db, saved.max_cache_bytes, None, true).map_err(|error| {
            log::error!("[storage.evict] limit enforcement failed: {error}");
            format!("Cache limit saved, but cleanup failed: {error}")
        })?;
    }
    Ok(saved)
}

#[tauri::command]
pub async fn get_storage_summary(
    state: tauri::State<'_, AppState>,
) -> Result<StorageSummary, String> {
    storage::summary(&state.db).map_err(|error| {
        log::error!("[storage.measure] failed: {error}");
        error
    })
}

#[tauri::command]
pub async fn clear_disposable_cache(state: tauri::State<'_, AppState>) -> Result<u64, String> {
    storage::evict(&state.db, 0, None, false).map_err(|error| {
        log::error!("[storage.evict] manual clear failed: {error}");
        error
    })
}

#[tauri::command]
pub async fn get_video_quality_options(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.immich.get_video_quality_options().await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyPhotosRule {
    pub start_date: String,
    pub end_date: Option<String>,
    pub end_date_current: bool,
    pub camera: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemPreference {
    pub key: String,
    pub group: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCreationPreferences {
    pub owner_account_id: String,
    pub editor_user_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// None preserves the default: primary account plus other signed-in users on its server.
    #[serde(default)]
    pub album_creation: Option<AlbumCreationPreferences>,
    #[serde(default)]
    pub delete_behavior: DeleteBehavior,
    pub locale: String,
    pub live_photo_autoplay: bool,
    pub thumbnail_cache_path: String,
    pub video_cache_path: String,
    pub user_local_folder_path: String,
    pub menu_items: Vec<MenuItemPreference>,
    pub my_photos_rules: Vec<MyPhotosRule>,
    pub recent_albums_limit: u32,
    /// Immich library folder (server `original_path`) shown on the Phone Photos page.
    #[serde(default)]
    pub phone_photos_folder_path: String,
    #[serde(default = "default_phone_photos_info_visible")]
    pub phone_photos_info_visible: bool,
    /// Empty means "use the localized default title".
    #[serde(default)]
    pub phone_photos_info_title: String,
    /// Empty means "use the localized default description".
    #[serde(default)]
    pub phone_photos_info_description: String,
    /// Keyboard shortcut overrides by action id. Missing actions use the frontend defaults and
    /// an empty list means the action is intentionally unbound.
    #[serde(default)]
    pub keyboard_shortcuts: BTreeMap<String, Vec<String>>,
}

fn default_phone_photos_info_visible() -> bool {
    true
}

const MAX_SHORTCUT_ACTIONS: usize = 128;
const MAX_COMBOS_PER_ACTION: usize = 8;
const MAX_SHORTCUT_ACTION_ID_LEN: usize = 64;
const MAX_SHORTCUT_COMBO_LEN: usize = 48;

/// Guards the shape of stored shortcut overrides. The frontend catalog decides which actions and
/// combos are meaningful, so malformed entries are dropped (never rejected) to keep unrelated
/// settings saveable. An override whose combos are all malformed falls back to the defaults.
pub(crate) fn sanitize_keyboard_shortcuts(
    shortcuts: &BTreeMap<String, Vec<String>>,
) -> BTreeMap<String, Vec<String>> {
    let mut sanitized = BTreeMap::new();
    let mut dropped = 0usize;
    for (action_id, combos) in shortcuts {
        let valid_id = !action_id.is_empty()
            && action_id.len() <= MAX_SHORTCUT_ACTION_ID_LEN
            && action_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !valid_id || sanitized.len() >= MAX_SHORTCUT_ACTIONS {
            dropped += 1;
            continue;
        }

        let mut kept: Vec<String> = Vec::new();
        for combo in combos {
            let combo = combo.trim();
            let valid = !combo.is_empty()
                && combo.len() <= MAX_SHORTCUT_COMBO_LEN
                && combo.chars().all(|c| c.is_ascii_graphic());
            if !valid
                || kept.len() >= MAX_COMBOS_PER_ACTION
                || kept.iter().any(|existing| existing == combo)
            {
                dropped += 1;
                continue;
            }
            kept.push(combo.to_string());
        }
        if kept.is_empty() && !combos.is_empty() {
            continue;
        }
        sanitized.insert(action_id.clone(), kept);
    }
    if dropped > 0 {
        log::warn!("[shortcuts.settings] dropped {dropped} malformed or excess shortcut entries");
    }
    sanitized
}

pub(crate) fn parse_keyboard_shortcuts(raw: &str) -> BTreeMap<String, Vec<String>> {
    match serde_json::from_str::<BTreeMap<String, Vec<String>>>(raw) {
        Ok(parsed) => sanitize_keyboard_shortcuts(&parsed),
        Err(error) => {
            log::warn!("[shortcuts.settings] ignoring unreadable stored shortcuts: {error}");
            BTreeMap::new()
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeleteBehavior {
    #[default]
    Archive,
    Trash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub total_thumbnails_size: u64,
    pub thumbnails_count: u32,
    pub total_videos_size: u64,
    pub videos_count: u32,
    pub total_size: u64,
}

#[tauri::command]
pub async fn get_settings(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    state.db.get_settings().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn update_settings(
    settings: Settings,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    state
        .db
        .update_settings(&settings)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_cache_stats() -> Result<CacheStats, String> {
    let home = crate::util::home_dir()
        .filter(|path| path.exists())
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    let thumbnails_dir = home.join(".config/immich-local-app/thumbnails");
    let videos_dir = home.join(".config/immich-local-app/videos");

    let (thumbnails_size, thumbnails_count) = calculate_dir_size(&thumbnails_dir)
        .map_err(|err| format!("Failed to calculate thumbnails size: {}", err))?;

    let (videos_size, videos_count) = calculate_dir_size(&videos_dir)
        .map_err(|err| format!("Failed to calculate videos size: {}", err))?;

    let total_size = thumbnails_size + videos_size;

    Ok(CacheStats {
        total_thumbnails_size: thumbnails_size,
        thumbnails_count,
        total_videos_size: videos_size,
        videos_count,
        total_size,
    })
}

#[tauri::command]
pub async fn get_cache_path() -> Result<String, String> {
    let home = crate::util::home_dir()
        .filter(|path| path.exists())
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    let cache_dir = home.join(".config/immich-local-app");
    cache_dir
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Could not convert cache path to string".to_string())
}

fn calculate_dir_size(path: &PathBuf) -> Result<(u64, u32), String> {
    if !path.exists() {
        return Ok((0, 0));
    }

    let mut total_size = 0u64;
    let mut file_count = 0u32;

    for entry in fs::read_dir(path).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();

        if path.is_file() {
            if let Ok(metadata) = fs::metadata(&path) {
                total_size += metadata.len();
                file_count += 1;
            }
        }
    }

    Ok((total_size, file_count))
}
