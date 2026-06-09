use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::AppState;
use tauri::Manager;

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    println!("[oauth:shell] opening external url={}", url);
    open::that(&url).map_err(|err| format!("failed to open url: {err}"))
}

#[tauri::command]
pub async fn copy_assets_to_clipboard(
    asset_ids: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    println!(
        "[clipboard] copy_assets_to_clipboard requested with {} asset(s)",
        asset_ids.len()
    );

    if asset_ids.is_empty() {
        println!("[clipboard] rejected copy request: no assets selected");
        return Err("No assets selected".to_string());
    }

    let staging_dir = create_clipboard_staging_dir()?;
    println!(
        "[clipboard] staging files for clipboard in {}",
        staging_dir.to_string_lossy()
    );

    let mut used_names: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::with_capacity(asset_ids.len());

    for asset_id in asset_ids {
        println!("[clipboard] resolving thumbnail path for asset_id={}", asset_id);
        let thumbnail_path = state
            .immich
            .get_asset_thumbnail_file_path(&asset_id)
            .await
            .map_err(|err| {
                println!(
                    "[clipboard] failed to resolve thumbnail path for asset_id={}: {}",
                    asset_id, err
                );
                format!("failed to load thumbnail for {asset_id}: {err}")
            })?;

        let asset = state.immich.get_asset(&asset_id).await.map_err(|err| {
            println!(
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
        println!(
            "[clipboard] staged asset_id={} as {}",
            asset_id,
            staged_path.to_string_lossy()
        );
        paths.push(staged_path.to_string_lossy().to_string());
    }

    println!(
        "[clipboard] attempting plugin clipboard write for {} path(s)",
        paths.len()
    );
    copy_file_paths_with_plugin(&app, &paths).map_err(|err| {
        println!("[clipboard] plugin clipboard write failed: {}", err);
        err
    })?;

    println!(
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
    let home = std::env::var("HOME").map_err(|_| "cannot resolve home directory".to_string())?;
    let base = Path::new(&home)
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
