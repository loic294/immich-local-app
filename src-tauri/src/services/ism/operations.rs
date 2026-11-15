use super::*;
use rusqlite::OptionalExtension;

/// Client-side subset of the ISM operation actions that ILA submits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationAction {
    Move {
        source: Location,
        target: Location,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_revision: Option<String>,
    },
    Rename {
        source: Location,
        target: Location,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_revision: Option<String>,
    },
    CreateFolder {
        target: Location,
    },
    MoveFolder {
        source: Location,
        target: Location,
    },
    TrashIfAssetMatches {
        source: Location,
        expected_asset_id: String,
        /// The revision ILA last saw; ISM fails with `revision_changed` if the file differs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_revision: Option<String>,
    },
    TrashFolder {
        source: Location,
        /// Every file below the folder (relative path and revision) the user agreed to trash.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_entries: Option<Vec<ExpectedEntry>>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedEntry {
    pub path: String,
    pub revision: String,
}

impl OperationAction {
    fn locations(&self) -> Vec<&Location> {
        match self {
            Self::Move { source, target, .. }
            | Self::Rename { source, target, .. }
            | Self::MoveFolder { source, target } => vec![source, target],
            Self::CreateFolder { target } => vec![target],
            Self::TrashIfAssetMatches { source, .. } | Self::TrashFolder { source, .. } => {
                vec![source]
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct OperationRequest {
    pub idempotency_key: String,
    pub label: String,
    pub actions: Vec<OperationAction>,
    pub allow_owner_transfer: bool,
    #[serde(default)]
    pub allow_partial: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperationIssue {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperationItemView {
    pub index: u32,
    pub kind: String,
    pub status: String,
    #[serde(default)]
    pub error: Option<OperationIssue>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperationView {
    pub operation_id: String,
    pub status: String,
    #[serde(default)]
    pub items: Vec<OperationItemView>,
}

impl OperationView {
    pub fn is_pending(&self) -> bool {
        matches!(
            self.status.as_str(),
            "queued" | "waiting_maintenance" | "running"
        )
    }

    pub fn failure(&self) -> Option<String> {
        if self.status == "completed" || self.is_pending() {
            return None;
        }
        let reason = self
            .items
            .iter()
            .find_map(|item| item.error.as_ref())
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| "the operation did not complete".into());
        Some(format!("ISM operation {}: {reason}", self.status))
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

/// The tracked or freshly fetched location of an asset's original on ISM.
pub struct OriginalLocation {
    pub location: Location,
    pub folder: String,
    pub revision: String,
    pub sha256: Option<String>,
}

type OperationRow = (String, OperationRequest, Option<String>, Option<String>);

impl Database {
    /// Persists a new operation request before it is submitted. Returns `None` when
    /// `dedupe_key` already names an earlier request, so detection never resubmits.
    pub fn begin_ism_operation(
        &self,
        server_url: &str,
        label: &str,
        dedupe_key: Option<&str>,
        asset_id: Option<&str>,
        actions: Vec<OperationAction>,
    ) -> Result<Option<String>, String> {
        if actions.is_empty()
            || actions.iter().any(|action| {
                action.locations().iter().any(|location| {
                    location.root_id.is_empty() || !valid_relative_path(&location.path, false)
                })
            })
        {
            return Err("ISM operation location is invalid".into());
        }
        let key = format!("ila-operation:{}", Uuid::new_v4());
        let request = OperationRequest {
            idempotency_key: key.clone(),
            label: label.to_string(),
            actions,
            allow_owner_transfer: false,
            allow_partial: false,
        };
        let json = serde_json::to_string(&request).map_err(|err| err.to_string())?;
        let inserted = self
            .open()?
            .execute(
                "INSERT INTO ism_operations (idempotency_key, server_url, label, dedupe_key, asset_id, request_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(dedupe_key) DO NOTHING",
                rusqlite::params![
                    key,
                    server_url.trim_end_matches('/'),
                    label,
                    dedupe_key,
                    asset_id,
                    json
                ],
            )
            .map_err(|err| format!("Cannot persist ISM operation: {err}"))?;
        Ok((inserted == 1).then_some(key))
    }

    fn ism_operation_row(&self, key: &str) -> Result<OperationRow, String> {
        let (server_url, json, operation_id, asset_id): (
            String,
            String,
            Option<String>,
            Option<String>,
        ) = self
            .open()?
            .query_row(
                "SELECT server_url, request_json, operation_id, asset_id FROM ism_operations
                 WHERE idempotency_key = ?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .ok_or("ISM operation request not found")?;
        let request = serde_json::from_str(&json).map_err(|err| err.to_string())?;
        Ok((server_url, request, operation_id, asset_id))
    }

    fn ism_operation_status(&self, key: &str) -> Result<String, String> {
        self.open()?
            .query_row(
                "SELECT status FROM ism_operations WHERE idempotency_key = ?1",
                [key],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())
    }

    fn set_ism_operation_state(
        &self,
        key: &str,
        operation_id: Option<&str>,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.open()?
            .execute(
                "UPDATE ism_operations SET operation_id = COALESCE(?2, operation_id), status = ?3, error = ?4
                 WHERE idempotency_key = ?1",
                rusqlite::params![key, operation_id, status, error],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Operations whose outcome is still unknown locally, including requests persisted but
    /// interrupted before submission (resubmitting them reuses their idempotency key).
    pub fn ism_operation_keys_pending(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT idempotency_key, server_url FROM ism_operations
                 WHERE status IN ('submitting', 'sending', 'queued', 'waiting_maintenance', 'running')
                 ORDER BY created_at",
            )
            .map_err(|err| err.to_string())?;
        let keys = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        Ok(keys)
    }

    pub fn ism_activity(&self) -> Result<Vec<ActivityEntry>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT 'op:' || idempotency_key, 'operation', label, status, error, created_at
                 FROM ism_operations
                 UNION ALL
                 SELECT 'upload:' || job_id, kind,
                        COALESCE(json_extract(request_json, '$.files[0].name'), ''), state, error, created_at
                 FROM ism_upload_jobs
                 ORDER BY 6 DESC LIMIT 50",
            )
            .map_err(|err| err.to_string())?;
        let entries = stmt
            .query_map([], |row| {
                Ok(ActivityEntry {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    label: row.get(2)?,
                    status: row.get(3)?,
                    error: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        Ok(entries)
    }

    /// Removes a finished or failed activity entry. Pending work and upload-queue jobs
    /// (retried from the upload queue) cannot be dismissed here.
    pub fn dismiss_ism_activity(&self, id: &str) -> Result<(), String> {
        let conn = self.open()?;
        let removed = if let Some(key) = id.strip_prefix("op:") {
            conn.execute(
                "DELETE FROM ism_operations WHERE idempotency_key = ?1
                 AND status IN ('completed', 'failed', 'partial', 'cancelled', 'recovery_required')",
                [key],
            )
        } else if let Some(job_id) = id.strip_prefix("upload:") {
            conn.execute(
                "DELETE FROM ism_upload_jobs WHERE job_id = ?1 AND kind != 'media'
                 AND state IN ('failed', 'done')",
                [job_id],
            )
        } else {
            return Err("Unknown ISM activity".into());
        }
        .map_err(|err| err.to_string())?;
        if removed != 1 {
            return Err("Only finished or failed ISM activity can be dismissed".into());
        }
        Ok(())
    }

    pub fn ism_tracked_original(
        &self,
        server_url: &str,
        asset_id: &str,
    ) -> Result<Option<OriginalLocation>, String> {
        self.open()?
            .query_row(
                "SELECT root_id, remote_path, folder, revision, sha256 FROM ism_local_files
                 WHERE asset_id = ?1 AND server_url = ?2 AND role = 'original' LIMIT 1",
                rusqlite::params![asset_id, server_url.trim_end_matches('/')],
                |row| {
                    Ok(OriginalLocation {
                        location: Location {
                            root_id: row.get(0)?,
                            path: row.get(1)?,
                        },
                        folder: row.get(2)?,
                        revision: row.get(3)?,
                        sha256: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    /// Re-points every tracked local file of an asset at the group described by `manifest`.
    pub fn refresh_ism_tracking(
        &self,
        server_url: &str,
        asset_id: &str,
        manifest: &Manifest,
    ) -> Result<(), String> {
        let server_url = server_url.trim_end_matches('/');
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let rows: Vec<(String, String, String)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT local_path, role, remote_path FROM ism_local_files
                     WHERE asset_id = ?1 AND server_url = ?2",
                )
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![asset_id, server_url], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            rows
        };
        let old_original = rows
            .iter()
            .find(|(_, role, _)| role == "original")
            .map(|(_, _, remote)| file_name(remote).to_string());
        let new_original = manifest
            .files
            .iter()
            .find(|file| file.role == FileRole::Original)
            .map(|file| file.name.clone())
            .ok_or("ISM manifest has no original")?;
        for (local_path, role, remote_path) in rows {
            let old_name = file_name(&remote_path);
            let wanted = match &old_original {
                Some(original) => companion_name(old_name, original, &new_original),
                None => old_name.to_string(),
            };
            let matched = manifest.files.iter().find(|file| {
                file.name.eq_ignore_ascii_case(&wanted) && role == role_name(file.role)
            });
            match matched {
                Some(file) => {
                    upsert_ism_local_file(&tx, asset_id, server_url, manifest, file, &local_path)?
                }
                None => {
                    tx.execute(
                        "DELETE FROM ism_local_files WHERE local_path = ?1",
                        [&local_path],
                    )
                    .map_err(|err| err.to_string())?;
                }
            }
        }
        tx.commit().map_err(|err| err.to_string())
    }

    pub fn forget_ism_asset(&self, server_url: &str, asset_id: &str) -> Result<(), String> {
        self.open()?
            .execute(
                "DELETE FROM ism_local_files WHERE asset_id = ?1 AND server_url = ?2",
                rusqlite::params![asset_id, server_url.trim_end_matches('/')],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Applies a completed folder move (`target`) or folder trash (`None`) to tracked provenance.
    pub fn apply_ism_folder_change(
        &self,
        server_url: &str,
        source: &Location,
        target: Option<&Location>,
    ) -> Result<(), String> {
        let conn = self.open()?;
        let scope = "server_url = ?1 AND root_id = ?2 AND (folder = ?3 OR folder LIKE ?3 || '/%')";
        let server_url = server_url.trim_end_matches('/');
        match target {
            Some(target) => conn.execute(
                &format!(
                    "UPDATE ism_local_files SET root_id = ?4,
                       folder = ?5 || substr(folder, length(?3) + 1),
                       remote_path = ?5 || substr(remote_path, length(?3) + 1)
                     WHERE {scope}"
                ),
                rusqlite::params![
                    server_url,
                    source.root_id,
                    source.path,
                    target.root_id,
                    target.path
                ],
            ),
            None => conn.execute(
                &format!("DELETE FROM ism_local_files WHERE {scope}"),
                rusqlite::params![server_url, source.root_id, source.path],
            ),
        }
        .map_err(|err| err.to_string())?;
        Ok(())
    }
}

pub(super) fn role_name(role: FileRole) -> &'static str {
    match role {
        FileRole::Original => "original",
        FileRole::Sidecar => "sidecar",
        FileRole::Companion => "companion",
    }
}

pub(super) fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub(super) fn split_stem(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[..index],
        _ => name,
    }
}

/// Name a companion takes when its original is renamed (`a.jpg.xmp`/`a.xmp` follow `a.jpg`).
pub(super) fn companion_name(name: &str, original: &str, new_original: &str) -> String {
    if name == original {
        return new_original.to_string();
    }
    if let Some(suffix) = name.strip_prefix(original).filter(|s| s.starts_with('.')) {
        return format!("{new_original}{suffix}");
    }
    if let Some(suffix) = name
        .strip_prefix(split_stem(original))
        .filter(|s| s.starts_with('.'))
    {
        return format!("{}{suffix}", split_stem(new_original));
    }
    name.to_string()
}

impl IsmClient {
    pub async fn path_manifest(&self, location: &Location) -> Result<Manifest, String> {
        let mut url = self.endpoint("api/v1/manifest")?;
        url.query_pairs_mut()
            .append_pair("root_id", &location.root_id)
            .append_pair("path", &location.path);
        let manifest: Manifest = successful(self.get(url).await?)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid ISM manifest".to_string())?;
        validate_manifest(&manifest, None)?;
        if manifest.location.root_id != location.root_id {
            return Err("ISM manifest does not match the requested location".into());
        }
        Ok(manifest)
    }

    /// The original's location and revision, preferring local provenance so a server-side
    /// change since the last download is rejected by ISM instead of silently accepted.
    pub async fn original_location(
        &self,
        db: &Database,
        server_url: &str,
        asset_id: &str,
    ) -> Result<OriginalLocation, String> {
        if let Some(tracked) = db.ism_tracked_original(server_url, asset_id)? {
            return Ok(tracked);
        }
        let manifest = self.manifest(asset_id).await?;
        let original = manifest
            .files
            .iter()
            .find(|file| file.role == FileRole::Original)
            .ok_or("ISM manifest has no original")?;
        Ok(OriginalLocation {
            location: manifest.location.clone(),
            folder: manifest.folder.clone(),
            revision: original.revision.clone(),
            sha256: original.sha256.clone(),
        })
    }

    /// Every file below a folder with its revision, relative to the folder, for a guarded
    /// folder trash. Refuses folders too large to verify instead of trashing them unchecked.
    pub async fn folder_entries(&self, folder: &Location) -> Result<Vec<ExpectedEntry>, String> {
        const MAX_ENTRIES: usize = 20_000;
        #[derive(Deserialize)]
        struct Listing {
            folders: Vec<ListedFolder>,
            files: Vec<ListedFile>,
        }
        #[derive(Deserialize)]
        struct ListedFolder {
            path: String,
        }
        #[derive(Deserialize)]
        struct ListedFile {
            path: String,
            revision: String,
        }
        let prefix = format!("{}/", folder.path);
        let relative = |path: &str| -> Result<String, String> {
            path.strip_prefix(&prefix)
                .filter(|rest| valid_relative_path(rest, false))
                .map(str::to_string)
                .ok_or_else(|| "ISM listed a path outside the folder".to_string())
        };
        let mut pending = vec![folder.path.clone()];
        let mut entries = Vec::new();
        while let Some(path) = pending.pop() {
            let mut url = self.endpoint("api/v1/folders")?;
            url.query_pairs_mut()
                .append_pair("root_id", &folder.root_id)
                .append_pair("path", &path);
            let listing: Listing = successful(self.get(url).await?)
                .await?
                .json()
                .await
                .map_err(|_| "Invalid ISM folder listing".to_string())?;
            for file in listing.files {
                entries.push(ExpectedEntry {
                    path: relative(&file.path)?,
                    revision: file.revision,
                });
            }
            for child in listing.folders {
                relative(&child.path)?;
                pending.push(child.path);
            }
            if entries.len() + pending.len() > MAX_ENTRIES {
                return Err(
                    "The folder is too large to verify before moving it to the ISM trash".into(),
                );
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    pub async fn operation_view(&self, operation_id: &str) -> Result<OperationView, String> {
        let mut url = self.endpoint("api/v1/operations/")?;
        url.path_segments_mut()
            .map_err(|_| "Invalid ISM URL")?
            .pop_if_empty()
            .push(operation_id);
        successful(self.get(url).await?)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid ISM operation status".to_string())
    }
}

enum KeyLookup {
    Found(String),
    NotFound,
    Cancelled,
}

enum SubmitError {
    /// ISM answered with a refusal: nothing was queued.
    Refused(String),
    /// The request may or may not have reached ISM.
    Unknown(String),
}

impl IsmClient {
    /// Finds the operation submitted under `key` without side effects. Servers without the
    /// `find_operation_by_key` capability report `NotFound`; resubmitting under the same key
    /// is idempotent on them.
    async fn find_operation_by_key(&self, key: &str) -> Result<KeyLookup, String> {
        let info = self.info().await?;
        if !info
            .capabilities
            .iter()
            .any(|capability| capability == "find_operation_by_key")
        {
            return Ok(KeyLookup::NotFound);
        }
        let mut url = self.endpoint("api/v1/operations")?;
        url.query_pairs_mut().append_pair("idempotency_key", key);
        match successful(self.get(url).await?).await {
            Ok(response) => {
                let view: OperationView = response
                    .json()
                    .await
                    .map_err(|_| "Invalid ISM operation status".to_string())?;
                Ok(KeyLookup::Found(view.operation_id))
            }
            Err(error) if error.starts_with("ISM not_found:") => Ok(KeyLookup::NotFound),
            Err(error) if error.starts_with("ISM cancelled_before_submission:") => {
                Ok(KeyLookup::Cancelled)
            }
            Err(error) => Err(error),
        }
    }

    async fn submit_operation(&self, request: &OperationRequest) -> Result<String, SubmitError> {
        let url = self
            .endpoint("api/v1/operations")
            .map_err(SubmitError::Refused)?;
        let response = self
            .post_json(url, request)
            .await
            .map_err(SubmitError::Unknown)?;
        let refused = response.status().is_client_error();
        let response = successful(response).await.map_err(|error| {
            if refused {
                SubmitError::Refused(error)
            } else {
                SubmitError::Unknown(error)
            }
        })?;
        let accepted: OperationAccepted = response
            .json()
            .await
            .map_err(|_| SubmitError::Unknown("Invalid ISM operation response".into()))?;
        Ok(accepted.operation_id)
    }
}

/// Submits a persisted request. A request whose earlier submission has an unknown outcome is
/// first looked up by its idempotency key; it is only resubmitted under that same key.
async fn submit_or_recover(
    db: &Database,
    client: &IsmClient,
    key: &str,
    request: &OperationRequest,
) -> Result<String, String> {
    if db.ism_operation_status(key)? == "sending" {
        match client.find_operation_by_key(key).await? {
            KeyLookup::Found(operation_id) => {
                log::info!("[ism:op] recovered key={key} operation={operation_id}");
                db.set_ism_operation_state(key, Some(&operation_id), "queued", None)?;
                return Ok(operation_id);
            }
            KeyLookup::Cancelled => {
                let error = "ISM operation was cancelled before submission";
                log::warn!("[ism:op] key={key}: {error}");
                db.set_ism_operation_state(key, None, "cancelled", Some(error))?;
                return Err(error.into());
            }
            KeyLookup::NotFound => {
                log::info!("[ism:op] key={key} never reached ISM; resubmitting under the same key")
            }
        }
    }
    db.set_ism_operation_state(key, None, "sending", None)?;
    match client.submit_operation(request).await {
        Ok(operation_id) => {
            log::info!("[ism:op] submitted key={key} operation={operation_id}");
            db.set_ism_operation_state(key, Some(&operation_id), "queued", None)?;
            Ok(operation_id)
        }
        Err(SubmitError::Refused(error)) => {
            log::warn!("[ism:op] refused key={key}: {error}");
            db.set_ism_operation_state(key, None, "failed", Some(&error))?;
            Err(error)
        }
        Err(SubmitError::Unknown(error)) => {
            let error =
                format!("{error}; ISM may have received it, its outcome is checked again later");
            log::warn!("[ism:op] outcome unknown key={key}: {error}");
            db.set_ism_operation_state(key, None, "sending", Some(&error))?;
            Err(error)
        }
    }
}

/// Submits (or, once submitted, re-reads) a persisted operation, waits a bounded time and
/// applies completed changes to local provenance. A request is never resubmitted under a new key.
pub async fn run_operation(
    db: &Database,
    client: &IsmClient,
    key: &str,
    timeout: Duration,
) -> Result<OperationView, String> {
    let (server_url, request, operation_id, asset_id) = db.ism_operation_row(key)?;
    let operation_id = match operation_id {
        Some(id) => id,
        None => submit_or_recover(db, client, key, &request).await?,
    };
    let view = client.wait_operation_view(&operation_id, timeout).await?;
    let failure = view.failure();
    db.set_ism_operation_state(key, None, &view.status, failure.as_deref())?;
    log::info!(
        "[ism:op] key={key} operation={operation_id} status={}",
        view.status
    );
    if let Some(failure) = failure {
        log::warn!("[ism:op] key={key} operation={operation_id} failed: {failure}");
        return Err(failure);
    }
    if view.status == "completed" {
        if let Err(error) =
            apply_completed(db, client, &server_url, &request, asset_id.as_deref()).await
        {
            let message =
                format!("ISM operation completed but local tracking was not updated: {error}");
            log::error!("[ism:op] key={key}: {message}");
            db.set_ism_operation_state(key, None, "completed", Some(&message))?;
            return Err(message);
        }
    }
    Ok(view)
}

async fn apply_completed(
    db: &Database,
    client: &IsmClient,
    server_url: &str,
    request: &OperationRequest,
    asset_id: Option<&str>,
) -> Result<(), String> {
    for action in &request.actions {
        match action {
            OperationAction::Move { target, .. } | OperationAction::Rename { target, .. } => {
                let manifest = client.path_manifest(target).await?;
                let asset = asset_id
                    .or(manifest.asset_id.as_deref())
                    .ok_or("ISM did not report the moved asset")?;
                db.refresh_ism_tracking(server_url, asset, &manifest)?;
            }
            OperationAction::TrashIfAssetMatches {
                expected_asset_id, ..
            } => db.forget_ism_asset(server_url, expected_asset_id)?,
            OperationAction::MoveFolder { source, target } => {
                db.apply_ism_folder_change(server_url, source, Some(target))?
            }
            OperationAction::TrashFolder { source, .. } => {
                db.apply_ism_folder_change(server_url, source, None)?
            }
            OperationAction::CreateFolder { .. } => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::{server, TestDir};
    use super::*;

    fn completed() -> Vec<u8> {
        serde_json::json!({
            "operation_id": "op_1", "status": "completed",
            "items": [{ "index": 0, "kind": "rename", "status": "done", "error": null, "result": null }]
        })
        .to_string()
        .into_bytes()
    }

    #[tokio::test]
    async fn rename_carries_expected_revision_and_persisted_key_and_refreshes_tracking() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        {
            let conn = db.open().unwrap();
            conn.execute(
                "INSERT INTO ism_local_files VALUES ('asset-1','https://immich.example','g','original','/local/a.jpg','photos','2025/a.jpg','2025','rev-1',3,'00')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ism_local_files VALUES ('asset-1','https://immich.example','g','sidecar','/local/a.jpg.xmp','photos','2025/a.jpg.xmp','2025','rev-2',3,'00')",
                [],
            )
            .unwrap();
        }
        let sha = "a".repeat(64);
        let manifest = serde_json::json!({
            "group_id": "g2", "asset_id": "asset-1",
            "location": { "root_id": "photos", "path": "2025/b.jpg" }, "folder": "2025",
            "files": [
                { "role": "original", "name": "b.jpg", "path": "2025/b.jpg", "size": 3, "revision": "rev-3", "sha256": sha },
                { "role": "sidecar", "name": "b.jpg.xmp", "path": "2025/b.jpg.xmp", "size": 3, "revision": "rev-4", "sha256": sha }
            ]
        })
        .to_string()
        .into_bytes();
        let (url, requests) = server(vec![
            (
                "202 Accepted",
                br#"{"operation_id":"op_1","status":"queued"}"#.to_vec(),
            ),
            ("200 OK", completed()),
            ("200 OK", manifest),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let tracked = client
            .original_location(&db, "https://immich.example", "asset-1")
            .await
            .unwrap();
        let key = db
            .begin_ism_operation(
                "https://immich.example",
                "Rename a.jpg",
                None,
                Some("asset-1"),
                vec![OperationAction::Rename {
                    source: tracked.location.clone(),
                    target: Location {
                        root_id: "photos".into(),
                        path: "2025/b.jpg".into(),
                    },
                    expected_revision: Some(tracked.revision.clone()),
                }],
            )
            .unwrap()
            .unwrap();
        run_operation(&db, &client, &key, Duration::from_secs(1))
            .await
            .unwrap();
        let requests = requests.await.unwrap();
        assert!(requests[0].contains(&format!("\"idempotency_key\":\"{key}\"")));
        assert!(requests[0].contains("\"expected_revision\":\"rev-1\""));
        assert!(requests[0].contains("\"kind\":\"rename\""));
        assert!(requests[2].starts_with("GET /api/v1/manifest?root_id=photos&path=2025%2Fb.jpg"));
        let remote: Vec<String> = {
            let conn = db.open().unwrap();
            let mut stmt = conn
                .prepare("SELECT remote_path || ':' || revision FROM ism_local_files ORDER BY role")
                .unwrap();
            let rows = stmt
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows
        };
        assert_eq!(remote, ["2025/b.jpg:rev-3", "2025/b.jpg.xmp:rev-4"]);
    }

    #[tokio::test]
    async fn refused_operation_is_surfaced_once_without_resubmitting() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        let (url, requests) = server(vec![(
            "409 Conflict",
            br#"{"error":{"code":"maintenance_blocked","message":"watcher still running"}}"#
                .to_vec(),
        )])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let action = OperationAction::CreateFolder {
            target: Location {
                root_id: "photos".into(),
                path: "2025/New".into(),
            },
        };
        let key = db
            .begin_ism_operation(
                "https://immich.example",
                "New folder",
                Some("folder:photos/2025/New"),
                None,
                vec![action.clone()],
            )
            .unwrap()
            .unwrap();
        let error = run_operation(&db, &client, &key, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(error.contains("maintenance_blocked"));
        assert_eq!(requests.await.unwrap().len(), 1);
        assert!(db
            .begin_ism_operation(
                "https://immich.example",
                "New folder",
                Some("folder:photos/2025/New"),
                None,
                vec![action],
            )
            .unwrap()
            .is_none());
        let activity = db.ism_activity().unwrap();
        assert_eq!(activity[0].status, "failed");
        assert!(activity[0]
            .error
            .as_deref()
            .unwrap()
            .contains("maintenance_blocked"));
    }

    #[tokio::test]
    async fn unknown_submission_outcome_is_recovered_by_key_lookup_without_resubmitting() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        let found = serde_json::json!({
            "operation_id": "op_7", "status": "completed",
            "items": [{ "index": 0, "kind": "create_folder", "status": "done", "error": null, "result": null }]
        })
        .to_string()
        .into_bytes();
        let (url, requests) = server(vec![
            ("502 Bad Gateway", b"proxy timeout".to_vec()),
            (
                "200 OK",
                super::super::tests::client_info(&["find_operation_by_key"]),
            ),
            ("200 OK", found.clone()),
            ("200 OK", found),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let key = db
            .begin_ism_operation(
                "https://immich.example",
                "New folder",
                None,
                None,
                vec![OperationAction::CreateFolder {
                    target: Location {
                        root_id: "photos".into(),
                        path: "2025/New".into(),
                    },
                }],
            )
            .unwrap()
            .unwrap();
        let error = run_operation(&db, &client, &key, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(error.contains("checked again"));
        assert_eq!(db.ism_operation_keys_pending().unwrap().len(), 1);
        let view = run_operation(&db, &client, &key, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(view.operation_id, "op_7");
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("POST /api/v1/operations "));
        assert!(requests[0].contains("\"allow_partial\":false"));
        assert!(requests[2].starts_with("GET /api/v1/operations?idempotency_key=ila-operation%3A"));
        assert!(requests[3].starts_with("GET /api/v1/operations/op_7 "));
        assert!(db.ism_operation_keys_pending().unwrap().is_empty());
    }

    #[tokio::test]
    async fn folder_entries_list_every_file_relative_to_the_trashed_folder() {
        let top = br#"{"root_id":"photos","path":"2023/Old","folders":[{"name":"sub","path":"2023/Old/sub"}],
            "files":[{"name":"e.jpg","path":"2023/Old/e.jpg","size":1,"revision":"r1","modified_at":null}]}"#;
        let sub = br#"{"root_id":"photos","path":"2023/Old/sub","folders":[],
            "files":[{"name":"f.jpg","path":"2023/Old/sub/f.jpg","size":1,"revision":"r2","modified_at":null}]}"#;
        let (url, requests) =
            server(vec![("200 OK", top.to_vec()), ("200 OK", sub.to_vec())]).await;
        let client = IsmClient::new(&url, "token").unwrap();
        let folder = Location {
            root_id: "photos".into(),
            path: "2023/Old".into(),
        };
        let entries = client.folder_entries(&folder).await.unwrap();
        assert_eq!(
            entries,
            [
                ExpectedEntry {
                    path: "e.jpg".into(),
                    revision: "r1".into()
                },
                ExpectedEntry {
                    path: "sub/f.jpg".into(),
                    revision: "r2".into()
                }
            ]
        );
        let body = serde_json::to_value(OperationAction::TrashFolder {
            source: folder,
            expected_entries: Some(entries),
        })
        .unwrap();
        assert_eq!(body["kind"], "trash_folder");
        assert_eq!(body["expected_entries"][1]["path"], "sub/f.jpg");
        assert!(requests.await.unwrap()[1]
            .starts_with("GET /api/v1/folders?root_id=photos&path=2023%2FOld%2Fsub "));
    }

    #[test]
    fn asset_trash_carries_the_known_revision() {
        let action = |expected_revision: Option<&str>| {
            serde_json::to_value(OperationAction::TrashIfAssetMatches {
                source: Location {
                    root_id: "photos".into(),
                    path: "2024/c.jpg".into(),
                },
                expected_asset_id: "asset-1".into(),
                expected_revision: expected_revision.map(Into::into),
            })
            .unwrap()
        };
        let guarded = action(Some("rev-1"));
        assert_eq!(guarded["kind"], "trash_if_asset_matches");
        assert_eq!(guarded["expected_asset_id"], "asset-1");
        assert_eq!(guarded["expected_revision"], "rev-1");
        assert!(action(None).get("expected_revision").is_none());
    }

    #[test]
    fn companions_follow_a_renamed_original() {
        assert_eq!(companion_name("a.jpg.xmp", "a.jpg", "b.jpg"), "b.jpg.xmp");
        assert_eq!(companion_name("a.xmp", "a.jpg", "b.jpg"), "b.xmp");
        assert_eq!(companion_name("a.jpg", "a.jpg", "b.jpg"), "b.jpg");
    }
}
