use crate::services::db::Database;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static EVICTION_LOCK: Mutex<()> = Mutex::new(());
/// Cache file that was in use (e.g. playing video) when eviction could not
/// otherwise reach the limit. It is never deleted while pinned and is
/// reported as an explicit over-limit amount in the storage summary.
static PINNED: Mutex<Option<PathBuf>> = Mutex::new(None);

const TRANSCODED_KIND_SUFFIX: &str = ":transcoded";
const CACHED_KIND_SUFFIX: &str = ":cached";

/// Tracking kind for a server-transcoded (compressed) local copy.
pub fn transcoded_source_kind(kind: &str) -> String {
    format!("{kind}{TRANSCODED_KIND_SUFFIX}")
}

/// Tracking kind for a copy staged from the disposable cache (thumbnail/preview).
pub fn cached_source_kind(kind: &str) -> String {
    format!("{kind}{CACHED_KIND_SUFFIX}")
}

/// `true` only when the tracked local copy is the untouched original file.
pub fn is_original_source_kind(kind: &str) -> bool {
    !kind.ends_with(TRANSCODED_KIND_SUFFIX) && !kind.ends_with(CACHED_KIND_SUFFIX)
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VideoQuality {
    #[default]
    Server,
    Original,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeaturePreferences {
    pub max_cache_bytes: u64,
    pub streaming_video_quality: VideoQuality,
    pub offline_video_quality: VideoQuality,
}

impl Default for FeaturePreferences {
    fn default() -> Self {
        Self {
            max_cache_bytes: 2 * 1024 * 1024 * 1024,
            streaming_video_quality: VideoQuality::Server,
            offline_video_quality: VideoQuality::Original,
        }
    }
}

impl Database {
    pub fn list_local_saved_asset_sources(
        &self,
        asset_id: &str,
    ) -> Result<Vec<(String, String)>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare("SELECT local_path, source_kind FROM local_saved_assets WHERE asset_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![asset_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Local copies that are true originals; excludes transcoded videos and
    /// cache-derived fallbacks so editors never receive a compressed file.
    pub fn list_local_original_paths_for_asset(
        &self,
        asset_id: &str,
    ) -> Result<Vec<String>, String> {
        Ok(self
            .list_local_saved_asset_sources(asset_id)?
            .into_iter()
            .filter(|(_, kind)| is_original_source_kind(kind))
            .map(|(path, _)| path)
            .collect())
    }

    pub fn get_feature_preferences(&self) -> Result<FeaturePreferences, String> {
        read_preferences(&self.open()?)
    }

    pub fn update_feature_preferences(
        &self,
        preferences: &FeaturePreferences,
    ) -> Result<FeaturePreferences, String> {
        let json = serde_json::to_string(preferences).map_err(|e| e.to_string())?;
        self.open()?
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('storage_preferences', ?1)",
                params![json],
            )
            .map_err(|e| e.to_string())?;
        log::info!(
            "[settings.preferences] saved cache_limit={} streaming={:?} offline={:?}",
            preferences.max_cache_bytes,
            preferences.streaming_video_quality,
            preferences.offline_video_quality
        );
        Ok(preferences.clone())
    }
}

fn read_preferences(conn: &rusqlite::Connection) -> Result<FeaturePreferences, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'storage_preferences'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|value| {
        serde_json::from_str(&value).map_err(|e| format!("Invalid feature preferences: {e}"))
    })
    .unwrap_or_else(|| Ok(FeaturePreferences::default()))
}

pub fn cache_root() -> Result<PathBuf, String> {
    crate::util::home_dir()
        .map(|home| home.join(".config/immich-local-app"))
        .ok_or_else(|| "Cannot resolve home directory".into())
}

