use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub live_photo_autoplay: bool,
    pub thumbnail_cache_path: String,
    pub video_cache_path: String,
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
        .map_err(|err| err.to_string())?;
    Ok(settings)
}

#[tauri::command]
pub async fn get_cache_stats() -> Result<CacheStats, String> {
    let home = std::env::var("HOME")
        .ok()
        .and_then(|h| {
            let path = PathBuf::from(h);
            if path.exists() { Some(path) } else { None }
        })
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
    let home = std::env::var("HOME")
        .ok()
        .and_then(|h| {
            let path = PathBuf::from(h);
            if path.exists() { Some(path) } else { None }
        })
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
