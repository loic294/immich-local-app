use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::AppState;
use serde::Serialize;
use tauri::Manager;
use tauri::Emitter;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCopyResult {
    pub copied_original_count: u32,
    pub copied_cached_count: u32,
    pub original_unavailable_count: u32,
    pub cache_fallback_available_count: u32,
    pub skipped_count: u32,
    pub failed_count: u32,
    pub has_fallback_candidates: bool,
    pub fallback_candidate_asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum CacheKind {
    Thumbnail,
    Video,
}

#[derive(Debug)]
struct PendingFallback {
    asset_id: String,
    original_file_name: String,
    cache_path: String,
}

/// Byte-level progress for a single original-asset download, emitted as the
/// `asset_download_progress` event so the UI can show a real progress bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDownloadProgress {
    pub asset_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    /// 0-100 percentage, or `None` when the total size is unknown.
    pub percent: Option<u32>,
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    log::info!("[oauth:shell] opening external url={}", url);
    open::that(&url).map_err(|err| format!("failed to open url: {err}"))
}

#[tauri::command]
pub async fn open_folder_in_file_explorer(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("Folder does not exist".to_string());
    }
    if !target.is_dir() {
        return Err("Path is not a folder".to_string());
    }

    log::info!(
        "[explorer:open] opening folder in file explorer path={}",
        target.to_string_lossy()
    );
    open_directory_in_explorer(&target)
}

