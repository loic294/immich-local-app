use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;

use super::local_original::{checksum, verify_backup_with_connectivity};
use crate::{
    services::{db::Database, storage},
    AppState,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageGroup {
    pub album_id: Option<String>,
    pub name: String,
    pub folder_path: Option<String>,
    pub bytes: u64,
    pub file_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LocalCopy {
    asset_id: String,
    path: PathBuf,
    original: bool,
}

#[derive(Debug)]
struct GroupFiles {
    summary: LocalStorageGroup,
    files: Vec<LocalCopy>,
}

// Confirmation authorizes exactly the inspected files, not later downloads.
struct RemovalPlan {
    created_at: Instant,
    album_id: Option<String>,
    files: Vec<(LocalCopy, String)>,
    unverified_count: usize,
}

static PLANS: LazyLock<Mutex<HashMap<String, RemovalPlan>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static REMOVAL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageRemovalPreview {
    token: String,
    file_count: usize,
    unverified_count: usize,
}

fn regular_size(path: &Path) -> Result<Option<u64>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(Some(meta.len())),
        Ok(_) => Err(format!("Not a regular local copy: {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot inspect {}: {e}", path.display())),
    }
}

fn groups(db: &Database, root: &Path) -> Result<Vec<GroupFiles>, String> {
    let mut albums = db.get_albums()?;
    albums.sort_by(|a, b| a.id.cmp(&b.id));
    let mut result: Vec<GroupFiles> = albums
        .into_iter()
        .filter_map(|album| {
            let folder = album
                .saved_local_folder_path
                .filter(|p| !p.trim().is_empty())?;
            Some(GroupFiles {
                summary: LocalStorageGroup {
                    album_id: Some(album.id),
                    name: album.album_name,
                    folder_path: Some(folder),
                    bytes: 0,
                    file_count: 0,
                },
                files: Vec::new(),
            })
        })
        .collect();
    result.push(GroupFiles {
        summary: LocalStorageGroup {
            album_id: None,
            name: String::new(),
            folder_path: None,
            bytes: 0,
            file_count: 0,
        },
        files: Vec::new(),
    });
    let conn = db.open()?;
    let mut stmt = conn.prepare(
        "SELECT asset_id, local_path, source_kind FROM local_saved_assets ORDER BY local_path, asset_id",
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut copies = BTreeMap::new();
    for row in rows {
        let (asset_id, path, kind) = row.map_err(|e| e.to_string())?;
        if kind.ends_with(":cached") {
            continue;
        }
        copies.entry(PathBuf::from(&path)).or_insert(LocalCopy {
            asset_id,
            path: PathBuf::from(path),
            original: storage::is_original_source_kind(&kind),
        });
    }
    // Zoom can retain full-resolution videos in the native cache without a tracking row.
    let video_root = root.join("videos");
    if video_root.try_exists().map_err(|e| e.to_string())? {
        for entry in fs::read_dir(&video_root).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let Some(id) = path
                .file_name()
                .and_then(|v| v.to_str())
                .and_then(|v| v.strip_suffix(".original.mp4"))
            else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_err()
                || !path
                    .with_extension("mp4.done")
                    .try_exists()
                    .map_err(|e| e.to_string())?
            {
                continue;
            }
            copies.entry(path.clone()).or_insert(LocalCopy {
                asset_id: id.to_owned(),
                path,
                original: true,
            });
        }
    }
    for copy in copies.into_values() {
        let Some(bytes) = regular_size(&copy.path)? else {
            continue;
        };
        let index = result
            .iter()
            .position(|group| {
                group
                    .summary
                    .folder_path
                    .as_deref()
                    .is_some_and(|folder| copy.path.parent() == Some(Path::new(folder)))
            })
            .unwrap_or(result.len() - 1);
        let group = &mut result[index];
        group.summary.bytes += bytes;
        group.summary.file_count += 1;
        group.files.push(copy);
    }
    Ok(result)
}

fn selected_files(
    db: &Database,
    root: &Path,
    album_id: &Option<String>,
) -> Result<Vec<LocalCopy>, String> {
    groups(db, root)?
        .into_iter()
        .find(|g| &g.summary.album_id == album_id)
        .map(|g| g.files)
        .ok_or_else(|| "Saved album no longer exists. Refresh storage.".into())
}