pub fn persisted_preferences() -> Result<FeaturePreferences, String> {
    let conn = rusqlite::Connection::open_with_flags(
        cache_root()?.join("db.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    read_preferences(&conn)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub cache_bytes: u64,
    pub offline_bytes: u64,
    pub pending_upload_bytes: u64,
    pub disk_offline_bytes: u64,
    pub disk_pending_upload_bytes: u64,
    pub disk_total_bytes: u64,
    pub disk_available_bytes: u64,
    pub other_used_bytes: u64,
    pub cache_on_library_volume: bool,
    pub disk_path: String,
    pub cache_path: String,
    pub warnings: Vec<String>,
    pub cache_limit_bytes: u64,
    /// Bytes above the limit that could not be evicted (0 when within limit).
    pub cache_over_limit_bytes: u64,
    pub pinned_path: Option<String>,
    pub pinned_bytes: u64,
}

fn listed_paths(conn: &rusqlite::Connection, sql: &str) -> Result<HashSet<PathBuf>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    paths
        .map(|path| path.map(PathBuf::from).map_err(|e| e.to_string()))
        .collect()
}

struct ProtectedPaths {
    /// Retained local copies (originals or offline renditions); never deleted.
    offline: HashSet<PathBuf>,
    /// Cache renditions of retained assets; evicted last and only by the limit.
    retained_cache: HashSet<PathBuf>,
    /// Files awaiting upload; never deleted.
    pending: HashSet<PathBuf>,
}

fn protected_paths(conn: &rusqlite::Connection, root: &Path) -> Result<ProtectedPaths, String> {
    let offline = listed_paths(conn, "SELECT local_path FROM local_saved_assets")?;
    let mut retained_cache = HashSet::new();
    let retained_ids = listed_paths(conn, "SELECT DISTINCT asset_id FROM local_saved_assets")?;
    for name in ["thumbnails", "videos"] {
        let directory = root.join(name);
        if fs::symlink_metadata(&directory)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        {
            for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                    if retained_ids.contains(Path::new(stem))
                        || retained_ids
                            .contains(Path::new(stem.strip_suffix(".original").unwrap_or(stem)))
                    {
                        retained_cache.insert(path);
                    }
                }
            }
        }
    }
    let has_uploads: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_uploads')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    let pending = if has_uploads {
        listed_paths(
            conn,
            "SELECT local_path FROM media_uploads WHERE completed_at IS NULL",
        )?
    } else {
        HashSet::new()
    };
    Ok(ProtectedPaths {
        offline,
        retained_cache,
        pending,
    })
}

struct CacheFile {
    path: PathBuf,
    size: u64,
    modified: std::time::SystemTime,
    retained: bool,
}

fn normalized(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn cache_files(
    root: &Path,
    protected: &HashSet<PathBuf>,
    retained: &HashSet<PathBuf>,
) -> Result<Vec<CacheFile>, String> {
    let protected: HashSet<_> = protected.iter().map(|path| normalized(path)).collect();
    let retained: HashSet<_> = retained.iter().map(|path| normalized(path)).collect();
    let mut files = Vec::new();
    // Only known disposable leaf directories; never traverse links or touch the database/library.
    for name in [
        "thumbnails",
        "people",
        "profiles",
        "videos",
        "import-previews",
    ] {
        let directory = root.join(name);
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Cannot inspect {}: {e}", directory.display())),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || protected.contains(&normalized(&path))
                || path
                    .extension()
                    .is_some_and(|ext| ext == "part" || ext == "done")
            {
                continue;
            }
            files.push(CacheFile {
                retained: retained.contains(&normalized(&path)),
                path,
                size: metadata.len(),
                modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            });
        }
    }
    Ok(files)
}

fn measured(
    paths: &HashSet<PathBuf>,
    excluded: &HashSet<PathBuf>,
    warnings: &mut Vec<String>,
) -> u64 {
    let mut seen = HashSet::new();
    let excluded: HashSet<_> = excluded.iter().map(|path| normalized(path)).collect();
    paths
        .iter()
        .filter(|path| !excluded.contains(&normalized(path)))
        .map(|path| {
            if !seen.insert(normalized(path)) {
                return 0;
            }
            match fs::metadata(path) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Ok(_) => 0,
                Err(e) => {
                    warnings.push(format!("{}: {e}", path.display()));
                    0
                }
            }
        })
        .sum()
}

fn existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    while !current.exists() {
        current = current
            .parent()
            .ok_or_else(|| format!("No existing volume for {}", path.display()))?;
    }
    Ok(current.to_path_buf())
}

#[cfg(unix)]
fn same_volume(a: &Path, b: &Path) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(a).map_err(|e| e.to_string())?.dev()
        == fs::metadata(b).map_err(|e| e.to_string())?.dev())
}

#[cfg(windows)]
fn same_volume(a: &Path, b: &Path) -> Result<bool, String> {
    let a = fs::canonicalize(a).map_err(|e| e.to_string())?;
    let b = fs::canonicalize(b).map_err(|e| e.to_string())?;
    Ok(a.components().next() == b.components().next())
}

