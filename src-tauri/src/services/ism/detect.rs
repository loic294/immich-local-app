use super::operations::{companion_name, file_name, run_operation, split_stem};
use super::uploads::advance_upload;
use super::*;
use std::collections::HashMap;
use std::sync::Arc;

/// Sidecars and companions up to this size are compared by content; larger ones by size.
const HASH_COMPARE_LIMIT: u64 = 16 * 1024 * 1024;
const BACKGROUND_OPERATION_WAIT: Duration = Duration::from_secs(60);

struct TrackedFile {
    role: String,
    local_path: String,
    root_id: String,
    remote_path: String,
    folder: String,
    revision: String,
    size: u64,
    sha256: String,
}

/// Tracked files grouped by (server URL, asset id).
type TrackedGroups = Vec<((String, String), Vec<TrackedFile>)>;

fn tracked_groups(db: &Database) -> Result<TrackedGroups, String> {
    let conn = db.open()?;
    let mut stmt = conn
        .prepare(
            "SELECT server_url, asset_id, role, local_path, root_id, remote_path, folder, revision, size_bytes, sha256
             FROM ism_local_files ORDER BY server_url, asset_id, role DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                TrackedFile {
                    role: row.get(2)?,
                    local_path: row.get(3)?,
                    root_id: row.get(4)?,
                    remote_path: row.get(5)?,
                    folder: row.get(6)?,
                    revision: row.get(7)?,
                    size: row.get::<_, i64>(8)?.max(0) as u64,
                    sha256: row.get(9)?,
                },
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let mut groups: TrackedGroups = Vec::new();
    for (key, file) in rows {
        match groups.last_mut() {
            Some((last, files)) if *last == key => files.push(file),
            _ => groups.push((key, vec![file])),
        }
    }
    Ok(groups)
}

fn known_local_paths(db: &Database) -> Result<HashSet<String>, String> {
    let conn = db.open()?;
    let mut stmt = conn
        .prepare("SELECT local_path FROM ism_local_files UNION SELECT local_path FROM local_saved_assets")
        .map_err(|err| err.to_string())?;
    let paths = stmt
        .query_map([], |row| row.get(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<HashSet<String>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(paths)
}

fn content_changed(file: &TrackedFile) -> Result<bool, String> {
    let size = match fs::metadata(&file.local_path) {
        Ok(metadata) => metadata.len(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("Cannot inspect {}: {err}", file.local_path)),
    };
    if size != file.size {
        return Ok(true);
    }
    if size > HASH_COMPARE_LIMIT {
        return Ok(false);
    }
    let (_, sha256) = sha256_file(Path::new(&file.local_path))?;
    Ok(!sha256.eq_ignore_ascii_case(&file.sha256))
}

fn path_str(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("Local path is not valid UTF-8: {}", path.display()))
}

/// Same-folder local rename of a missing tracked original: exactly one untracked file with the
/// same size and content.
fn renamed_original(
    original: &TrackedFile,
    known: &HashSet<String>,
) -> Result<Option<PathBuf>, String> {
    let Some(dir) = Path::new(&original.local_path).parent() else {
        return Ok(None);
    };
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Cannot list {}: {err}", dir.display())),
    };
    let mut matches = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("Cannot list {}: {err}", dir.display()))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|err| format!("Cannot inspect {}: {err}", path.display()))?;
        if !metadata.is_file() || metadata.len() != original.size {
            continue;
        }
        let Some(candidate) = path.to_str() else {
            continue;
        };
        if known.contains(candidate) {
            continue;
        }
        let (_, sha256) = sha256_file(&path)?;
        if sha256.eq_ignore_ascii_case(&original.sha256) {
            matches.push(path);
        }
    }
    Ok((matches.len() == 1).then(|| matches.remove(0)))
}

fn record_local_rename(
    db: &Database,
    asset_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let name = file_name(new_path).to_string();
    let mut conn = db.open()?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute(
        "UPDATE ism_local_files SET local_path = ?3 WHERE asset_id = ?1 AND local_path = ?2",
        rusqlite::params![asset_id, old_path, new_path],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "UPDATE local_saved_assets SET local_path = ?3, file_name = ?4,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE asset_id = ?1 AND local_path = ?2",
        rusqlite::params![asset_id, old_path, new_path, name],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())
}