#[tauri::command]
pub async fn copy_assets_to_local_folder(
    asset_ids: Vec<String>,
    destination_folder: String,
    allow_cached_fallback: bool,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<LocalCopyResult, String> {
    copy_assets_to_local_folder_internal(
        asset_ids,
        destination_folder,
        allow_cached_fallback,
        state,
        Some(app),
        "explorer_copy",
        None,
    )
    .await
}

pub async fn copy_assets_to_local_folder_internal(
    asset_ids: Vec<String>,
    destination_folder: String,
    allow_cached_fallback: bool,
    state: tauri::State<'_, AppState>,
    app: Option<tauri::AppHandle>,
    source_kind: &str,
    album_id: Option<&str>,
) -> Result<LocalCopyResult, String> {
    log::info!(
        "[local-copy] start asset_count={} destination={} allow_cached_fallback={}",
        asset_ids.len(),
        destination_folder,
        allow_cached_fallback
    );

    if asset_ids.is_empty() {
        return Err("No assets selected".to_string());
    }

    let destination = PathBuf::from(destination_folder);
    if !destination.exists() {
        return Err("Destination folder does not exist".to_string());
    }
    if !destination.is_dir() {
        return Err("Destination path must be a folder".to_string());
    }

    let mut used_names: HashSet<String> = HashSet::new();
    let mut copied_original_count = 0u32;
    let mut copied_cached_count = 0u32;
    let mut original_unavailable_count = 0u32;
    let mut cache_fallback_available_count = 0u32;
    let mut skipped_count = 0u32;
    let mut failed_count = 0u32;
    let mut pending_fallback: Vec<PendingFallback> = Vec::new();

    let total_assets = asset_ids.len() as u32;

    for asset_id in asset_ids {
        let details = match state.db.get_asset_details(&asset_id) {
            Ok(Some(value)) => value,
            Ok(None) => {
                log::info!("[local-copy] asset not found in cache asset_id={}", asset_id);
                failed_count += 1;
                // Emit progress
                if let Some(ref app) = app {
                    let copied = copied_original_count + copied_cached_count;
                    let _ = app.emit(
                        "album_save_progress",
                        crate::commands::albums::AlbumSaveProgress {
                            total_assets,
                            copied_count: copied,
                            current_file: None,
                            status: format!("Copying... ({}/{})", copied, total_assets),
                        },
                    );
                }
                continue;
            }
            Err(err) => {
                log::info!(
                    "[local-copy] failed to read cached details asset_id={} error={}",
                    asset_id, err
                );
                failed_count += 1;
                // Emit progress
                if let Some(ref app) = app {
                    let copied = copied_original_count + copied_cached_count;
                    let _ = app.emit(
                        "album_save_progress",
                        crate::commands::albums::AlbumSaveProgress {
                            total_assets,
                            copied_count: copied,
                            current_file: None,
                            status: format!("Copying... ({}/{})", copied, total_assets),
                        },
                    );
                }
                continue;
            }
        };

        // If we already saved a copy of this asset into THIS destination folder
        // and the file is still present on disk, reuse it instead of downloading
        // again. This deduplicates repeated save requests (e.g. the download
        // badge copying then auto-zooming, which triggers a second copy).
        let already_saved = state
            .db
            .list_local_saved_asset_paths_for_asset(&details.id)
            .unwrap_or_default()
            .into_iter()
            .find(|saved_path| {
                let saved = Path::new(saved_path);
                saved.is_file() && saved.parent() == Some(destination.as_path())
            });

        if let Some(saved_path) = already_saved {
            log::info!(
                "[local-copy] reusing existing local copy asset_id={} path={}",
                details.id, saved_path
            );
            // Reserve the name so a different asset in this batch doesn't collide.
            if let Some(name) = Path::new(&saved_path)
                .file_name()
                .and_then(|name| name.to_str())
            {
                used_names.insert(name.to_string());
            }
            copied_original_count += 1;
            if let Some(ref app) = app {
                let copied = copied_original_count + copied_cached_count;
                let _ = app.emit(
                    "album_save_progress",
                    crate::commands::albums::AlbumSaveProgress {
                        total_assets,
                        copied_count: copied,
                        current_file: Some(details.original_file_name.clone()),
                        status: format!("Copying... ({}/{})", copied, total_assets),
                    },
                );
            }
            continue;
        }

        // NOTE: `details.original_path` is the asset's path on the Immich
        // SERVER (e.g. a NAS mount). It is never a valid local path on this
        // machine, so we do NOT probe it on disk. Originals are fetched from the
        // server and written directly into the user's local folder.

        log::info!(
            "[local-copy] attempting server original download asset_id={}",
            details.id
        );
        let (_account_id, client) = state.account_and_client_for_asset(&details.id);
        let dest_path =
            resolve_destination_path(&details.original_file_name, &destination, &mut used_names);
        let progress_app = app.clone();
        let progress_asset_id = details.id.clone();
        match client
            .download_asset_original_to_path(&details.id, &dest_path, |downloaded, total| {
                if let Some(ref app) = progress_app {
                    let percent = total.and_then(|total| {
                        if total == 0 {
                            None
                        } else {
                            Some(((downloaded.min(total) * 100) / total) as u32)
                        }
                    });
                    let _ = app.emit(
                        "asset_download_progress",
                        AssetDownloadProgress {
                            asset_id: progress_asset_id.clone(),
                            downloaded_bytes: downloaded,
                            total_bytes: total,
                            percent,
                        },
                    );
                }
            })
            .await
        {
            Ok(()) => {
                log::info!(
                    "[local-copy] downloaded original from server to local folder asset_id={} path={}",
                    details.id,
                    dest_path.to_string_lossy()
                );
                let (mtime_ms, size_bytes) = get_file_snapshot(&dest_path);
                if let Err(err) = state.db.upsert_local_saved_asset(
                    &details.id,
                    album_id,
                    &dest_path.to_string_lossy(),
                    &details.original_file_name,
                    source_kind,
                    mtime_ms,
                    size_bytes,
                ) {
                    log::warn!(
                        "[local-copy] failed to persist copied file tracking asset_id={} path={} err={}",
                        details.id,
                        dest_path.to_string_lossy(),
                        err
                    );
                }
                if let Err(err) =
                    state
                        .db
                        .mark_asset_local_versions(&details.id, false, false, true)
                {
                    log::warn!(
                        "[local-copy] failed to mark local versions asset_id={} err={}",
                        details.id,
                        err
                    );
                }

                copied_original_count += 1;
                // Emit progress
                if let Some(ref app) = app {
                    let copied = copied_original_count + copied_cached_count;
                    let _ = app.emit(
                        "album_save_progress",
                        crate::commands::albums::AlbumSaveProgress {
                            total_assets,
                            copied_count: copied,
                            current_file: Some(details.original_file_name.clone()),
                            status: format!("Copying... ({}/{})", copied, total_assets),
                        },
                    );
                }
                continue;
            }
            Err(err) => {
                // Clean up any partial/empty file left at the destination.
                let _ = fs::remove_file(&dest_path);
                used_names.remove(
                    dest_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default(),
                );
                log::info!(
                    "[local-copy] server original download failed asset_id={} error={}",
                    details.id, err
                );
            }
        }

        original_unavailable_count += 1;
        let cached_candidate = match resolve_cached_fallback_candidate(
            &state,
            &details.id,
            details.r#type.as_deref(),
            details.duration.as_deref(),
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                log::info!(
                    "[local-copy] cache check failed asset_id={} error={}",
                    details.id, err
                );
                None
            }
        };

        if let Some(candidate) = cached_candidate {
            cache_fallback_available_count += 1;
            pending_fallback.push(PendingFallback {
                asset_id: details.id,
                original_file_name: details.original_file_name,
                cache_path: candidate,
            });
        } else {
            log::info!(
                "[local-copy] no cached fallback candidate asset_id={} type={:?} duration_present={}",
                details.id,
                details.r#type,
                details.duration.is_some()
            );
            skipped_count += 1;
        }
    }

    let fallback_candidate_asset_ids = pending_fallback
        .iter()
        .map(|item| item.asset_id.clone())
        .collect::<Vec<_>>();

    if allow_cached_fallback {
        for fallback in pending_fallback {
            let source = Path::new(&fallback.cache_path);
            if !source.exists() || !source.is_file() {
                log::info!(
                    "[local-copy] cached fallback disappeared asset_id={} path={}",
                    fallback.asset_id,
                    fallback.cache_path
                );
                skipped_count += 1;
                continue;
            }

            if stage_file_to_destination(source, &fallback.original_file_name, &destination, &mut used_names)
                .map(|copied_path| {
                    let (mtime_ms, size_bytes) = get_file_snapshot(&copied_path);
                    if let Err(err) = state.db.upsert_local_saved_asset(
                        &fallback.asset_id,
                        album_id,
                        &copied_path.to_string_lossy(),
                        &fallback.original_file_name,
                        source_kind,
                        mtime_ms,
                        size_bytes,
                    ) {
                        log::warn!(
                            "[local-copy] failed to persist copied fallback tracking asset_id={} path={} err={}",
                            fallback.asset_id,
                            copied_path.to_string_lossy(),
                            err
                        );
                    }
                })
                .is_ok()
            {
                copied_cached_count += 1;
            } else {
                failed_count += 1;
            }
        }
    }

    let has_fallback_candidates = cache_fallback_available_count > 0;
    log::info!(
        "[local-copy] done copied_original={} copied_cached={} originals_unavailable={} cache_fallback_candidates={} skipped={} failed={} fallback_enabled={}",
        copied_original_count,
        copied_cached_count,
        original_unavailable_count,
        cache_fallback_available_count,
        skipped_count,
        failed_count,
        allow_cached_fallback
    );

    Ok(LocalCopyResult {
        copied_original_count,
        copied_cached_count,
        original_unavailable_count,
        cache_fallback_available_count,
        skipped_count,
        failed_count,
        has_fallback_candidates,
        fallback_candidate_asset_ids,
    })
}

