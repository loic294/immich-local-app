use crate::services::media::{file_hash, EditorJob, MediaPreferences, UploadJob};
use crate::AppState;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Emitter;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub checksum: String,
    pub already_imported: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPage {
    pub files: Vec<ImportFile>,
    pub has_more: bool,
}

#[tauri::command]
pub async fn get_import_preview(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    if media_kind(Path::new(&path)) == Some("video") {
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|e| e.to_string())?;
        return Ok(path);
    }
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        if media_kind(Path::new(&path)) != Some("photo") {
            return Err("Unsupported preview file".into());
        }
        let decoded = image::ImageReader::open(&path)
            .map_err(|e| format!("Cannot load preview: {e}"))?
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .decode();
        let image = match decoded {
            Ok(image) => image,
            Err(_) => {
                use sha1::{Digest, Sha1};
                let checksum = db.cached_import_hash(Path::new(&path))?;
                let filename = format!("{:x}.jpg", Sha1::digest(checksum.as_bytes()));
                let folder = crate::services::storage::cache_root()?.join("import-previews");
                std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                let preview = folder.join(filename);
                if !preview.is_file() {
                    crate::services::import_preview::native_preview(Path::new(&path), &preview)?;
                }
                let image =
                    image::open(&preview).map_err(|e| format!("Invalid native thumbnail: {e}"))?;
                let limit = db.get_feature_preferences()?.max_cache_bytes;
                crate::services::storage::evict(&db, limit, None, true)?;
                image
            }
        };
        let thumbnail = image.thumbnail(240, 240);
        let mut bytes = std::io::Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut bytes, image::ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_media_preferences(
    state: tauri::State<'_, AppState>,
) -> Result<MediaPreferences, String> {
    state.db.media_preferences()
}

#[tauri::command]
pub async fn update_media_preferences(
    preferences: MediaPreferences,
    state: tauri::State<'_, AppState>,
) -> Result<MediaPreferences, String> {
    let _telemetry_guard = telemetry_lock().lock().await;
    if preferences.editor_executable.trim().is_empty() {
        return Err("Editor executable is required".into());
    }
    if preferences.editor_export_args.is_empty()
        || !preferences
            .editor_export_args
            .iter()
            .any(|a| a.contains("{input}"))
        || !preferences
            .editor_export_args
            .iter()
            .any(|a| a.contains("{output}"))
    {
        return Err("Export arguments must include {input} and {output}".into());
    }
    if preferences
        .editor_sidecars
        .iter()
        .any(|e| e.is_empty() || !e.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return Err("Sidecar extensions must contain only letters and numbers".into());
    }
    let previous = state.db.media_preferences()?;
    state.db.save_media_preferences(&preferences)?;
    log::info!(
        "[media:settings] saved telemetry_enabled={}",
        preferences.telemetry_enabled
    );
    if previous.telemetry_enabled && !preferences.telemetry_enabled {
        // This is the final event; preference is already persisted so every other event stops.
        if let Err(error) = send_telemetry("telemetry-disabled", None).await {
            log::warn!("[telemetry] final disabled event unavailable: {error}");
        }
    }
    Ok(preferences)
}

#[tauri::command]
pub async fn list_media_devices() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os="macos")]
        {
            fn mounted_paths(value:&plist::Value, paths:&mut Vec<String>) {
                match value {
                    plist::Value::Dictionary(values)=>{
                        if let Some(path)=values.get("MountPoint").and_then(plist::Value::as_string) {
                            paths.push(path.to_string());
                        }
                        for value in values.values(){mounted_paths(value,paths);}
                    }
                    plist::Value::Array(values)=>for value in values {mounted_paths(value,paths);},
                    _=>{},
                }
            }
            let output=std::process::Command::new("/usr/sbin/diskutil").args(["list","-plist","external"])
                .output().map_err(|error|format!("Cannot inspect external disks: {error}"))?;
            if !output.status.success(){return Err("macOS external disk detection failed".into());}
            let value=plist::Value::from_reader_xml(std::io::Cursor::new(output.stdout))
                .map_err(|error|format!("Invalid macOS disk inventory: {error}"))?;
            let mut paths=Vec::new();
            mounted_paths(&value,&mut paths);
            paths.sort();paths.dedup();
            Ok(paths)
        }
        #[cfg(target_os="windows")]
        {
            let output=std::process::Command::new("powershell.exe")
                .args(["-NoProfile","-NonInteractive","-Command",
                "$ErrorActionPreference='Stop'; $r=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | ForEach-Object {$_.DeviceID+'\\'}); $r+=@(Get-Disk | Where-Object BusType -eq USB | Get-Partition | Where-Object DriveLetter | ForEach-Object {$_.DriveLetter+':\\'}); ConvertTo-Json -Compress -InputObject @($r | Sort-Object -Unique)"])
                .output().map_err(|e|format!("Cannot inspect removable media: {e}"))?;
            if !output.status.success() { return Err("Windows removable media detection failed".into()); }
            serde_json::from_slice(&output.stdout).map_err(|e|format!("Invalid Windows volume response: {e}"))
        }
        #[cfg(not(any(target_os="macos",target_os="windows")))]
        { Err("Media-device detection supports macOS and Windows only".into()) }
    }).await.map_err(|e|e.to_string())?
}