/// Turns local changes to ISM-tracked groups into ISM work: a same-folder rename of the
/// original becomes a guarded rename, changed or new sidecars become a guarded sidecar upload.
/// Missing files are never trashed remotely. Returns how many requests were queued.
pub fn detect_ism_local_changes(db: &Database) -> Result<u32, String> {
    let groups = tracked_groups(db)?;
    if groups.is_empty() {
        return Ok(0);
    }
    let mut known = known_local_paths(db)?;
    let mut queued = 0;
    for ((server_url, asset_id), files) in groups {
        if db.ism_provider(&server_url)?.is_none() {
            continue;
        }
        let Some(original) = files.iter().find(|file| file.role == "original") else {
            continue;
        };
        let result = if Path::new(&original.local_path).exists() {
            detect_sidecar_changes(db, &server_url, &asset_id, original, &files, &known)
        } else {
            detect_rename(db, &server_url, &asset_id, original, &mut known)
        };
        match result {
            Ok(true) => queued += 1,
            Ok(false) => {}
            Err(error) => log::warn!("[ism:detect] asset={asset_id}: {error}"),
        }
    }
    Ok(queued)
}

fn detect_rename(
    db: &Database,
    server_url: &str,
    asset_id: &str,
    original: &TrackedFile,
    known: &mut HashSet<String>,
) -> Result<bool, String> {
    let Some(new_path) = renamed_original(original, known)? else {
        return Ok(false);
    };
    let new_path = path_str(&new_path)?;
    let new_name = file_name(&new_path);
    if !valid_name(new_name) {
        return Ok(false);
    }
    let target = Location {
        root_id: original.root_id.clone(),
        path: if original.folder.is_empty() {
            new_name.to_string()
        } else {
            format!("{}/{new_name}", original.folder)
        },
    };
    let dedupe = format!("rename:{server_url}:{asset_id}:{new_path}");
    let action = OperationAction::Rename {
        source: Location {
            root_id: original.root_id.clone(),
            path: original.remote_path.clone(),
        },
        target,
        expected_revision: Some(original.revision.clone()),
    };
    let label = format!("Rename {} to {new_name}", file_name(&original.remote_path));
    let queued = db
        .begin_ism_operation(
            server_url,
            &label,
            Some(&dedupe),
            Some(asset_id),
            vec![action],
        )?
        .is_some();
    record_local_rename(db, asset_id, &original.local_path, &new_path)?;
    known.insert(new_path.clone());
    log::info!("[ism:detect] local rename asset={asset_id} queued={queued}");
    Ok(queued)
}