#[tauri::command]
pub async fn copy_text_to_clipboard(text: String, app: tauri::AppHandle) -> Result<(), String> {
    log::info!(
        "[clipboard:text] copy_text_to_clipboard requested (len={})",
        text.len()
    );
    let clipboard = app.state::<tauri_plugin_clipboard::Clipboard>();
    clipboard.write_text(text).map_err(|err| {
        log::info!("[clipboard:text] write_text failed: {}", err);
        err
    })?;
    log::info!("[clipboard:text] write_text succeeded");
    Ok(())
}

#[tauri::command]
pub async fn copy_assets_to_clipboard(
    asset_ids: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log::info!(
        "[clipboard] copy_assets_to_clipboard requested with {} asset(s)",
        asset_ids.len()
    );

    if asset_ids.is_empty() {
        log::info!("[clipboard] rejected copy request: no assets selected");
        return Err("No assets selected".to_string());
    }

    let staging_dir = create_clipboard_staging_dir()?;
    log::info!(
        "[clipboard] staging files for clipboard in {}",
        staging_dir.to_string_lossy()
    );

    let mut used_names: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::with_capacity(asset_ids.len());

    for asset_id in asset_ids {
        log::info!("[clipboard] resolving thumbnail path for asset_id={}", asset_id);
        let (_account_id, client) = state.account_and_client_for_asset(&asset_id);
        let thumbnail_path = client
            .get_asset_thumbnail_file_path(&asset_id)
            .await
            .map_err(|err| {
                log::info!(
                    "[clipboard] failed to resolve thumbnail path for asset_id={}: {}",
                    asset_id, err
                );
                format!("failed to load thumbnail for {asset_id}: {err}")
            })?;

        let asset = client.get_asset(&asset_id).await.map_err(|err| {
            log::info!(
                "[clipboard] failed to resolve asset details for asset_id={}: {}",
                asset_id, err
            );
            format!("failed to load asset details for {asset_id}: {err}")
        })?;

        let staged_path = stage_clipboard_file(
            &thumbnail_path,
            &asset.original_file_name,
            &staging_dir,
            &mut used_names,
        )?;
        log::info!(
            "[clipboard] staged asset_id={} as {}",
            asset_id,
            staged_path.to_string_lossy()
        );
        paths.push(staged_path.to_string_lossy().to_string());
    }

    log::info!(
        "[clipboard] attempting plugin clipboard write for {} path(s)",
        paths.len()
    );
    copy_file_paths_with_plugin(&app, &paths).map_err(|err| {
        log::info!("[clipboard] plugin clipboard write failed: {}", err);
        err
    })?;

    log::info!(
        "[clipboard] plugin clipboard write succeeded for {} file(s)",
        paths.len()
    );
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn copy_file_paths_with_plugin(app: &tauri::AppHandle, paths: &[String]) -> Result<(), String> {
    let clipboard = app.state::<tauri_plugin_clipboard::Clipboard>();
    let files_uris = build_plugin_file_uris(paths);
    clipboard.write_files_uris(files_uris)
}

#[cfg(target_os = "macos")]
fn build_plugin_file_uris(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|path| format!("file://{}", path))
        .collect()
}