#[cfg(not(any(unix, windows)))]
fn same_volume(_a: &Path, _b: &Path) -> Result<bool, String> {
    Err("Storage measurement is unsupported on this platform".into())
}

pub fn summary(db: &Database) -> Result<StorageSummary, String> {
    log::info!("[storage.measure] starting disk and retained-content measurement");
    let root = cache_root()?;
    let conn = db.open()?;
    let ProtectedPaths {
        offline,
        retained_cache,
        pending,
    } = protected_paths(&conn, &root)?;
    let mut protected = offline.clone();
    protected.extend(pending.clone());
    let cache_bytes: u64 = cache_files(&root, &protected, &retained_cache)?
        .iter()
        .map(|file| file.size)
        .sum();
    let cache_limit_bytes = read_preferences(&conn)?.max_cache_bytes;
    let cache_over_limit_bytes = cache_bytes.saturating_sub(cache_limit_bytes);
    let pinned = current_pin(&root).filter(|_| cache_over_limit_bytes > 0);
    let pinned_bytes = pinned
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .map_or(0, |metadata| metadata.len());
    if cache_over_limit_bytes > 0 {
        log::warn!(
            "[storage.measure] cache over limit cache_bytes={cache_bytes} limit={cache_limit_bytes} pinned={:?} pinned_bytes={pinned_bytes}",
            pinned
        );
    }
    let mut warnings = Vec::new();
    let offline_bytes = measured(&offline, &pending, &mut warnings);
    let pending_upload_bytes = measured(&pending, &HashSet::new(), &mut warnings);
    let library = db.get_settings()?.user_local_folder_path;
    let disk = if library.is_empty() {
        root.clone()
    } else {
        existing_ancestor(Path::new(&library))?
    };
    let disk_total_bytes =
        fs2::total_space(&disk).map_err(|e| format!("Cannot measure disk capacity: {e}"))?;
    let disk_available_bytes =
        fs2::available_space(&disk).map_err(|e| format!("Cannot measure free disk space: {e}"))?;
    let cache_on_library_volume = same_volume(&root, &disk)?;
    let offline_on_disk: HashSet<_> = offline
        .into_iter()
        .filter(|path| {
            existing_ancestor(path)
                .and_then(|p| same_volume(&p, &disk))
                .unwrap_or(false)
        })
        .collect();
    let pending_on_disk: HashSet<_> = pending
        .iter()
        .filter(|path| {
            existing_ancestor(path)
                .and_then(|p| same_volume(&p, &disk))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let disk_offline_bytes = measured(&offline_on_disk, &pending, &mut Vec::new());
    let disk_pending_upload_bytes = measured(&pending_on_disk, &HashSet::new(), &mut Vec::new());
    let classified = disk_offline_bytes
        + disk_pending_upload_bytes
        + if cache_on_library_volume {
            cache_bytes
        } else {
            0
        };
    log::info!("[storage.measure] complete cache_bytes={cache_bytes} offline_bytes={offline_bytes} pending_bytes={pending_upload_bytes} free_bytes={disk_available_bytes} warnings={}", warnings.len());
    Ok(StorageSummary {
        cache_bytes,
        offline_bytes,
        pending_upload_bytes,
        disk_offline_bytes,
        disk_pending_upload_bytes,
        disk_total_bytes,
        disk_available_bytes,
        other_used_bytes: disk_total_bytes
            .saturating_sub(disk_available_bytes)
            .saturating_sub(classified),
        cache_on_library_volume,
        disk_path: disk.to_string_lossy().into(),
        cache_path: root.to_string_lossy().into(),
        warnings,
        cache_limit_bytes,
        cache_over_limit_bytes,
        pinned_path: pinned.map(|path| path.to_string_lossy().into()),
        pinned_bytes,
    })
}

/// Deletes oldest disposable cache files until the cache is at most `limit`.
/// Retained-asset cache renditions are only removed when `include_retained`
/// is set and unprotected files alone cannot satisfy the limit. Offline
/// copies and pending uploads are never candidates.
pub fn evict(
    db: &Database,
    limit: u64,
    keep: Option<&Path>,
    include_retained: bool,
) -> Result<u64, String> {
    evict_in(&cache_root()?, &db.open()?, limit, keep, include_retained)
}

fn evict_in(
    root: &Path,
    conn: &rusqlite::Connection,
    limit: u64,
    keep: Option<&Path>,
    include_retained: bool,
) -> Result<u64, String> {
    let _guard = EVICTION_LOCK.lock().map_err(|e| e.to_string())?;
    let protected = protected_paths(conn, root)?;
    let mut hard = protected.offline;
    hard.extend(protected.pending);
    let mut files = cache_files(root, &hard, &protected.retained_cache)?;
    let mut total: u64 = files.iter().map(|file| file.size).sum();
    files.sort_by_key(|file| (file.retained, file.modified));
    // Without an explicit in-use file, keep the last pinned one: deleting a
    // video that may still be playing would break playback.
    let keep = keep.map(normalized).or_else(|| current_pin(root));
    let (mut removed, mut failures) = (0u64, Vec::new());
    log::info!(
        "[storage.evict] start bytes={total} limit={limit} files={} include_retained={include_retained}",
        files.len()
    );
    let mut pinned_skipped = false;
    for file in files {
        if total <= limit {
            break;
        }
        if file.retained && !include_retained {
            continue;
        }
        if keep
            .as_ref()
            .is_some_and(|keep| *keep == normalized(&file.path))
        {
            pinned_skipped = true;
            continue;
        }
        if let Err(e) = fs::remove_file(&file.path) {
            log::warn!(
                "[storage.evict] failed to delete path={} err={e}",
                file.path.display()
            );
            failures.push(format!("{}: {e}", file.path.display()));
            continue;
        }
        let marker = PathBuf::from(format!("{}.done", file.path.display()));
        if marker.exists() {
            if let Err(e) = fs::remove_file(&marker) {
                log::warn!(
                    "[storage.evict] failed to delete marker path={} err={e}",
                    marker.display()
                );
            }
        }
        total = total.saturating_sub(file.size);
        removed += file.size;
    }
    if let Ok(mut pin) = PINNED.lock() {
        *pin = if total > limit && pinned_skipped {
            log::warn!(
                "[storage.evict] limit not reachable without deleting in-use file path={:?} remaining_bytes={total} limit={limit}",
                keep
            );
            keep.clone()
        } else {
            None
        };
    }
    log::info!(
        "[storage.evict] complete removed_bytes={removed} remaining_bytes={total} failed={}",
        failures.len()
    );
    if !failures.is_empty() {
        return Err(format!(
            "Removed {removed} bytes, but {} cache file(s) could not be deleted: {}",
            failures.len(),
            failures.join("; ")
        ));
    }
    Ok(removed)
}

fn current_pin(root: &Path) -> Option<PathBuf> {
    let root = normalized(root);
    PINNED
        .lock()
        .ok()?
        .clone()
        .filter(|path| path.starts_with(&root) && path.is_file())
}

/// Runs after every cache write so the configured maximum is enforced
/// immediately. `keep` is the file currently being served.
pub fn enforce_cache_limit(keep: &Path) {
    let result = (|| {
        let root = cache_root()?;
        let conn = rusqlite::Connection::open_with_flags(
            root.join("db.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())?;
        let limit = read_preferences(&conn)?.max_cache_bytes;
        evict_in(&root, &conn, limit, Some(keep), true)
    })();
    if let Err(e) = result {
        log::warn!("[storage.evict] automatic eviction failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Eviction tests share the process-wide pin.
    static PIN_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Fixture directory removed on drop, including after a failed assertion.
    /// Declare it before any handle (connections, files) so those drop first;
    /// removal is retried briefly because Windows may release handles late.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            Self(PathBuf::from(format!(
                ".storage-test-{}",
                uuid::Uuid::new_v4()
            )))
        }
    }

    impl std::ops::Deref for TestDir {
        type Target = PathBuf;
        fn deref(&self) -> &PathBuf {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            for attempt in 0..10 {
                match fs::remove_dir_all(&self.0) {
                    Ok(()) => return,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                    Err(e) if attempt == 9 => {
                        eprintln!("failed to remove test fixture {}: {e}", self.0.display())
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
                }
            }
        }
    }
    #[test]
    fn preferences_upgrade_and_quality_validation() {
        let value: FeaturePreferences = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(value.max_cache_bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(value.offline_video_quality, VideoQuality::Original);
        assert!(
            serde_json::from_str::<FeaturePreferences>(r#"{"streamingVideoQuality":"720p"}"#)
                .is_err()
        );
    }

    #[test]
    fn disposable_scan_protects_retained_and_partial_files() {
        let root = TestDir::new();
        let videos = root.join("videos");
        let thumbnails = root.join("thumbnails");
        fs::create_dir_all(&videos).unwrap();
        fs::create_dir_all(&thumbnails).unwrap();
        fs::write(videos.join("retained.mp4"), b"retained-original").unwrap();
        fs::write(videos.join("active.mp4.part"), b"active-download").unwrap();
        fs::write(videos.join("cached.mp4"), b"disposable").unwrap();
        fs::write(videos.join("cached.mp4.done"), b"").unwrap();
        fs::write(thumbnails.join("cached.jpg"), b"thumbnail").unwrap();
        fs::create_dir_all(root.join("Albums")).unwrap();
        fs::write(root.join("Albums/original.jpg"), b"original").unwrap();
        let protected = HashSet::from([videos.join("retained.mp4")]);
        let files = cache_files(&root, &protected, &HashSet::new()).unwrap();
        let listed: HashSet<_> = files.iter().map(|file| file.path.clone()).collect();
        assert_eq!(
            listed,
            HashSet::from([videos.join("cached.mp4"), thumbnails.join("cached.jpg")])
        );
        assert!(videos.join("retained.mp4").exists());
        assert!(videos.join("active.mp4.part").exists());
    }

    #[cfg(unix)]
    #[test]
    fn disposable_scan_never_traverses_symlink_directories() {
        use std::os::unix::fs::symlink;
        let root = TestDir::new();
        fs::create_dir_all(root.join("library")).unwrap();
        fs::write(root.join("library/original.jpg"), b"original").unwrap();
        symlink(
            fs::canonicalize(root.join("library")).unwrap(),
            root.join("thumbnails"),
        )
        .unwrap();
        assert!(cache_files(&root, &HashSet::new(), &HashSet::new())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn eviction_enforces_limit_and_keeps_offline_and_pending_files() {
        let _lock = PIN_TEST_LOCK.lock().unwrap();
        let root = TestDir::new();
        let thumbnails = root.join("thumbnails");
        fs::create_dir_all(&thumbnails).unwrap();
        fs::create_dir_all(root.join("Albums")).unwrap();
        let offline = root.join("Albums/original.jpg");
        fs::write(&offline, vec![0u8; 50]).unwrap();
        fs::write(thumbnails.join("retained-asset.jpg"), vec![0u8; 40]).unwrap();
        fs::write(thumbnails.join("old.jpg"), vec![0u8; 30]).unwrap();
        fs::write(thumbnails.join("new.jpg"), vec![0u8; 20]).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE local_saved_assets (asset_id TEXT, local_path TEXT);
             CREATE TABLE media_uploads (local_path TEXT, completed_at INTEGER);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO local_saved_assets VALUES ('retained-asset', ?1)",
            params![offline.to_string_lossy()],
        )
        .unwrap();
        // Manual clear keeps renditions of retained assets.
        assert_eq!(evict_in(&root, &conn, 0, None, false).unwrap(), 50);
        assert!(thumbnails.join("retained-asset.jpg").exists());
        // The automatic limit may evict them so the maximum is always reachable.
        assert_eq!(evict_in(&root, &conn, 0, None, true).unwrap(), 40);
        assert!(offline.exists());
    }

    #[test]
    fn in_use_file_is_pinned_instead_of_deleted() {
        let _lock = PIN_TEST_LOCK.lock().unwrap();
        let root = TestDir::new();
        let videos = root.join("videos");
        fs::create_dir_all(&videos).unwrap();
        let playing = videos.join("playing.mp4");
        fs::write(&playing, vec![0u8; 100]).unwrap();
        fs::write(videos.join("old.mp4"), vec![0u8; 10]).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE local_saved_assets (asset_id TEXT, local_path TEXT);")
            .unwrap();
        assert_eq!(
            evict_in(&root, &conn, 50, Some(&playing), true).unwrap(),
            10
        );
        assert!(playing.exists());
        assert_eq!(current_pin(&root), Some(normalized(&playing)));
        // A later manual clear without an explicit in-use file still keeps it.
        assert_eq!(evict_in(&root, &conn, 0, None, false).unwrap(), 0);
        assert!(playing.exists());
        drop(conn);
        let root_path = root.to_path_buf();
        drop(root);
        assert_eq!(current_pin(&root_path), None);
    }
}