fn media_kind(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if [
        "jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff", "dng", "cr2", "cr3", "nef",
        "arw", "raf", "orf", "rw2",
    ]
    .contains(&extension.as_str())
    {
        Some("photo")
    } else if ["mp4", "mov", "m4v", "webm", "mkv", "avi", "mts", "m2ts"]
        .contains(&extension.as_str())
    {
        Some("video")
    } else {
        None
    }
}

fn collect_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in
        std::fs::read_dir(root).map_err(|e| format!("Cannot scan {}: {e}", root.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_files(&entry.path(), files)?;
        } else if kind.is_file() && media_kind(&entry.path()).is_some() {
            files.push(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn scan_import_media(
    root: String,
    page: u32,
    kind: String,
    state: tauri::State<'_, AppState>,
) -> Result<ImportPage, String> {
    if !["all", "photo", "video"].contains(&kind.as_str()) {
        return Err("Invalid media filter".into());
    }
    let account = state.primary_account_id();
    if account.is_empty() {
        return Err("Sign in before importing media".into());
    }
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        collect_files(Path::new(&root), &mut files)?;
        files.sort();
        files.retain(|p| kind == "all" || media_kind(p) == Some(kind.as_str()));
        let start = (page as usize)
            .checked_mul(60)
            .ok_or("Import page is too large")?;
        let has_more = files.len() > start.saturating_add(60);
        let mut result = Vec::new();
        for path in files.into_iter().skip(start).take(60) {
            let checksum = db.cached_import_hash(&path)?;
            result.push(ImportFile {
                already_imported: db.known_media_hash(&account, &checksum)?,
                checksum,
                name: path
                    .file_name()
                    .ok_or("Invalid filename")?
                    .to_string_lossy()
                    .into_owned(),
                kind: media_kind(&path).ok_or("Unsupported media")?.into(),
                size: std::fs::metadata(&path).map_err(|e| e.to_string())?.len(),
                path: path.to_string_lossy().into_owned(),
            });
        }
        log::info!("[media:scan] page={} files={}", page, result.len());
        Ok(ImportPage {
            files: result,
            has_more,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn safe_component(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        "Imported".into()
    } else {
        name.into()
    }
}

fn copy_without_overwrite(source: &Path, folder: &Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(folder).map_err(|e| format!("Cannot create import folder: {e}"))?;
    let name = safe_component(name);
    let path = Path::new(&name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    for suffix in 0..10_000 {
        let filename = if suffix == 0 {
            name.clone()
        } else {
            format!(
                "{stem}-{suffix}{}{}",
                if extension.is_empty() { "" } else { "." },
                extension
            )
        };
        let destination = folder.join(filename);
        let mut output = match std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Cannot retain original: {e}")),
        };
        let result = std::fs::File::open(source)
            .and_then(|mut input| std::io::copy(&mut input, &mut output))
            .and_then(|_| output.sync_all());
        if let Err(e) = result {
            drop(output);
            if let Err(cleanup) = std::fs::remove_file(&destination) {
                log::error!("[media:copy] partial file cleanup failed: {cleanup}");
            }
            return Err(format!("Could not copy original: {e}"));
        }
        return Ok(destination);
    }
    Err("Too many files with the same name".into())
}

#[tauri::command]
pub async fn import_media(
    paths: Vec<String>,
    album_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let preferences = state.db.media_preferences()?;
    if paths.is_empty() {
        return Err("Select media to import".into());
    }
    if preferences.import_requires_album && album_id.is_none() {
        return Err("Select or create an album before importing".into());
    }
    let account = state.primary_account_id();
    if account.is_empty() {
        return Err("No account is signed in".into());
    }
    if let Some(id) = &album_id {
        if state.db.get_album_account_id(id)?.as_deref() != Some(account.as_str()) {
            return Err("Choose an album belonging to the primary account".into());
        }
    }
    let settings = state.db.get_settings()?;
    if settings.user_local_folder_path.trim().is_empty() {
        return Err("Configure your local folder in Settings before importing".into());
    }
    let album_name = match &album_id {
        Some(id) => {
            state
                .db
                .get_albums()?
                .into_iter()
                .find(|a| &a.id == id)
                .ok_or("Album is not cached")?
                .album_name
        }
        None => "Unsorted".into(),
    };
    let folder = PathBuf::from(settings.user_local_folder_path)
        .join("Albums")
        .join(safe_component(&album_name));
    let db = state.db.clone();
    let progress_app = app.clone();
    let copied = tokio::task::spawn_blocking(move || {
        let mut count = 0;
        for source in paths {
            let path = PathBuf::from(&source);
            if !path.is_file() || media_kind(&path).is_none() {
                return Err(format!("Unsupported import file: {source}"));
            }
            let checksum = file_hash(&path)?;
            if db.known_media_hash(&account, &checksum)? {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("Invalid filename")?;
            let retained = copy_without_overwrite(&path, &folder, name)?;
            let job = UploadJob {
                id: uuid::Uuid::new_v4().to_string(),
                account_id: account.clone(),
                local_path: retained.to_string_lossy().into_owned(),
                checksum,
                album_ids: album_id.iter().cloned().collect(),
                original_asset_id: None,
                server_asset_id: None,
                state: "queued".into(),
                error: None,
            };
            if let Err(error) = db.queue_media(&job) {
                log::error!(
                    "[media:import] queue failed retained={} error={error}",
                    retained.display()
                );
                return Err(format!(
                    "{error}; original copy retained at {}",
                    retained.display()
                ));
            }
            count += 1;
            if count == 1 {
                kick_media_uploads(progress_app.clone());
            }
            progress_app
                .emit("media:progress", count)
                .map_err(|e| format!("Import progress notification failed: {e}"))?;
        }
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())??;
    log::info!("[media:import] originals retained and queued count={copied}");
    kick_media_uploads(app);
    Ok(copied)
}

#[tauri::command]
pub async fn get_media_uploads(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<UploadJob>, String> {
    state.db.media_uploads()
}

#[tauri::command]
pub async fn retry_media_uploads(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    state.db.init_media()?;
    state
        .db
        .open()?
        .execute(
            "UPDATE media_uploads SET state='queued',error=NULL WHERE state='failed'",
            [],
        )
        .map_err(|e| e.to_string())?;
    log::info!("[media:upload] failed jobs reset; queue retry requested");
    kick_media_uploads(app);
    Ok(())
}

fn kick_media_uploads(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if let Err(error) = process_media_uploads(&state).await {
            log::warn!("[media:upload] background flush deferred: {error}");
        }
    });
}

#[tauri::command]
pub async fn flush_media_uploads(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    process_media_uploads(&state).await
}

async fn process_media_uploads(state: &AppState) -> Result<u32, String> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    log::info!("[media:upload] processing queue");
    state.db.recover_media_uploads()?;
    let mut done = 0;
    let mut deferred = HashSet::new();
    loop {
        let jobs: Vec<_> = state
            .db
            .media_uploads()?
            .into_iter()
            .filter(|job| job.state == "queued" && !deferred.contains(&job.id))
            .collect();
        if jobs.is_empty() {
            break;
        }
        for job in jobs {
            if job.state != "queued" {
                continue;
            }
            let Some(client) = state.accounts.client(&job.account_id) else {
                log::error!(
                    "[media:upload] missing account job={} account={}",
                    job.id,
                    job.account_id
                );
                state.db.set_media_upload_state(
                    &job.id,
                    "failed",
                    Some("Upload account is not signed in"),
                )?;
                continue;
            };
            let Some(session) = client.session.lock().await.clone() else {
                state.db.set_media_upload_state(
                    &job.id,
                    "failed",
                    Some("Upload account is not authenticated"),
                )?;
                continue;
            };
            if !client.ping(&session.server_url).await {
                log::warn!(
                    "[media:upload] offline; retaining queued job={} account={}",
                    job.id,
                    job.account_id
                );
                deferred.insert(job.id.clone());
                continue;
            }
            state
                .db
                .set_media_upload_state(&job.id, "uploading", None)?;
            log::info!("[media:upload] uploading job={}", job.id);
            let result:Result<(),String>=async {
            let id=match job.server_asset_id.clone() {
                Some(id)=>id,
                None=>{
                    let original=job.original_asset_id.as_deref().map(|id|state.db.get_asset_details(id)).transpose()?.flatten();
                    let captured_at=original.as_ref().and_then(|asset|asset.file_created_at.as_deref());
                    let original_path=match job.original_asset_id.as_deref() {
                        Some(id)=>state.db.editor_jobs()?.into_iter().find(|j|j.asset_id==id).map(|j|j.local_path),
                        None=>None,
                    };
                    let sidecar_base=original_path.as_deref().unwrap_or(&job.local_path);
                    let sidecar=Path::new(sidecar_base).with_extension("xmp");
                    let id=client.upload_retained_media(Path::new(&job.local_path),&job.checksum,captured_at,
                        sidecar.is_file().then_some(sidecar.as_path())).await?;
                    state.db.open()?.execute("UPDATE media_uploads SET server_asset_id=?1 WHERE id=?2",params![id,job.id]).map_err(|e|e.to_string())?;
                    id
                },
            };
            let asset=client.get_asset(&id).await?;
            let metadata=client.get_asset_metadata(&id).await?;
            let enriched=crate::commands::sync::to_enriched_asset_record(asset,Some(metadata));
            state.db.upsert_assets_with_metadata(&job.account_id,&[enriched.asset])?;
            state.db.replace_asset_people(&job.account_id,&[(id.clone(),enriched.person_ids)])?;
            let path=Path::new(&job.local_path);
            let metadata=std::fs::metadata(path).map_err(|e|e.to_string())?;
            state.db.upsert_local_saved_asset(&id,job.album_ids.first().map(String::as_str),&job.local_path,
                path.file_name().and_then(|n|n.to_str()).ok_or("Invalid local filename")?,"media_import",
                None,Some(metadata.len() as i64))?;
            for album in &job.album_ids {
                client.add_assets_to_album(album,&[id.clone()]).await?;
                state.db.open()?.execute(
                    "INSERT OR IGNORE INTO album_assets(album_id,asset_id,account_id) VALUES(?1,?2,?3)",
                    params![album,id,job.account_id],
                ).map_err(|e|e.to_string())?;
                if let Err(error) = state.db.record_recent_album(album) {
                    log::warn!("[media:upload] could not record recent album={} job={}: {}", album, job.id, error);
                }
            }
            if let Some(original)=&job.original_asset_id {
                for album in state.db.media_album_ids(original)? {
                    if !job.album_ids.contains(&album) {
                        client.add_assets_to_album(&album,&[id.clone()]).await?;
                    }
                    if let Err(error) = state.db.record_recent_album(&album) {
                        log::warn!("[media:upload] could not record recent album={} job={}: {}", album, job.id, error);
                    }
                }
                let mut ids=vec![id.clone()];
                ids.extend(state.db.edit_version_ids(original)?);
                ids.push(original.clone());
                let mut seen=HashSet::new();
                ids.retain(|id|seen.insert(id.clone()));
                client.create_edit_stack(&ids).await?;
                state.db.record_edit_stack(original, &id, &ids)?;
            }
            state.db.open()?.execute("UPDATE media_uploads SET state='complete',error=NULL,completed_at=?1 WHERE id=?2",
                params![chrono::Utc::now().to_rfc3339(),job.id]).map_err(|e|e.to_string())?;
            Ok(())
        }.await;
            match result {
                Ok(()) => {
                    done += 1;
                    log::info!("[media:upload] completed job={}", job.id);
                }
                Err(error) => {
                    if !client.ping(&session.server_url).await {
                        log::warn!("[media:upload] connection lost job={}", job.id);
                        state.db.set_media_upload_state(&job.id, "queued", None)?;
                        deferred.insert(job.id.clone());
                        continue;
                    }
                    log::error!("[media:upload] failed job={} error={error}", job.id);
                    state
                        .db
                        .open()?
                        .execute(
                            "UPDATE media_uploads SET state='failed',error=?1 WHERE id=?2",
                            params![error, job.id],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    log::info!(
        "[media:upload] flush finished completed={done} deferred={}",
        deferred.len()
    );
    if done == 0 && !deferred.is_empty() {
        return Err("offline: uploads retained locally for retry".into());
    }
    Ok(done)
}

fn sidecar_snapshot(path: &Path, extensions: &[String]) -> Result<String, String> {
    let mut values = Vec::new();
    for extension in extensions {
        for sidecar in [
            path.with_extension(extension),
            PathBuf::from(format!("{}.{}", path.display(), extension)),
        ] {
            if sidecar.is_file() {
                values.push(format!("{}:{}", sidecar.display(), file_hash(&sidecar)?));
            }
        }
    }
    values.sort();
    values.dedup();
    Ok(values.join("\n"))
}

#[tauri::command]
pub async fn begin_media_edit(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if asset_ids.is_empty() {
        return Err("No images selected".into());
    }
    let preferences = state.db.media_preferences()?;
    let settings = state.db.get_settings()?;
    if settings.user_local_folder_path.trim().is_empty() {
        return Err("Configure a local folder in Settings before editing".into());
    }
    let mut roots = HashSet::new();
    let mut photo_paths = Vec::new();
    for id in asset_ids {
        let original = state.db.original_edit_asset(&id)?;
        if !roots.insert(original.clone()) {
            continue;
        }
        let details = state
            .db
            .get_asset_details(&original)?
            .ok_or("Original image is not cached")?;
        if details.r#type.as_deref() == Some("VIDEO") {
            return Err("External photo editing is not available for videos".into());
        }
        let local = state
            .db
            .list_local_original_paths_for_asset(&original)?
            .into_iter()
            .find(|p| Path::new(p).is_file());
        let path = match local {
            Some(path) => PathBuf::from(path),
            None => {
                let folder = PathBuf::from(&settings.user_local_folder_path)
                    .join("Editing")
                    .join(&original);
                std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                let path = folder.join(safe_component(&details.original_file_name));
                let (_, client) = state.account_and_client_for_asset(&original);
                let session = client
                    .session
                    .lock()
                    .await
                    .clone()
                    .ok_or("Not authenticated")?;
                if !client.ping(&session.server_url).await {
                    return Err("offline: the original is not saved locally".into());
                }
                client
                    .download_asset_original_to_path(&original, &path, |_, _| {})
                    .await?;
                state.db.upsert_local_saved_asset(
                    &original,
                    None,
                    &path.to_string_lossy(),
                    &details.original_file_name,
                    "editor_original",
                    None,
                    None,
                )?;
                path
            }
        };
        let snapshot = sidecar_snapshot(&path, &preferences.editor_sidecars)?;
        state.db.save_editor_job(&EditorJob {
            asset_id: original.clone(),
            local_path: path.to_string_lossy().into_owned(),
            snapshot,
        })?;
        photo_paths.push(path);
    }
    let count = photo_paths.len();
    let executable = preferences.editor_executable.clone();
    let child = tokio::task::spawn_blocking(move || {
        std::process::Command::new(executable)
            .args(photo_paths)
            .spawn()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not open editor; check its executable in Settings: {e}"))?;
    std::thread::spawn(move || {
        let mut child = child;
        match child.wait() {
            Ok(status) if status.success() => {}
            Ok(status) => log::warn!("[media:editor] exited status={status}"),
            Err(e) => log::error!("[media:editor] wait failed: {e}"),
        }
    });
    log::info!("[media:editor] GUI launched original_count={count}");
    Ok(())
}

#[tauri::command]
pub async fn get_changed_editor_jobs(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EditorJob>, String> {
    let db = state.db.clone();
    let preferences = state.db.media_preferences()?;
    tokio::task::spawn_blocking(move || {
        let mut changed = Vec::new();
        for job in db.editor_jobs()? {
            if sidecar_snapshot(Path::new(&job.local_path), &preferences.editor_sidecars)?
                != job.snapshot
            {
                changed.push(job);
            }
        }
        Ok(changed)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_media_edits(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let preferences = state.db.media_preferences()?;
    let jobs = state.db.editor_jobs()?;
    let mut count = 0;
    for id in asset_ids {
        let job = jobs
            .iter()
            .find(|j| j.asset_id == id)
            .ok_or("Editor session no longer exists")?;
        let input = Path::new(&job.local_path);
        let snapshot = sidecar_snapshot(input, &preferences.editor_sidecars)?;
        if snapshot == job.snapshot {
            continue;
        }
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Invalid original filename")?;
        let base = format!("{stem}-edited-{}", chrono::Local::now().format("%Y%m%d"));
        let mut output = input.with_file_name(format!("{base}.jpg"));
        for suffix in 1..=10_000 {
            if !output.exists() {
                break;
            }
            output = input.with_file_name(format!("{base}-{suffix}.jpg"));
        }
        if output.exists() {
            return Err("No available edited filename".into());
        }
        let args: Vec<_> = preferences
            .editor_export_args
            .iter()
            .map(|arg| {
                arg.replace("{input}", &job.local_path)
                    .replace("{output}", &output.to_string_lossy())
            })
            .collect();
        let executable = preferences.editor_executable.clone();
        log::info!("[media:export] starting original={id}");
        let mut child = tokio::process::Command::new(executable)
            .args(args)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not execute export command: {e}"))?;
        let status = tokio::time::timeout(std::time::Duration::from_secs(1800), child.wait())
            .await
            .map_err(|_| "Editor export exceeded 30 minutes; changes remain pending".to_string())?
            .map_err(|e| format!("Editor export failed: {e}"))?;
        if !status.success() {
            return Err(format!(
                "Editor export failed ({status}); sidecar changes remain pending"
            ));
        }
        if !output.is_file() || std::fs::metadata(&output).map_err(|e| e.to_string())?.len() == 0 {
            return Err("Editor did not produce a non-empty JPEG".into());
        }
        match tokio::task::spawn_blocking({
            let source = input.to_path_buf();
            let destination = output.clone();
            move || crate::services::media::copy_jpeg_metadata(&source, &destination)
        })
        .await
        {
            Ok(Ok(())) => log::info!("[media:export] original EXIF/XMP metadata copied original={id}"),
            Ok(Err(error)) => log::warn!("[media:export] metadata copy failed original={id}; continuing export: {error}"),
            Err(error) => log::warn!("[media:export] metadata copy task failed original={id}; continuing export: {error}"),
        }
        let hash_path = output.clone();
        let checksum = tokio::task::spawn_blocking(move || file_hash(&hash_path))
            .await
            .map_err(|e| e.to_string())??;
        let (account, _) = state.account_and_client_for_asset(&id);
        state.db.queue_media(&UploadJob {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: account,
            local_path: output.to_string_lossy().into_owned(),
            checksum,
            album_ids: state.db.media_album_ids(&id)?,
            original_asset_id: Some(id.clone()),
            server_asset_id: None,
            state: "queued".into(),
            error: None,
        })?;
        state.db.save_editor_job(&EditorJob {
            snapshot,
            ..job.clone()
        })?;
        count += 1;
        log::info!("[media:export] JPEG retained and queued original={id}");
        kick_media_uploads(app.clone());
    }
    Ok(count)
}

/// The original is protected independently of the current primary. Deleting
/// the active edit restores the original locally and on the server (or replay).
#[tauri::command]
pub async fn delete_edit_version(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    if !state.db.is_deletable_edit_version(&asset_id)? {
        return Err("Only an edited version can be deleted; the original is protected".into());
    }
    let (account_id, client) = state.account_and_client_for_asset(&asset_id);
    if account_id.is_empty() {
        return Err("offline: Cannot identify the account for this version".into());
    }
    let original = state.db.original_edit_asset(&asset_id)?;
    let account = state.db.get_account(&account_id)?.ok_or("Unknown account")?;
    if client.ping(&account.server_url).await {
        match client.trash_edit_version(&asset_id, &original).await {
            Ok(()) => {
                state.db.remove_edit_version_from_cache(&asset_id, None)?;
                log::info!("[media:version-delete] moved version to Immich trash asset={asset_id}");
                return Ok(false);
            }
            Err(error) => {
                log::warn!(
                    "[media:version-delete] server operation failed asset={asset_id}: {error}"
                );
                if client.ping(&account.server_url).await {
                    return Err(error);
                }
            }
        }
    }
    state
        .db
        .remove_edit_version_from_cache(&asset_id, Some(&account_id))?;
    log::info!("[media:version-delete] queued offline trash asset={asset_id}");
    Ok(true)
}

#[tauri::command]
pub async fn get_edit_versions(
    asset_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::services::immich_client::AssetSummary>, String> {
    let original = state.db.original_edit_asset(&asset_id)?;
    let mut ids = state.db.edit_version_ids(&original)?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    ids.push(original);
    let mut result = Vec::new();
    for id in ids {
        if let Some(asset) = state.db.get_asset_summary(&id)? {
            result.push(asset);
        }
    }
    Ok(result)
}

const TELEMETRY_EVENTS: &[&str] = &[
    "page-photos",
    "page-albums",
    "page-people",
    "page-maps",
    "page-calendar",
    "page-folders",
    "page-favorites",
    "page-deleted",
    "page-settings",
    "feature-import",
    "feature-edit",
    "feature-export",
    "feature-time-correction",
    "feature-search",
];

fn telemetry_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TelemetryContext {
    user_agent: String,
    language: String,
    screen: String,
    hostname: String,
}

fn browser_user_agent(provided: &str) -> String {
    if provided.starts_with("Mozilla/5.0") && !provided.contains(['\r', '\n']) {
        return provided.to_string();
    }
    if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36".into()
    } else {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15".into()
    }
}

async fn send_telemetry(event: &str, context: Option<TelemetryContext>) -> Result<(), String> {
    let context = context.unwrap_or_default();
    let response = reqwest::Client::new()
        .post("https://analytics.loicbellemarealford.ca/api/send")
        .header(reqwest::header::USER_AGENT, browser_user_agent(&context.user_agent))
        .timeout(std::time::Duration::from_secs(5))
        .json(&serde_json::json!({
            "type":"event","payload":{"website":"d905c3e7-0c82-42fc-9e06-c30f478bda13",
            "hostname": if context.hostname.is_empty() { "immich-local-app" } else { &context.hostname },
            "url":"/desktop","name":event,
            "language": if context.language.is_empty() { "en-CA" } else { &context.language },
            "screen":context.screen}
        }))
        .send().await.map_err(|e| format!("Telemetry delivery unavailable: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Cannot read analytics response: {e}"))?;
    // Successful responses may contain a session-cache token: never log that token.
    let mut diagnostic =
        serde_json::from_str::<serde_json::Value>(&body).unwrap_or(serde_json::Value::Null);
    if let Some(object) = diagnostic.as_object_mut() {
        for key in ["cache", "session", "token"] {
            if object.contains_key(key) {
                object.insert(key.into(), "[redacted]".into());
            }
        }
    }
    log::info!(
        "[telemetry] event={event} status={} body={diagnostic}",
        status.as_u16()
    );
    if !status.is_success() {
        return Err(format!(
            "Analytics rejected event (HTTP {})",
            status.as_u16()
        ));
    }
    if diagnostic.get("beep").is_some() {
        return Err("Analytics rejected event as bot traffic".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn track_media_event(
    event: String,
    context: Option<TelemetryContext>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _telemetry_guard = telemetry_lock().lock().await;
    if !TELEMETRY_EVENTS.contains(&event.as_str()) {
        return Err("Unknown telemetry event".into());
    }
    if !state.db.media_preferences()?.telemetry_enabled {
        return Ok(());
    }
    send_telemetry(&event, context).await.map_err(|error| {
        log::warn!("[telemetry] {error}");
        error
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queue_rechecks_late_jobs_and_recovers_offline_uploads() {
        use std::sync::{Arc, atomic::AtomicBool};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use crate::services::{db::Database, account_manager::AccountManager, immich_client::{ImmichClient, AuthSession}};
        let folder = std::env::current_dir().unwrap().join(format!("media-queue-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let db = Arc::new(Database::test_database(folder.join("db.sqlite")).unwrap());
        let job = |id: &str, account: &str| UploadJob {
            id: id.into(), account_id: account.into(), local_path: folder.join("missing.jpg").to_string_lossy().into_owned(),
            checksum: id.into(), album_ids: vec![], original_asset_id: None, server_asset_id: None, state: "queued".into(), error: None,
        };
        db.queue_media(&job("first", "account")).unwrap();
        let late_job = job("late", "removed-account");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server_db = db.clone();
        let server = tokio::spawn(async move {
            for request in 0..3 {
                let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept()).await.unwrap().unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).await.unwrap();
                    bytes.push(byte[0]);
                }
                if request == 0 { server_db.queue_media(&late_job).unwrap(); }
                if request == 1 { assert_eq!(server_db.media_uploads().unwrap()[0].state, "uploading"); }
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
            }
        });
        let client = Arc::new(ImmichClient::new());
        *client.session.lock().await = Some(AuthSession { server_url: url, access_token: "fixture".into(), refresh_token: None, user_id: "fixture".into(), user_name: None });
        let accounts = Arc::new(AccountManager::new());
        accounts.insert("account".into(), client.clone());
        let state = AppState { db: db.clone(), immich: client, accounts, sync_cancel: Arc::new(AtomicBool::new(false)) };
        let (first, competing) = tokio::join!(process_media_uploads(&state), process_media_uploads(&state));
        assert_eq!(first.unwrap(), 0);
        assert_eq!(competing.unwrap(), 0);
        server.await.unwrap();
        let jobs = db.media_uploads().unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().all(|job| job.state == "failed"));
        db.queue_media(&job("offline", "account")).unwrap();
        db.set_media_upload_state("offline", "uploading", None).unwrap();
        assert!(process_media_uploads(&state).await.unwrap_err().starts_with("offline:"));
        assert_eq!(db.media_uploads().unwrap()[2].state, "queued");
        drop(state); drop(db);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn telemetry_uses_browser_agents_and_preserves_webview_identity() {
        let agent =
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
        assert_eq!(browser_user_agent(agent), agent);
        assert!(browser_user_agent("ImmichLocalApp/1.0").starts_with("Mozilla/5.0"));
        assert!(!browser_user_agent("Mozilla/5.0\r\nInjected").contains('\n'));
        assert!(!MediaPreferences::default().session_replay_enabled);
        assert!(MediaPreferences::default().telemetry_enabled);
    }
    #[test]
    fn path_components_cannot_escape_destination() {
        assert_eq!(safe_component("../album\\name"), "_album_name");
        assert_eq!(safe_component("..."), "Imported");
    }
    #[test]
    fn recognises_photo_and_video() {
        assert_eq!(media_kind(Path::new("camera.CR3")), Some("photo"));
        assert_eq!(media_kind(Path::new("clip.MOV")), Some("video"));
        assert_eq!(media_kind(Path::new("private.txt")), None);
    }
    #[test]
    fn retained_copies_never_overwrite_and_sidecar_changes_are_detected() {
        let folder = std::env::current_dir()
            .unwrap()
            .join(format!("immich-copy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let source = folder.join("camera.jpg");
        std::fs::write(&source, b"original").unwrap();
        let destination = folder.join("album");
        let first = copy_without_overwrite(&source, &destination, "camera.jpg").unwrap();
        let second = copy_without_overwrite(&source, &destination, "camera.jpg").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert_eq!(std::fs::read(&first).unwrap(), b"original");
        let extensions = vec!["rrdata".into(), "xml".into()];
        let initial = sidecar_snapshot(&source, &extensions).unwrap();
        let sidecar = source.with_extension("rrdata");
        std::fs::write(&sidecar, b"edit-one").unwrap();
        let changed = sidecar_snapshot(&source, &extensions).unwrap();
        assert_ne!(initial, changed);
        assert_eq!(changed, sidecar_snapshot(&source, &extensions).unwrap());
        std::fs::write(&sidecar, b"edit-two").unwrap();
        assert_ne!(changed, sidecar_snapshot(&source, &extensions).unwrap());
        for path in [source, sidecar, first, second] {
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(destination).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }
}