#[cfg(target_os = "windows")]
fn build_plugin_file_uris(paths: &[String]) -> Vec<String> {
    paths.to_vec()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn copy_file_paths_with_plugin(_app: &tauri::AppHandle, _paths: &[String]) -> Result<(), String> {
    Err("plugin clipboard path is currently only enabled on macOS and Windows".to_string())
}

fn create_clipboard_staging_dir() -> Result<PathBuf, String> {
    let home =
        crate::util::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
    let base = home
        .join(".config")
        .join("immich-local-app")
        .join("clipboard-export");
    fs::create_dir_all(&base).map_err(|err| err.to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis();
    let request_dir = base.join(format!("request-{}", now));
    fs::create_dir_all(&request_dir).map_err(|err| err.to_string())?;
    Ok(request_dir)
}

fn stage_file_to_destination(
    source: &Path,
    original_file_name: &str,
    destination_dir: &Path,
    used_names: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let mut base_name = sanitize_file_name(original_file_name);
    if base_name.is_empty() {
        base_name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "asset.bin".to_string());
    }

    if Path::new(&base_name).extension().is_none() {
        if let Some(ext) = source.extension().and_then(|ext| ext.to_str()) {
            base_name.push('.');
            base_name.push_str(ext);
        }
    }

    let unique_name = make_unique_name(&base_name, used_names);
    let destination = destination_dir.join(unique_name);
    fs::copy(source, &destination).map_err(|err| {
        format!(
            "failed to copy {} -> {}: {}",
            source.to_string_lossy(),
            destination.to_string_lossy(),
            err
        )
    })?;

    Ok(destination)
}

/// Compute a unique destination path inside `destination_dir` for an original
/// file, without copying anything. Used when downloading an original directly
/// into the user's local folder (never the cache).
fn resolve_destination_path(
    original_file_name: &str,
    destination_dir: &Path,
    used_names: &mut HashSet<String>,
) -> PathBuf {
    let mut base_name = sanitize_file_name(original_file_name);
    if base_name.is_empty() {
        base_name = "asset.bin".to_string();
    }

    let unique_name = make_unique_name(&base_name, used_names);
    destination_dir.join(unique_name)
}

fn infer_cache_kind(asset_type: Option<&str>, duration: Option<&str>) -> CacheKind {
    let asset_type_lower = asset_type.unwrap_or_default().to_ascii_lowercase();
    if asset_type_lower.contains("video") || duration.is_some() {
        CacheKind::Video
    } else {
        CacheKind::Thumbnail
    }
}

fn get_file_snapshot(path: &Path) -> (Option<i64>, Option<i64>) {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(_) => return (None, None),
    };

    let size_bytes = i64::try_from(metadata.len()).ok();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_millis()).ok());

    (mtime_ms, size_bytes)
}

