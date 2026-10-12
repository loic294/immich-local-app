use base64::Engine;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use crate::{
    services::{db::Database, storage},
    AppState,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLocalOriginalResult {
    confirmation_required: bool,
    removed_count: usize,
}

fn original_paths(db: &Database, asset_id: &str, root: &Path) -> Result<Vec<PathBuf>, String> {
    uuid::Uuid::parse_str(asset_id).map_err(|_| "Invalid asset ID".to_string())?;
    let mut paths: Vec<_> = db
        .list_local_original_paths_for_asset(asset_id)?
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let cached_video = root.join("videos").join(format!("{asset_id}.original.mp4"));
    if cached_video.try_exists().map_err(|e| e.to_string())? {
        if !cached_video
            .with_extension("mp4.done")
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            return Err("Cannot remove an original video while its download is incomplete".into());
        }
        paths.push(cached_video);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub(crate) fn checksum(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot inspect {}: {e}", path.display())),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to remove non-regular file {}",
            path.display()
        ));
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha1::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(hash.finalize()),
    ))
}

fn remove_files(
    db: &Database,
    asset_id: &str,
    paths: &[PathBuf],
    root: &Path,
    server_checksum: Option<&str>,
    allow_unverified: bool,
) -> Result<RemoveLocalOriginalResult, String> {
    let conn = db.open()?;
    let mut snapshots = Vec::new();
    for path in paths {
        let pending: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM media_uploads WHERE local_path = ?1 AND completed_at IS NULL)",
            [path.to_string_lossy().as_ref()], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if pending {
            return Err(format!(
                "Cannot remove {} while it is awaiting upload",
                path.display()
            ));
        }

        snapshots.push((path, checksum(path)?));
    }
    let backed_up = server_checksum.is_some()
        && snapshots.iter().all(|(_, hash)| {
            hash.as_deref()
                .is_none_or(|hash| Some(hash) == server_checksum)
        });
    if !allow_unverified && !backed_up {
        log::warn!("[local-original:remove] confirmation required asset_id={asset_id}");
        return Ok(RemoveLocalOriginalResult {
            confirmation_required: true,
            removed_count: 0,
        });
    }
    let mut removed_count = 0;
    for (path, snapshot) in snapshots {
        // Do not delete an edit made while backup verification was in progress.
        if checksum(path)? != snapshot {
            return Err(format!(
                "Local file changed during removal: {}",
                path.display()
            ));
        }
        if snapshot.is_some() {
            fs::remove_file(path).map_err(|e| format!("Cannot remove {}: {e}", path.display()))?;
            removed_count += 1;
        }
        db.delete_local_saved_asset_by_path(asset_id, &path.to_string_lossy())?;
        for kind in ["modified", "deleted"] {
            db.resolve_unresolved_local_saved_asset_change(
                asset_id,
                &path.to_string_lossy(),
                kind,
            )?;
        }
        if path == &root.join("videos").join(format!("{asset_id}.original.mp4")) {
            let marker = path.with_extension("mp4.done");
            match fs::remove_file(&marker) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!(
                        "Cannot remove completion marker {}: {e}",
                        marker.display()
                    ))
                }
            }
        }
    }
    db.set_asset_full_resolution_local(asset_id, false)?;
    log::info!("[local-original:remove] done asset_id={asset_id} removed_count={removed_count}");
    Ok(RemoveLocalOriginalResult {
        confirmation_required: false,
        removed_count,
    })
}

#[tauri::command]
pub async fn remove_local_original(
    asset_id: String,
    allow_unverified: bool,
    state: tauri::State<'_, AppState>,
) -> Result<RemoveLocalOriginalResult, String> {
    log::info!(
        "[local-original:remove] start asset_id={asset_id} allow_unverified={allow_unverified}"
    );
    let result = async {
        let root = storage::cache_root()?;
        let paths = original_paths(&state.db, &asset_id, &root)?;
        let server_checksum = verified_backup_checksum(&state, &asset_id).await?;
        let db = state.db.clone();
        tokio::task::spawn_blocking(move || {
            remove_files(
                &db,
                &asset_id,
                &paths,
                &root,
                server_checksum.as_deref(),
                allow_unverified,
            )
        })
        .await
        .map_err(|e| format!("Local removal worker failed: {e}"))?
    }
    .await;
    if let Err(e) = &result {
        log::error!("[local-original:remove] failed: {e}");
    }
    result
}

pub(crate) async fn verified_backup_checksum(
    state: &AppState,
    asset_id: &str,
) -> Result<Option<String>, String> {
    verify_backup_with_connectivity(state, asset_id, &mut HashMap::new()).await
}