fn ensure_not_pending(db: &Database, path: &Path) -> Result<(), String> {
    let conn = db.open()?;
    let pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM media_uploads WHERE local_path = ?1 AND completed_at IS NULL)",
        [path.to_string_lossy().as_ref()], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if pending {
        return Err(format!(
            "Cannot remove a file awaiting upload: {}",
            path.display()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_local_storage_groups(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LocalStorageGroup>, String> {
    let db = state.db.clone();
    let result: Result<Vec<LocalStorageGroup>, String> = tokio::task::spawn_blocking(move || {
        groups(&db, &storage::cache_root()?).map(|g| g.into_iter().map(|g| g.summary).collect())
    })
    .await
    .map_err(|e| format!("Storage measurement worker failed: {e}"))
    .and_then(|result| result);
    match &result {
        Ok(groups) => log::info!(
            "[storage.local] measured groups={} files={} bytes={}",
            groups.len(),
            groups.iter().map(|group| group.file_count).sum::<usize>(),
            groups.iter().map(|group| group.bytes).sum::<u64>(),
        ),
        Err(e) => log::error!("[storage.local] measurement failed: {e}"),
    }
    result
}

#[tauri::command]
pub async fn prepare_local_storage_removal(
    album_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<LocalStorageRemovalPreview, String> {
    log::info!("[storage.local] preparing removal album_id={album_id:?}");
    let result = async {
        let db = state.db.clone();
        let selected = album_id.clone();
        let snapshots = tokio::task::spawn_blocking(move || {
            selected_files(&db, &storage::cache_root()?, &selected)?
                .into_iter()
                .map(|copy| {
                    ensure_not_pending(&db, &copy.path)?;
                    let hash = checksum(&copy.path)?
                        .ok_or_else(|| "Local copy disappeared. Refresh storage.".to_string())?;
                    Ok((copy, hash))
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .await
        .map_err(|e| format!("Storage verification worker failed: {e}"))??;
        let mut checksums: HashMap<String, Option<String>> = HashMap::new();
        let mut connectivity = HashMap::new();
        for (copy, _) in &snapshots {
            if !checksums.contains_key(&copy.asset_id) {
                checksums.insert(
                    copy.asset_id.clone(),
                    verify_backup_with_connectivity(&state, &copy.asset_id, &mut connectivity)
                        .await?,
                );
            }
        }
        let unverified_count = snapshots
            .iter()
            .filter(|(copy, hash)| {
                let verified = checksums.get(&copy.asset_id).and_then(|hash| hash.as_ref());
                let unverified = verified.is_none() || (copy.original && verified != Some(hash));
                if unverified {
                    log::warn!(
                        "[storage.local] backup unverified asset_id={} original={}",
                        copy.asset_id,
                        copy.original
                    );
                }
                unverified
            })
            .count();
        let file_count = snapshots.len();
        let token = uuid::Uuid::new_v4().to_string();
        let mut plans = PLANS.lock().map_err(|e| e.to_string())?;
        plans.retain(|_, plan| plan.created_at.elapsed() < Duration::from_secs(900));
        if plans.len() >= 16 {
            plans.clear();
        }
        plans.insert(
            token.clone(),
            RemovalPlan {
                created_at: Instant::now(),
                album_id,
                files: snapshots,
                unverified_count,
            },
        );
        log::info!("[storage.local] prepared files={file_count} unverified={unverified_count}");
        Ok(LocalStorageRemovalPreview {
            token,
            file_count,
            unverified_count,
        })
    }
    .await;
    if let Err(e) = &result {
        log::error!("[storage.local] preparation failed: {e}");
    }
    result
}

fn remove_plan(
    db: &Database,
    root: &Path,
    plan: RemovalPlan,
    allow_unverified: bool,
) -> Result<usize, String> {
    let _guard = REMOVAL_LOCK
        .lock()
        .map_err(|e| format!("Local removal lock failed: {e}"))?;
    if plan.created_at.elapsed() >= Duration::from_secs(900) {
        return Err("Deletion confirmation expired. Review the files again.".into());
    }
    if plan.unverified_count > 0 && !allow_unverified {
        return Err("Server backups are unverified. Explicit confirmation is required.".into());
    }
    let selected = selected_files(db, root, &plan.album_id)?;
    if selected
        != plan
            .files
            .iter()
            .map(|(copy, _)| copy.clone())
            .collect::<Vec<_>>()
    {
        return Err("Local copies changed. Refresh storage and confirm again.".into());
    }
    for (copy, hash) in &plan.files {
        ensure_not_pending(db, &copy.path)?;
        if checksum(&copy.path)?.as_ref() != Some(hash) {
            return Err(format!(
                "Local copy changed: {}. Confirm again.",
                copy.path.display()
            ));
        }
    }
    for (copy, hash) in &plan.files {
        ensure_not_pending(db, &copy.path)?;
        if checksum(&copy.path)?.as_ref() != Some(hash) {
            return Err(format!(
                "Local copy changed during deletion: {}",
                copy.path.display()
            ));
        }
        fs::remove_file(&copy.path)
            .map_err(|e| format!("Cannot remove {}: {e}", copy.path.display()))?;
        // A path may be tracked by more than one asset. Clear only this exact path.
        let conn = db.open()?;
        let mut stmt = conn
            .prepare("SELECT asset_id FROM local_saved_assets WHERE local_path = ?1")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map([copy.path.to_string_lossy().as_ref()], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut affected: HashSet<String> = ids.into_iter().collect();
        affected.insert(copy.asset_id.clone());
        conn.execute(
            "DELETE FROM local_saved_assets WHERE local_path = ?1",
            [copy.path.to_string_lossy().as_ref()],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("UPDATE local_saved_asset_changes SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE local_path = ?1 AND resolved_at IS NULL",
            [copy.path.to_string_lossy().as_ref()]).map_err(|e| e.to_string())?;
        if copy.path
            == root
                .join("videos")
                .join(format!("{}.original.mp4", copy.asset_id))
        {
            fs::remove_file(copy.path.with_extension("mp4.done"))
                .map_err(|e| format!("Cannot remove video completion marker: {e}"))?;
        }
        for id in affected {
            let remaining = db
                .list_local_saved_asset_sources(&id)?
                .iter()
                .any(|(path, kind)| {
                    storage::is_original_source_kind(kind) && Path::new(path).is_file()
                })
                || root
                    .join("videos")
                    .join(format!("{id}.original.mp4"))
                    .is_file();
            db.set_asset_full_resolution_local(&id, remaining)?;
        }
    }
    if let Some(id) = plan.album_id {
        db.update_album_saved_local_folder_path(&id, None)?;
    }
    Ok(plan.files.len())
}

#[tauri::command]
pub async fn remove_local_storage_group(
    token: String,
    allow_unverified: bool,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let result = async {
        let plan = PLANS
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&token)
            .ok_or_else(|| "Deletion confirmation expired. Review the files again.".to_string())?;
        log::info!(
            "[storage.local] removing album_id={:?} files={}",
            plan.album_id,
            plan.files.len()
        );
        let db = state.db.clone();
        tokio::task::spawn_blocking(move || {
            remove_plan(&db, &storage::cache_root()?, plan, allow_unverified)
        })
        .await
        .map_err(|e| format!("Storage removal worker failed: {e}"))?
    }
    .await;
    match &result {
        Ok(count) => log::info!("[storage.local] removed files={count}"),
        Err(e) => log::error!("[storage.local] removal failed: {e}"),
    }
    result
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
                std::env::temp_dir().join(format!("immich-storage-group-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("album")).unwrap();
            fs::create_dir_all(root.join("videos")).unwrap();
            let db = Database::test_database(root.join("db.sqlite")).unwrap();
            db.init_media().unwrap();
            let conn = db.open().unwrap();
            conn.execute("INSERT INTO albums(id,account_id,album_name,owner_id,saved_local_folder_path) VALUES('album','account','Album','me',?1)",
                [root.join("album").to_str().unwrap()]).unwrap();
            conn.execute("INSERT INTO albums(id,account_id,album_name,owner_id,saved_local_folder_path) VALUES('empty','account','Empty','me',?1)",
                [root.join("empty").to_str().unwrap()]).unwrap();
            conn.execute("INSERT INTO assets(id,account_id,original_file_name,updated_at,thumbnail_local,preview_local,full_resolution_local) VALUES(?1,'account','photo.jpg',0,1,1,1)", [ID]).unwrap();
            Self { root, db }
        }
        fn file(&self, name: &str, kind: &str, size: usize) -> PathBuf {
            let path = self.root.join(name);
            fs::write(&path, vec![42; size]).unwrap();
            self.db
                .upsert_local_saved_asset(ID, None, path.to_str().unwrap(), name, kind, None, None)
                .unwrap();
            path
        }
        fn plan(&self, album_id: Option<&str>, unverified_count: usize) -> RemovalPlan {
            let album_id = album_id.map(String::from);
            let files = selected_files(&self.db, &self.root, &album_id)
                .unwrap()
                .into_iter()
                .map(|copy| {
                    let hash = checksum(&copy.path).unwrap().unwrap();
                    (copy, hash)
                })
                .collect();
            RemovalPlan {
                created_at: Instant::now(),
                album_id,
                files,
                unverified_count,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn measures_existing_downloads_once_and_keeps_empty_albums() {
        let f = Fixture::new();
        f.file("album/photo.jpg", "album_save", 20);
        f.file("timeline.jpg", "explorer_copy", 30);
        f.file("album/preview.jpg", "album_save:cached", 10);
        let missing = f.file("album/missing.jpg", "album_save", 50);
        fs::remove_file(missing).unwrap();
        fs::write(f.root.join("album/untracked.txt"), b"untracked").unwrap();
        let video = f.file(&format!("videos/{ID}.original.mp4"), "explorer_copy", 7);
        fs::write(video.with_extension("mp4.done"), b"").unwrap();
        let groups = groups(&f.db, &f.root).unwrap();
        let album = &groups
            .iter()
            .find(|g| g.summary.album_id.as_deref() == Some("album"))
            .unwrap()
            .summary;
        assert_eq!((album.bytes, album.file_count), (20, 1));
        let empty = &groups
            .iter()
            .find(|g| g.summary.album_id.as_deref() == Some("empty"))
            .unwrap()
            .summary;
        assert_eq!((empty.bytes, empty.file_count), (0, 0));
        let timeline = &groups.last().unwrap().summary;
        assert_eq!((timeline.bytes, timeline.file_count), (37, 2));
    }

    #[test]
    fn album_removal_preserves_other_copies_previews_untracked_files_and_server_cache() {
        let f = Fixture::new();
        let album = f.file("album/photo.jpg", "album_save", 20);
        let timeline = f.file("timeline.jpg", "explorer_copy", 30);
        let preview = f.file("album/preview.jpg", "album_save:cached", 10);
        let unrelated = f.root.join("album/untracked.txt");
        fs::write(&unrelated, b"keep").unwrap();
        let plan = f.plan(Some("album"), 0);
        assert_eq!(remove_plan(&f.db, &f.root, plan, false).unwrap(), 1);
        assert!(!album.exists());
        assert!(timeline.exists() && preview.exists() && unrelated.exists());
        let details = f.db.get_asset_details(ID).unwrap().unwrap();
        assert!(details.full_resolution_local && details.preview_local && details.thumbnail_local);
        assert!(f
            .db
            .get_albums()
            .unwrap()
            .iter()
            .find(|a| a.id == "album")
            .unwrap()
            .saved_local_folder_path
            .is_none());
    }

    #[test]
    fn timeline_removal_includes_untracked_original_video_and_preserves_album() {
        let f = Fixture::new();
        let album = f.file("album/photo.jpg", "album_save", 20);
        let timeline = f.file("timeline.mp4", "explorer_copy:transcoded", 30);
        let video = f.root.join("videos").join(format!("{ID}.original.mp4"));
        fs::write(&video, b"original").unwrap();
        fs::write(video.with_extension("mp4.done"), b"").unwrap();
        assert_eq!(
            remove_plan(&f.db, &f.root, f.plan(None, 0), false).unwrap(),
            2
        );
        assert!(album.exists());
        assert!(
            !timeline.exists() && !video.exists() && !video.with_extension("mp4.done").exists()
        );
    }

    #[test]
    fn refuses_unverified_or_changed_copies_before_deleting_anything() {
        let f = Fixture::new();
        let path = f.file("album/photo.jpg", "album_save", 20);
        assert!(remove_plan(&f.db, &f.root, f.plan(Some("album"), 1), false).is_err());
        assert!(path.exists());
        let plan = f.plan(Some("album"), 0);
        fs::write(&path, b"edited").unwrap();
        assert!(remove_plan(&f.db, &f.root, plan, false)
            .unwrap_err()
            .contains("changed"));
        assert!(path.exists());
        let plan = f.plan(Some("album"), 0);
        f.file("album/new.jpg", "album_save", 30);
        assert!(remove_plan(&f.db, &f.root, plan, false)
            .unwrap_err()
            .contains("changed"));
        assert!(path.exists());
        assert_eq!(
            remove_plan(&f.db, &f.root, f.plan(Some("album"), 2), true).unwrap(),
            2
        );
    }

    #[test]
    fn pending_upload_blocks_entire_group_even_after_confirmation() {
        let f = Fixture::new();
        let path = f.file("album/photo.jpg", "album_save", 20);
        let plan = f.plan(Some("album"), 1);
        f.db.open().unwrap().execute(
            "INSERT INTO media_uploads(id,account_id,local_path,checksum,album_ids) VALUES('upload','account',?1,'hash','[]')",
            [path.to_str().unwrap()]).unwrap();
        assert!(remove_plan(&f.db, &f.root, plan, true)
            .unwrap_err()
            .contains("awaiting upload"));
        assert!(path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_without_touching_target() {
        let f = Fixture::new();
        let target = f.root.join("target.jpg");
        fs::write(&target, b"keep").unwrap();
        let link = f.root.join("album/photo.jpg");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        f.db.upsert_local_saved_asset(
            ID,
            None,
            link.to_str().unwrap(),
            "photo.jpg",
            "album_save",
            None,
            None,
        )
        .unwrap();
        assert!(groups(&f.db, &f.root).unwrap_err().contains("regular"));
        assert!(target.exists());
    }
}