fn detect_sidecar_changes(
    db: &Database,
    server_url: &str,
    asset_id: &str,
    original: &TrackedFile,
    files: &[TrackedFile],
    known: &HashSet<String>,
) -> Result<bool, String> {
    let mut changed = Vec::new();
    for file in files.iter().filter(|file| file.role != "original") {
        if content_changed(file)? {
            changed.push(file);
        }
    }
    let local_original = Path::new(&original.local_path);
    let local_name = file_name(&original.local_path);
    let remote_name = file_name(&original.remote_path);
    let tracked_sidecar = files.iter().any(|file| file.role == "sidecar");
    let mut new_sidecars = Vec::new();
    if !tracked_sidecar {
        let dir = local_original.parent().ok_or("Invalid local path")?;
        for candidate in [
            format!("{local_name}.xmp"),
            format!("{}.xmp", split_stem(local_name)),
        ] {
            let path = dir.join(&candidate);
            let path_text = path_str(&path)?;
            if path.is_file() && !known.contains(&path_text) {
                new_sidecars.push((path, companion_name(&candidate, local_name, remote_name)));
                break;
            }
        }
    }
    if changed.is_empty() && new_sidecars.is_empty() {
        return Ok(false);
    }
    if db.ism_sidecar_upload_open(server_url, asset_id)? {
        return Ok(false);
    }
    let (size, sha256) = sha256_file(local_original)?;
    if size != original.size || !sha256.eq_ignore_ascii_case(&original.sha256) {
        log::info!("[ism:detect] original changed locally; sidecar sync skipped asset={asset_id}");
        return Ok(false);
    }
    let role = |role: &str| match role {
        "sidecar" => FileRole::Sidecar,
        _ => FileRole::Companion,
    };
    // Sidecar-only upload: ISM keeps the original and checks it still has this revision.
    let mut sources: Vec<UploadFileSource> = Vec::new();
    sources.extend(changed.iter().map(|file| UploadFileSource {
        local_path: PathBuf::from(&file.local_path),
        name: file_name(&file.remote_path).to_string(),
        role: role(&file.role),
        expected_revision: Some(file.revision.clone()),
        expected_sha256: Some(file.sha256.clone()),
        track: true,
    }));
    sources.extend(
        new_sidecars
            .into_iter()
            .map(|(path, name)| UploadFileSource {
                local_path: path,
                name,
                role: FileRole::Sidecar,
                expected_revision: None,
                expected_sha256: None,
                track: true,
            }),
    );
    db.create_ism_upload(NewUpload {
        job_id: format!("sidecar:{}", Uuid::new_v4()),
        kind: "sidecar_sync",
        server_url: server_url.to_string(),
        asset_id: Some(asset_id.to_string()),
        target: Location {
            root_id: original.root_id.clone(),
            path: original.folder.clone(),
        },
        provenance_original: Some((
            Location {
                root_id: original.root_id.clone(),
                path: original.remote_path.clone(),
            },
            Some(original.revision.clone()),
        )),
        files: sources,
        on_conflict: "replace_if_expected",
    })?;
    log::info!("[ism:detect] sidecar sync queued asset={asset_id}");
    Ok(true)
}