async fn cached_path_if_exists(
    state: &tauri::State<'_, AppState>,
    asset_id: &str,
    cache_kind: CacheKind,
) -> Result<Option<String>, String> {
    match cache_kind {
        CacheKind::Thumbnail => {
            let (_account_id, client) = state.account_and_client_for_asset(asset_id);
            client.get_cached_thumbnail_path(asset_id).await
        }
        CacheKind::Video => {
            let (_account_id, client) = state.account_and_client_for_asset(asset_id);
            client.get_cached_video_path(asset_id).await
        }
    }
}

async fn resolve_cached_fallback_candidate(
    state: &tauri::State<'_, AppState>,
    asset_id: &str,
    asset_type: Option<&str>,
    duration: Option<&str>,
) -> Result<Option<String>, String> {
    let thumbnail = cached_path_if_exists(state, asset_id, CacheKind::Thumbnail).await?;
    let video = cached_path_if_exists(state, asset_id, CacheKind::Video).await?;

    let inferred = infer_cache_kind(asset_type, duration);
    let preferred = match inferred {
        CacheKind::Video => video.clone().or(thumbnail.clone()),
        CacheKind::Thumbnail => thumbnail.clone().or(video.clone()),
    };

    log::info!(
        "[local-copy] cache probe asset_id={} inferred_kind={:?} thumbnail_cached={} video_cached={}",
        asset_id,
        inferred,
        thumbnail.is_some(),
        video.is_some()
    );

    Ok(preferred)
}

#[cfg(target_os = "macos")]
fn open_directory_in_explorer(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|err| format!("failed to open Finder: {err}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_directory_in_explorer(path: &Path) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|err| format!("failed to open File Explorer: {err}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_directory_in_explorer(_path: &Path) -> Result<(), String> {
    Err("Open in file explorer is currently only supported on macOS and Windows".to_string())
}

fn stage_clipboard_file(
    source_path: &str,
    original_file_name: &str,
    staging_dir: &Path,
    used_names: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let source = Path::new(source_path);
    if !source.exists() {
        return Err(format!("source file does not exist: {}", source_path));
    }

    let mut base_name = sanitize_file_name(original_file_name);
    if base_name.is_empty() {
        base_name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "image.jpg".to_string());
    }

    if Path::new(&base_name).extension().is_none() {
        if let Some(ext) = source.extension().and_then(|ext| ext.to_str()) {
            base_name.push('.');
            base_name.push_str(ext);
        }
    }

    let unique_name = make_unique_name(&base_name, used_names);
    let destination = staging_dir.join(unique_name);
    fs::copy(source, &destination).map_err(|err| {
        format!(
            "failed to stage file {} -> {}: {}",
            source_path,
            destination.to_string_lossy(),
            err
        )
    })?;

    Ok(destination)
}

fn sanitize_file_name(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn make_unique_name(base_name: &str, used_names: &mut HashSet<String>) -> String {
    let path = Path::new(base_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = path.extension().and_then(|value| value.to_str());

    let mut counter = 0usize;
    loop {
        let candidate = if counter == 0 {
            match extension {
                Some(ext) => format!("{}.{}", stem, ext),
                None => stem.to_string(),
            }
        } else {
            match extension {
                Some(ext) => format!("{}-{}.{}", stem, counter, ext),
                None => format!("{}-{}", stem, counter),
            }
        };

        if used_names.insert(candidate.clone()) {
            return candidate;
        }
        counter += 1;
    }
}