pub(crate) async fn verify_backup_with_connectivity(
    state: &AppState,
    asset_id: &str,
    connectivity: &mut HashMap<String, bool>,
) -> Result<Option<String>, String> {
    let (account_id, client) = state.account_and_client_for_asset(asset_id);
    let server_url = match state.db.get_account(&account_id)? {
        Some(account) => Some(account.server_url),
        None => state.db.get_auth_credentials()?.map(|(url, _, _)| url),
    };
    let Some(url) = server_url else {
        log::warn!("[local-backup] no credentials asset_id={asset_id}");
        return Ok(None);
    };
    let online = match connectivity.get(&account_id) {
        Some(online) => *online,
        None => {
            let online = client.ping(&url).await;
            connectivity.insert(account_id, online);
            online
        }
    };
    if !online {
        log::warn!("[local-backup] server unreachable asset_id={asset_id}");
        return Ok(None);
    }
    match client.get_asset(asset_id).await {
        Ok(asset) if !asset.is_trashed => match client.original_available(asset_id).await {
            Ok(true) => {
                if asset.checksum.is_none() {
                    log::warn!("[local-backup] missing server checksum asset_id={asset_id}");
                }
                Ok(asset.checksum)
            }
            Ok(false) => {
                log::warn!("[local-backup] original unavailable asset_id={asset_id}");
                Ok(None)
            }
            Err(e) => {
                log::warn!("[local-backup] original verification failed asset_id={asset_id}: {e}");
                Ok(None)
            }
        },
        Ok(_) => {
            log::warn!("[local-backup] asset in server trash asset_id={asset_id}");
            Ok(None)
        }
        Err(e) => {
            log::warn!("[local-backup] metadata verification failed asset_id={asset_id}: {e}");
            Ok(None)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "99b1c9db-fca7-4ed8-a12e-06e05b24e331";

    struct Fixture {
        root: PathBuf,
        db: Database,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("local-original-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let db = Database::test_database(root.join("db.sqlite")).unwrap();
            db.init_media().unwrap();
            db.open().unwrap().execute(
                "INSERT INTO assets(id, account_id, original_file_name, updated_at, thumbnail_local, preview_local, full_resolution_local) VALUES(?1, 'account', 'photo.jpg', 0, 1, 1, 1)", [ID],
            ).unwrap();
            Self { root, db }
        }
        fn file(&self, name: &str, kind: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::write(&path, b"original photo").unwrap();
            self.db
                .upsert_local_saved_asset(ID, None, &path.to_string_lossy(), name, kind, None, None)
                .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn matching_backup_removes_only_originals_and_preserves_preview_flags() {
        let f = Fixture::new();
        let original = f.file("photo.jpg", "explorer_copy");
        let preview = f.file("preview.jpg", "explorer_copy:cached");
        let transcoded = f.file("video.mp4", "explorer_copy:transcoded");
        let hash = checksum(&original).unwrap().unwrap();
        f.db.upsert_unresolved_local_saved_asset_change(
            ID,
            &original.to_string_lossy(),
            "photo.jpg",
            "modified",
            "{}",
        )
        .unwrap();
        let paths = original_paths(&f.db, ID, &f.root).unwrap();
        let result = remove_files(&f.db, ID, &paths, &f.root, Some(&hash), false).unwrap();
        assert!(!result.confirmation_required);
        assert_eq!(result.removed_count, 1);
        assert!(!original.exists());
        assert!(preview.exists() && transcoded.exists());
        let details = f.db.get_asset_details(ID).unwrap().unwrap();
        assert!(!details.full_resolution_local);
        assert!(details.thumbnail_local && details.preview_local);
        assert_eq!(f.db.list_local_saved_asset_sources(ID).unwrap().len(), 2);
        assert!(f
            .db
            .list_unresolved_local_saved_asset_changes()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unknown_or_different_backup_requires_confirmation_before_any_deletion() {
        let f = Fixture::new();
        let path = f.file("photo.jpg", "explorer_copy");
        for hash in [None, Some("different-checksum")] {
            assert!(
                remove_files(&f.db, ID, &[path.clone()], &f.root, hash, false)
                    .unwrap()
                    .confirmation_required
            );
            assert!(path.exists());
            assert!(
                f.db.get_asset_details(ID)
                    .unwrap()
                    .unwrap()
                    .full_resolution_local
            );
        }
        assert_eq!(
            remove_files(&f.db, ID, &[path.clone()], &f.root, None, true)
                .unwrap()
                .removed_count,
            1
        );
        assert!(!path.exists());
    }

    #[test]
    fn missing_files_clear_tracking_without_removing_other_files() {
        let f = Fixture::new();
        let path = f.file("photo.jpg", "explorer_copy");
        fs::remove_file(&path).unwrap();
        assert_eq!(
            remove_files(&f.db, ID, &[path], &f.root, Some("checksum"), false)
                .unwrap()
                .removed_count,
            0
        );
        assert!(f.db.list_local_saved_asset_sources(ID).unwrap().is_empty());
    }

    #[test]
    fn pending_upload_is_protected_even_after_confirmation() {
        let f = Fixture::new();
        let path = f.file("photo.jpg", "explorer_copy");
        f.db.open().unwrap().execute(
            "INSERT INTO media_uploads(id, account_id, local_path, checksum, album_ids) VALUES('upload', 'account', ?1, 'hash', '[]')", [path.to_string_lossy().as_ref()],
        ).unwrap();
        assert!(
            remove_files(&f.db, ID, &[path.clone()], &f.root, None, true)
                .unwrap_err()
                .contains("awaiting upload")
        );
        assert!(path.exists());
    }

    #[test]
    fn cache_candidates_exclude_compressed_videos_and_incomplete_downloads() {
        let f = Fixture::new();
        fs::create_dir(f.root.join("videos")).unwrap();
        let original = f.root.join("videos").join(format!("{ID}.original.mp4"));
        let marker = original.with_extension("mp4.done");
        let compressed = f.root.join("videos").join(format!("{ID}.mp4"));
        fs::write(&original, b"video").unwrap();
        fs::write(&compressed, b"compressed").unwrap();
        assert!(original_paths(&f.db, ID, &f.root)
            .unwrap_err()
            .contains("incomplete"));
        fs::write(&marker, b"done").unwrap();
        let paths = original_paths(&f.db, ID, &f.root).unwrap();
        assert_eq!(paths, vec![original.clone()]);
        remove_files(&f.db, ID, &paths, &f.root, None, true).unwrap();
        assert!(!original.exists() && !marker.exists());
        assert!(compressed.exists());
        assert!(original_paths(&f.db, "../invalid", &f.root).is_err());
    }
}