/// Advances detected ISM work (pending operations and sidecar uploads) once. Concurrent calls
/// return immediately so a slow server never stacks requests; nothing is retried on failure.
pub async fn process_ism_background_work(db: Arc<Database>) {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let Ok(_guard) = LOCK.get_or_init(|| tokio::sync::Mutex::new(())).try_lock() else {
        return;
    };
    let mut clients: HashMap<String, Option<IsmClient>> = HashMap::new();
    let mut client_for = |server: &str| -> Option<IsmClient> {
        clients
            .entry(server.to_string())
            .or_insert_with(|| {
                db.ism_provider(server).ok().flatten().and_then(|provider| {
                    IsmClient::new(&provider.base_url, &provider.client_token).ok()
                })
            })
            .as_ref()
            .map(IsmClient::clone)
    };
    let operations = db.ism_operation_keys_pending().unwrap_or_else(|error| {
        log::warn!("[ism:background] cannot list operations: {error}");
        Vec::new()
    });
    for (key, server) in operations {
        let Some(client) = client_for(&server) else {
            continue;
        };
        if let Err(error) = run_operation(&db, &client, &key, BACKGROUND_OPERATION_WAIT).await {
            log::warn!("[ism:background] operation key={key} failed: {error}");
        }
    }
    let uploads = db.active_ism_sidecar_uploads().unwrap_or_else(|error| {
        log::warn!("[ism:background] cannot list sidecar uploads: {error}");
        Vec::new()
    });
    for (job_id, server) in uploads {
        let Some(client) = client_for(&server) else {
            continue;
        };
        match advance_upload(&db, &client, &job_id).await {
            Ok(Advance::Ready { .. }) => {
                log::info!("[ism:background] sidecar sync done job={job_id}")
            }
            Ok(Advance::Waiting(reason)) => {
                log::info!("[ism:background] sidecar sync waiting job={job_id}: {reason}")
            }
            Err(error) => log::warn!("[ism:background] sidecar sync job={job_id} failed: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::TestDir;
    use super::*;

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn setup(dir: &TestDir) -> Database {
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.save_ism_provider(
            "https://immich.example",
            &Provider {
                base_url: "https://sync.example/".into(),
                client_token: "token".into(),
            },
        )
        .unwrap();
        let original = dir.0.join("a.jpg");
        let sidecar = dir.0.join("a.jpg.xmp");
        fs::write(&original, b"pixels").unwrap();
        fs::write(&sidecar, b"<xmp/>").unwrap();
        let conn = db.open().unwrap();
        for (role, path, remote, revision, content) in [
            ("original", &original, "2025/a.jpg", "rev-1", &b"pixels"[..]),
            (
                "sidecar",
                &sidecar,
                "2025/a.jpg.xmp",
                "rev-2",
                &b"<xmp/>"[..],
            ),
        ] {
            conn.execute(
                "INSERT INTO ism_local_files VALUES ('asset-1','https://immich.example','g',?1,?2,'photos',?3,'2025',?4,?5,?6)",
                rusqlite::params![role, path.to_str().unwrap(), remote, revision, content.len() as i64, sha(content)],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO local_saved_assets (asset_id, local_path, file_name, source_kind) VALUES ('asset-1', ?1, 'a.jpg', 'download')",
            [original.to_str().unwrap()],
        )
        .unwrap();
        db
    }

    #[test]
    fn edited_sidecar_queues_a_guarded_replacement_once() {
        let dir = TestDir::new();
        let db = setup(&dir);
        assert_eq!(detect_ism_local_changes(&db).unwrap(), 0);
        fs::write(dir.0.join("a.jpg.xmp"), b"<xmp rating='5'/>").unwrap();
        assert_eq!(detect_ism_local_changes(&db).unwrap(), 1);
        assert_eq!(
            detect_ism_local_changes(&db).unwrap(),
            0,
            "one open sync per asset"
        );
        let request: String = db
            .open()
            .unwrap()
            .query_row("SELECT request_json FROM ism_upload_jobs", [], |row| {
                row.get(0)
            })
            .unwrap();
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["on_conflict"], "replace_if_expected");
        assert_eq!(request["target"]["path"], "2025");
        assert_eq!(request["provenance"]["expected_revision"], "rev-1");
        assert_eq!(
            request["provenance"]["original_location"]["path"],
            "2025/a.jpg"
        );
        assert_eq!(request["existing_original"]["name"], "a.jpg");
        assert_eq!(request["existing_original"]["expected_revision"], "rev-1");
        assert_eq!(request["files"].as_array().unwrap().len(), 1);
        assert_eq!(request["files"][0]["name"], "a.jpg.xmp");
        assert_eq!(request["files"][0]["role"], "sidecar");
        assert_eq!(request["files"][0]["expected_revision"], "rev-2");
        assert_eq!(request["files"][0]["expected_sha256"], sha(b"<xmp/>"));
    }

    #[test]
    fn local_rename_queues_a_guarded_rename_and_keeps_local_tracking() {
        let dir = TestDir::new();
        let db = setup(&dir);
        fs::rename(dir.0.join("a.jpg"), dir.0.join("b.jpg")).unwrap();
        assert_eq!(detect_ism_local_changes(&db).unwrap(), 1);
        let new_path = dir.0.join("b.jpg").to_str().unwrap().to_string();
        let saved: String = db
            .open()
            .unwrap()
            .query_row("SELECT local_path FROM local_saved_assets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(saved, new_path);
        let request: String = db
            .open()
            .unwrap()
            .query_row("SELECT request_json FROM ism_operations", [], |row| {
                row.get(0)
            })
            .unwrap();
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        let action = &request["actions"][0];
        assert_eq!(action["kind"], "rename");
        assert_eq!(action["source"]["path"], "2025/a.jpg");
        assert_eq!(action["target"]["path"], "2025/b.jpg");
        assert_eq!(action["expected_revision"], "rev-1");
        assert_eq!(detect_ism_local_changes(&db).unwrap(), 0);
    }

    #[test]
    fn missing_original_without_a_rename_is_left_to_the_deleted_notice() {
        let dir = TestDir::new();
        let db = setup(&dir);
        fs::remove_file(dir.0.join("a.jpg")).unwrap();
        assert_eq!(detect_ism_local_changes(&db).unwrap(), 0);
        let operations: i64 = db
            .open()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ism_operations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(operations, 0);
    }
}
