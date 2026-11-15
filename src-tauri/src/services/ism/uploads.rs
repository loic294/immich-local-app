use super::operations::{companion_name, file_name};
use super::*;
use rusqlite::OptionalExtension;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
const PUBLISH_WAIT: Duration = if cfg!(test) {
    Duration::from_millis(200)
} else {
    Duration::from_secs(20)
};
const PUBLISH_RECHECK_SECS: i64 = 5;
const IMPORT_RECHECK_SECS: i64 = 15;
const IMPORT_TIMEOUT_SECS: i64 = 30 * 60;

#[derive(Clone, Serialize, Deserialize)]
struct UploadFileSpec {
    name: String,
    role: FileRole,
    size: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_sha256: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct UploadProvenance {
    source: String,
    original_location: Option<Location>,
    expected_revision: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CreateUpload {
    idempotency_key: String,
    target: Location,
    provenance: Option<UploadProvenance>,
    files: Vec<UploadFileSpec>,
    on_conflict: String,
    /// Sidecar-only uploads name the original that stays in place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    existing_original: Option<ExistingOriginal>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ExistingOriginal {
    name: String,
    expected_revision: String,
}

#[derive(Deserialize)]
struct UploadFileState {
    index: u32,
    received: u64,
}

#[derive(Deserialize)]
struct UploadState {
    upload_id: String,
    status: String,
    #[serde(default)]
    files: Vec<UploadFileState>,
}

#[derive(Clone, Serialize, Deserialize)]
struct LocalSource {
    path: String,
    track: bool,
}

/// One local file of a new ISM upload.
pub struct UploadFileSource {
    pub local_path: PathBuf,
    pub name: String,
    pub role: FileRole,
    pub expected_revision: Option<String>,
    pub expected_sha256: Option<String>,
    /// Record the published file as local provenance of the resulting asset.
    pub track: bool,
}

pub struct NewUpload {
    pub job_id: String,
    /// `media` (upload queue job, same id) or `sidecar_sync` (detected local sidecar change).
    pub kind: &'static str,
    pub server_url: String,
    pub asset_id: Option<String>,
    /// Destination folder.
    pub target: Location,
    /// Original the upload derives from and its last seen revision.
    pub provenance_original: Option<(Location, Option<String>)>,
    pub files: Vec<UploadFileSource>,
    pub on_conflict: &'static str,
}

pub enum Advance {
    Ready { asset_id: String },
    Waiting(String),
}

struct UploadJob {
    kind: String,
    server_url: String,
    asset_id: Option<String>,
    request: CreateUpload,
    sources: Vec<LocalSource>,
    upload_id: Option<String>,
    operation_id: Option<String>,
    final_location: Option<Location>,
    state: String,
    next_check_at: i64,
    waiting_since: Option<i64>,
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Database {
    /// Hashes the local files and persists the upload request with a fresh idempotency key
    /// before anything is sent, so an interrupted upload resumes instead of duplicating.
    pub fn create_ism_upload(&self, upload: NewUpload) -> Result<(), String> {
        if upload.files.is_empty()
            || upload.files.iter().any(|file| !valid_name(&file.name))
            || upload.target.root_id.is_empty()
            || !valid_relative_path(&upload.target.path, true)
        {
            return Err("ISM upload request is invalid".into());
        }
        let sidecar_only = !upload
            .files
            .iter()
            .any(|file| file.role == FileRole::Original);
        let existing_original = match (&upload.provenance_original, sidecar_only) {
            (_, false) => None,
            (Some((location, Some(revision))), true)
                if !revision.is_empty()
                    && upload.on_conflict == "replace_if_expected"
                    && upload
                        .files
                        .iter()
                        .all(|file| file.name != file_name(&location.path)) =>
            {
                Some(ExistingOriginal {
                    name: file_name(&location.path).to_string(),
                    expected_revision: revision.clone(),
                })
            }
            _ => {
                return Err(
                    "A sidecar-only ISM upload needs the original location and revision".into(),
                )
            }
        };
        let mut specs = Vec::with_capacity(upload.files.len());
        let mut sources = Vec::with_capacity(upload.files.len());
        for file in upload.files {
            let (size, sha256) = sha256_file(&file.local_path)?;
            specs.push(UploadFileSpec {
                name: file.name,
                role: file.role,
                size,
                sha256,
                expected_revision: file.expected_revision,
                expected_sha256: file.expected_sha256,
            });
            sources.push(LocalSource {
                path: file
                    .local_path
                    .to_str()
                    .ok_or("Local file path is not valid UTF-8")?
                    .to_string(),
                track: file.track,
            });
        }
        let key = format!("ila-upload:{}:{}", upload.job_id, Uuid::new_v4());
        let (original_location, expected_revision) = upload.provenance_original.unzip();
        let request = CreateUpload {
            idempotency_key: key.clone(),
            target: upload.target,
            provenance: Some(UploadProvenance {
                source: "ila".into(),
                original_location,
                expected_revision: expected_revision.flatten(),
            }),
            files: specs,
            on_conflict: upload.on_conflict.into(),
            existing_original,
        };
        self.open()?
            .execute(
                "INSERT INTO ism_upload_jobs (job_id, kind, server_url, asset_id, idempotency_key, request_json, local_paths_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    upload.job_id,
                    upload.kind,
                    upload.server_url.trim_end_matches('/'),
                    upload.asset_id,
                    key,
                    serde_json::to_string(&request).map_err(|err| err.to_string())?,
                    serde_json::to_string(&sources).map_err(|err| err.to_string())?
                ],
            )
            .map_err(|err| format!("Cannot persist ISM upload: {err}"))?;
        Ok(())
    }

    pub fn ism_upload_exists(&self, job_id: &str) -> Result<bool, String> {
        self.open()?
            .query_row(
                "SELECT 1 FROM ism_upload_jobs WHERE job_id = ?1",
                [job_id],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(|err| err.to_string())
    }

    /// Drops a media upload's ISM record once the upload queue job has completed.
    pub fn forget_ism_media_upload(&self, job_id: &str) -> Result<(), String> {
        self.open()?
            .execute(
                "DELETE FROM ism_upload_jobs WHERE job_id = ?1 AND kind = 'media'",
                [job_id],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// True while a sidecar sync for the asset is running or failed and not yet dismissed.
    pub fn ism_sidecar_upload_open(
        &self,
        server_url: &str,
        asset_id: &str,
    ) -> Result<bool, String> {
        self.open()?
            .query_row(
                "SELECT 1 FROM ism_upload_jobs WHERE kind = 'sidecar_sync' AND server_url = ?1
                 AND asset_id = ?2 AND state IN ('active', 'failed') LIMIT 1",
                rusqlite::params![server_url.trim_end_matches('/'), asset_id],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(|err| err.to_string())
    }

    /// `(job_id, server_url)` of sidecar syncs that still have work to do.
    pub fn active_ism_sidecar_uploads(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT job_id, server_url FROM ism_upload_jobs
                 WHERE kind = 'sidecar_sync' AND state = 'active' ORDER BY created_at",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        Ok(rows)
    }

    fn ism_upload_job(&self, job_id: &str) -> Result<UploadJob, String> {
        type Row = (
            String,
            String,
            Option<String>,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            i64,
            Option<i64>,
        );
        let row: Row = self
            .open()?
            .query_row(
                "SELECT kind, server_url, asset_id, request_json, local_paths_json, upload_id, operation_id,
                        final_root_id, final_path, state, next_check_at, waiting_since
                 FROM ism_upload_jobs WHERE job_id = ?1",
                [job_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                    ))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?
            .ok_or("ISM upload job not found")?;
        let (kind, server_url, asset_id, request, sources, upload_id, operation_id, root, path) = (
            row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
        );
        let request: CreateUpload =
            serde_json::from_str(&request).map_err(|err| err.to_string())?;
        let sources: Vec<LocalSource> =
            serde_json::from_str(&sources).map_err(|err| err.to_string())?;
        if sources.len() != request.files.len() {
            return Err("ISM upload job is corrupt".into());
        }
        Ok(UploadJob {
            kind,
            server_url,
            asset_id,
            request,
            sources,
            upload_id,
            operation_id,
            final_location: root
                .zip(path)
                .map(|(root_id, path)| Location { root_id, path }),
            state: row.9,
            next_check_at: row.10,
            waiting_since: row.11,
        })
    }

    fn update_ism_upload(
        &self,
        job_id: &str,
        sql: &str,
        value: &dyn rusqlite::ToSql,
    ) -> Result<(), String> {
        self.open()?
            .execute(
                &format!("UPDATE ism_upload_jobs SET {sql} WHERE job_id = ?1"),
                rusqlite::params![job_id, value],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn finish_ism_upload(
        &self,
        job_id: &str,
        server_url: &str,
        asset_id: &str,
        manifest: &Manifest,
        job: &UploadJob,
    ) -> Result<(), String> {
        let original = |files: &[(&str, FileRole)]| {
            files
                .iter()
                .find(|(_, role)| *role == FileRole::Original)
                .map(|(name, _)| name.to_string())
        };
        let requested: Vec<(&str, FileRole)> = job
            .request
            .files
            .iter()
            .map(|file| (file.name.as_str(), file.role))
            .collect();
        let published: Vec<(&str, FileRole)> = manifest
            .files
            .iter()
            .map(|file| (file.name.as_str(), file.role))
            .collect();
        let requested_original = original(&requested)
            .or_else(|| {
                job.request
                    .existing_original
                    .as_ref()
                    .map(|existing| existing.name.clone())
            })
            .ok_or("ISM upload has no original")?;
        let published_original = original(&published).ok_or("ISM manifest has no original")?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        for (spec, source) in job.request.files.iter().zip(&job.sources) {
            if !source.track {
                continue;
            }
            let name = companion_name(&spec.name, &requested_original, &published_original);
            let file = manifest
                .files
                .iter()
                .find(|file| file.name == name && file.role == spec.role)
                .ok_or_else(|| format!("ISM manifest does not list the uploaded {name}"))?;
            upsert_ism_local_file(&tx, asset_id, server_url, manifest, file, &source.path)?;
        }
        tx.execute(
            "UPDATE ism_upload_jobs SET state = 'done', error = NULL, asset_id = ?2 WHERE job_id = ?1",
            rusqlite::params![job_id, asset_id],
        )
        .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())
    }
}

impl IsmClient {
    fn upload_url(&self, upload_id: &str, tail: &[&str]) -> Result<Url, String> {
        let mut url = self.endpoint("api/v1/uploads/")?;
        {
            let mut segments = url.path_segments_mut().map_err(|_| "Invalid ISM URL")?;
            segments.pop_if_empty().push(upload_id);
            for segment in tail {
                segments.push(segment);
            }
        }
        Ok(url)
    }

    async fn upload_state(&self, upload_id: &str) -> Result<UploadState, String> {
        successful(self.get(self.upload_url(upload_id, &[])?).await?)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid ISM upload status".to_string())
    }

    async fn put_upload_chunk(
        &self,
        upload_id: &str,
        index: usize,
        start: u64,
        body: Vec<u8>,
        total: u64,
    ) -> Result<(), String> {
        let end = start + body.len() as u64 - 1;
        let response = self
            .client
            .put(self.upload_url(upload_id, &["files", &index.to_string()])?)
            .header(AUTHORIZATION, self.authorization.clone())
            .header("Content-Range", format!("bytes {start}-{end}/{total}"))
            .body(body)
            .send()
            .await
            .map_err(|err| format!("ISM request failed: {}", err.without_url()))?;
        successful(response).await?;
        Ok(())
    }

    async fn send_upload_files(&self, job: &UploadJob, state: &UploadState) -> Result<(), String> {
        for (index, (spec, source)) in job.request.files.iter().zip(&job.sources).enumerate() {
            let received = state
                .files
                .iter()
                .find(|file| file.index as usize == index)
                .map(|file| file.received)
                .ok_or("ISM upload status is missing a file")?;
            if received >= spec.size {
                continue;
            }
            let mut file = tokio::fs::File::open(&source.path)
                .await
                .map_err(|err| format!("Cannot read {}: {err}", source.path))?;
            let size = file
                .metadata()
                .await
                .map_err(|err| format!("Cannot read {}: {err}", source.path))?
                .len();
            if size != spec.size {
                return Err(format!(
                    "Local file changed during the ISM upload: {}",
                    source.path
                ));
            }
            file.seek(io::SeekFrom::Start(received))
                .await
                .map_err(|err| format!("Cannot read {}: {err}", source.path))?;
            let mut start = received;
            while start < spec.size {
                let length = CHUNK_SIZE.min(spec.size - start) as usize;
                let mut body = vec![0; length];
                file.read_exact(&mut body)
                    .await
                    .map_err(|err| format!("Cannot read {}: {err}", source.path))?;
                self.put_upload_chunk(&state.upload_id, index, start, body, spec.size)
                    .await?;
                start += length as u64;
            }
        }
        Ok(())
    }

    async fn commit_upload(&self, upload_id: &str) -> Result<String, String> {
        let response = self
            .client
            .post(self.upload_url(upload_id, &["commit"])?)
            .header(AUTHORIZATION, self.authorization.clone())
            .send()
            .await
            .map_err(|err| format!("ISM request failed: {}", err.without_url()))?;
        let accepted: OperationAccepted = successful(response)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid ISM commit response".to_string())?;
        Ok(accepted.operation_id)
    }
}

/// Errors after which the persisted upload can never succeed under its idempotency key.
fn needs_new_upload(error: &str) -> bool {
    [
        "ISM upload_staging_missing",
        "ISM upload_closed",
        "ISM idempotency_key_conflict",
        "ISM checksum_mismatch",
        "ISM upload is ",
        "ISM operation failed",
        "ISM operation cancelled",
        "Local file changed during the ISM upload",
    ]
    .iter()
    .any(|prefix| error.starts_with(prefix))
}

/// Advances one persisted upload as far as it can go without blocking for long: create,
/// resume chunks, commit, wait briefly for publishing, then wait for Immich to import the
/// file. Never retries a refused step; errors are returned to the caller.
pub async fn advance_upload(
    db: &Database,
    client: &IsmClient,
    job_id: &str,
) -> Result<Advance, String> {
    let job = db.ism_upload_job(job_id)?;
    let result = advance(db, client, job_id, &job).await;
    match &result {
        Ok(Advance::Ready { asset_id }) => {
            log::info!(
                "[ism:upload] job={job_id} kind={} asset={asset_id}",
                job.kind
            )
        }
        Ok(Advance::Waiting(reason)) => {
            log::debug!(
                "[ism:upload] job={job_id} kind={} waiting: {reason}",
                job.kind
            )
        }
        Err(error) => log::warn!(
            "[ism:upload] job={job_id} kind={} failed: {error}",
            job.kind
        ),
    }
    if let Err(error) = &result {
        if job.kind == "media" && needs_new_upload(error) {
            db.open()?
                .execute("DELETE FROM ism_upload_jobs WHERE job_id = ?1", [job_id])
                .map_err(|err| err.to_string())?;
        } else {
            let state = if job.kind == "media" {
                "active"
            } else {
                "failed"
            };
            db.open()?
                .execute(
                    "UPDATE ism_upload_jobs SET state = ?2, error = ?3 WHERE job_id = ?1",
                    rusqlite::params![job_id, state, error],
                )
                .map_err(|err| err.to_string())?;
        }
    }
    result
}

async fn advance(
    db: &Database,
    client: &IsmClient,
    job_id: &str,
    job: &UploadJob,
) -> Result<Advance, String> {
    if job.state == "done" {
        return job
            .asset_id
            .clone()
            .map(|asset_id| Advance::Ready { asset_id })
            .ok_or_else(|| "ISM upload finished without an asset".into());
    }
    if job.state != "active" {
        return Err("ISM upload failed earlier; dismiss it to try again".into());
    }
    let now = now_secs();
    if job.next_check_at > now {
        return Ok(Advance::Waiting(if job.final_location.is_some() {
            "Waiting for Immich to import the file".into()
        } else {
            "ISM is publishing the file".into()
        }));
    }
    let (location, view) = match &job.final_location {
        Some(location) => {
            let view = match &job.operation_id {
                Some(id) => Some(client.operation_view(id).await?),
                None => None,
            };
            (location.clone(), view)
        }
        None => {
            let operation_id = match &job.operation_id {
                Some(id) => id.clone(),
                None => {
                    let state = match &job.upload_id {
                        Some(id) => client.upload_state(id).await?,
                        None => {
                            let response = client
                                .post_json(client.endpoint("api/v1/uploads")?, &job.request)
                                .await?;
                            let state: UploadState = successful(response)
                                .await?
                                .json()
                                .await
                                .map_err(|_| "Invalid ISM upload response".to_string())?;
                            db.update_ism_upload(job_id, "upload_id = ?2", &state.upload_id)?;
                            state
                        }
                    };
                    match state.status.as_str() {
                        "receiving" => client.send_upload_files(job, &state).await?,
                        "publishing" | "committed" => {}
                        status => return Err(format!("ISM upload is {status}")),
                    }
                    let operation_id = client.commit_upload(&state.upload_id).await?;
                    db.update_ism_upload(job_id, "operation_id = ?2", &operation_id)?;
                    operation_id
                }
            };
            let view = client
                .wait_operation_view(&operation_id, PUBLISH_WAIT)
                .await?;
            if view.is_pending() {
                db.update_ism_upload(job_id, "next_check_at = ?2", &(now + PUBLISH_RECHECK_SECS))?;
                return Ok(Advance::Waiting(format!(
                    "ISM is publishing the file ({})",
                    view.status
                )));
            }
            if let Some(failure) = view.failure() {
                return Err(failure);
            }
            let published_original = view
                .items
                .iter()
                .filter_map(|item| item.result.as_ref())
                .filter_map(|result| result.get("files")?.as_array())
                .flatten()
                .find(|file| file.get("role").and_then(|role| role.as_str()) == Some("original"))
                .and_then(|file| serde_json::from_value::<Location>(file.get("to")?.clone()).ok());
            let location = match (published_original, &job.request.existing_original) {
                (Some(location), _) => location,
                (None, Some(existing)) => Location {
                    root_id: job.request.target.root_id.clone(),
                    path: if job.request.target.path.is_empty() {
                        existing.name.clone()
                    } else {
                        format!("{}/{}", job.request.target.path, existing.name)
                    },
                },
                (None, None) => {
                    return Err("ISM did not report where the upload was published".into())
                }
            };
            if location.root_id != job.request.target.root_id
                || !valid_relative_path(&location.path, false)
            {
                return Err("ISM published the upload to an unexpected location".into());
            }
            db.open()?
                .execute(
                    "UPDATE ism_upload_jobs SET final_root_id = ?2, final_path = ?3 WHERE job_id = ?1",
                    rusqlite::params![job_id, location.root_id, location.path],
                )
                .map_err(|err| err.to_string())?;
            (location, Some(view))
        }
    };
    let manifest = client.path_manifest(&location).await?;
    if manifest.location != location {
        return Err("ISM manifest does not match the published file".into());
    }
    // ISM fills the asset in the operation result once Immich imports the file; the manifest
    // is only the fallback for servers that do not.
    let reported = match &view {
        Some(view) => result_asset_id(view)?,
        None => None,
    };
    if let (Some(reported), Some(listed)) = (&reported, &manifest.asset_id) {
        if reported != listed {
            return Err("ISM reports different assets for the published file".into());
        }
    }
    match reported.or_else(|| manifest.asset_id.clone()) {
        Some(asset_id) => {
            if job.kind == "sidecar_sync" && job.asset_id.as_deref() != Some(asset_id.as_str()) {
                return Err("ISM reports a different asset after the sidecar update".into());
            }
            db.finish_ism_upload(job_id, &job.server_url, &asset_id, &manifest, job)?;
            Ok(Advance::Ready { asset_id })
        }
        None => {
            let since = job.waiting_since.unwrap_or(now);
            if now - since > IMPORT_TIMEOUT_SECS {
                db.open()?
                    .execute(
                        "UPDATE ism_upload_jobs SET waiting_since = NULL WHERE job_id = ?1",
                        [job_id],
                    )
                    .map_err(|err| err.to_string())?;
                return Err(format!(
                    "Immich has not imported {} yet; retry later",
                    file_name(&location.path)
                ));
            }
            db.open()?
                .execute(
                    "UPDATE ism_upload_jobs SET waiting_since = ?2, next_check_at = ?3, error = NULL
                     WHERE job_id = ?1",
                    rusqlite::params![job_id, since, now + IMPORT_RECHECK_SECS],
                )
                .map_err(|err| err.to_string())?;
            Ok(Advance::Waiting(
                "Published; waiting for Immich to import the file".into(),
            ))
        }
    }
}

fn result_asset_id(view: &OperationView) -> Result<Option<String>, String> {
    let mut found: Option<String> = None;
    for asset_id in view
        .items
        .iter()
        .filter_map(|item| item.result.as_ref()?.get("asset_id")?.as_str())
    {
        match &found {
            Some(known) if known != asset_id => {
                return Err("ISM reports several assets for one upload".into())
            }
            _ => found = Some(asset_id.to_string()),
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{server, TestDir};
    use super::*;

    fn upload(dir: &TestDir, on_conflict: &'static str) -> NewUpload {
        fs::write(dir.0.join("edit.jpg"), b"edited").unwrap();
        fs::write(dir.0.join("a.xmp"), b"xmp").unwrap();
        NewUpload {
            job_id: "job-1".into(),
            kind: "media",
            server_url: "https://immich.example/".into(),
            asset_id: None,
            target: Location {
                root_id: "photos".into(),
                path: "2025/Trip".into(),
            },
            provenance_original: Some((
                Location {
                    root_id: "photos".into(),
                    path: "2025/Trip/a.jpg".into(),
                },
                Some("rev-1".into()),
            )),
            files: vec![
                UploadFileSource {
                    local_path: dir.0.join("edit.jpg"),
                    name: "edit.jpg".into(),
                    role: FileRole::Original,
                    expected_revision: None,
                    expected_sha256: None,
                    track: true,
                },
                UploadFileSource {
                    local_path: dir.0.join("a.xmp"),
                    name: "edit.jpg.xmp".into(),
                    role: FileRole::Sidecar,
                    expected_revision: None,
                    expected_sha256: None,
                    track: false,
                },
            ],
            on_conflict,
        }
    }

    fn published(asset_id: Option<&str>) -> Vec<u8> {
        let sha = "a".repeat(64);
        serde_json::json!({
            "group_id": "g", "asset_id": asset_id,
            "location": { "root_id": "photos", "path": "2025/Trip/edit (1).jpg" }, "folder": "2025/Trip",
            "files": [
                { "role": "original", "name": "edit (1).jpg", "path": "2025/Trip/edit (1).jpg", "size": 6, "revision": "rev-9", "sha256": sha },
                { "role": "sidecar", "name": "edit (1).jpg.xmp", "path": "2025/Trip/edit (1).jpg.xmp", "size": 3, "revision": "rev-10", "sha256": sha }
            ]
        })
        .to_string()
        .into_bytes()
    }

    fn completed_publish(asset_id: Option<&str>) -> Vec<u8> {
        serde_json::json!({
            "operation_id": "op_1", "status": "completed",
            "items": [{ "index": 0, "kind": "publish_upload", "status": "done", "error": null,
                "result": { "asset_id": asset_id, "warnings": [], "files": [
                    { "from": null, "to": { "root_id": "photos", "path": "2025/Trip/edit (1).jpg" }, "role": "original" },
                    { "from": null, "to": { "root_id": "photos", "path": "2025/Trip/edit (1).jpg.xmp" }, "role": "sidecar" }
                ] } }]
        })
        .to_string()
        .into_bytes()
    }

    #[tokio::test]
    async fn upload_resumes_chunks_and_waits_for_the_immich_import() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.create_ism_upload(upload(&dir, "rename")).unwrap();
        let (url, requests) = server(vec![
            (
                "201 Created",
                br#"{"upload_id":"up_1","status":"receiving","files":[{"index":0,"received":2},{"index":1,"received":3}]}"#
                    .to_vec(),
            ),
            ("200 OK", br#"{"upload_id":"up_1","status":"receiving","files":[]}"#.to_vec()),
            ("202 Accepted", br#"{"operation_id":"op_1","status":"queued"}"#.to_vec()),
            ("200 OK", completed_publish(None)),
            ("200 OK", published(None)),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        assert!(matches!(
            advance_upload(&db, &client, "job-1").await.unwrap(),
            Advance::Waiting(_)
        ));
        let requests = requests.await.unwrap();
        let key = db.ism_upload_job("job-1").unwrap().request.idempotency_key;
        assert!(key.starts_with("ila-upload:job-1:"));
        assert!(requests[0].starts_with("POST /api/v1/uploads "));
        assert!(requests[0].contains(&format!("\"idempotency_key\":\"{key}\"")));
        assert!(requests[0].contains(r#""target":{"root_id":"photos","path":"2025/Trip"}"#));
        assert!(requests[0].contains(
            r#""original_location":{"root_id":"photos","path":"2025/Trip/a.jpg"},"expected_revision":"rev-1""#
        ));
        assert!(requests[0].contains(r#""on_conflict":"rename""#));
        assert!(requests[1].starts_with("PUT /api/v1/uploads/up_1/files/0 "));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("content-range: bytes 2-5/6"));
        assert!(requests[1].ends_with("ited"));
        assert!(requests[2].starts_with("POST /api/v1/uploads/up_1/commit "));
        assert!(requests[4].starts_with(
            "GET /api/v1/manifest?root_id=photos&path=2025%2FTrip%2Fedit+%281%29.jpg"
        ));

        // The next poll is deferred, then the asset ISM reports in the operation result is
        // tracked even before the manifest lists it.
        db.update_ism_upload("job-1", "next_check_at = ?2", &0i64)
            .unwrap();
        let (url, requests) = server(vec![
            ("200 OK", completed_publish(Some("asset-9"))),
            ("200 OK", published(None)),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        match advance_upload(&db, &client, "job-1").await.unwrap() {
            Advance::Ready { asset_id } => assert_eq!(asset_id, "asset-9"),
            Advance::Waiting(reason) => panic!("still waiting: {reason}"),
        }
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("GET /api/v1/operations/op_1 "));
        assert_eq!(requests.len(), 2);
        let tracked = db
            .ism_tracked_original("https://immich.example", "asset-9")
            .unwrap()
            .unwrap();
        assert_eq!(tracked.location.path, "2025/Trip/edit (1).jpg");
        let count: i64 = db
            .open()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ism_local_files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "the borrowed original sidecar is not tracked");
        // A finished job is not uploaded again.
        let (url, requests) = server(Vec::new()).await;
        let client = IsmClient::new(&url, "token").unwrap();
        assert!(matches!(
            advance_upload(&db, &client, "job-1").await.unwrap(),
            Advance::Ready { .. }
        ));
        assert!(requests.await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn refused_publish_is_surfaced_and_needs_a_fresh_upload() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.create_ism_upload(upload(&dir, "rename")).unwrap();
        let failed = serde_json::json!({
            "operation_id": "op_1", "status": "failed",
            "items": [{ "index": 0, "kind": "publish_upload", "status": "failed",
                "error": { "code": "maintenance_blocked", "message": "watcher still running" } }]
        })
        .to_string()
        .into_bytes();
        let (url, requests) = server(vec![
            (
                "201 Created",
                br#"{"upload_id":"up_1","status":"receiving","files":[{"index":0,"received":6},{"index":1,"received":3}]}"#
                    .to_vec(),
            ),
            ("202 Accepted", br#"{"operation_id":"op_1","status":"queued"}"#.to_vec()),
            ("200 OK", failed),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let error = advance_upload(&db, &client, "job-1").await.err().unwrap();
        assert!(error.contains("maintenance_blocked"));
        assert_eq!(requests.await.unwrap().len(), 3);
        assert!(!db.ism_upload_exists("job-1").unwrap());
    }

    #[tokio::test]
    async fn rejected_creation_keeps_the_persisted_key_for_a_manual_retry() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.create_ism_upload(upload(&dir, "rename")).unwrap();
        let key = db.ism_upload_job("job-1").unwrap().request.idempotency_key;
        let (url, requests) = server(vec![(
            "409 Conflict",
            br#"{"error":{"code":"direct_writes_unavailable","message":"gate not passed"}}"#
                .to_vec(),
        )])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let error = advance_upload(&db, &client, "job-1").await.err().unwrap();
        assert!(error.contains("direct_writes_unavailable"));
        assert_eq!(requests.await.unwrap().len(), 1);
        let job = db.ism_upload_job("job-1").unwrap();
        assert_eq!(job.request.idempotency_key, key);
        assert!(job.upload_id.is_none());
    }

    #[tokio::test]
    async fn sidecar_only_upload_targets_the_existing_original_and_uses_the_manifest_fallback() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        fs::write(dir.0.join("a.jpg.xmp"), b"xmp").unwrap();
        db.create_ism_upload(NewUpload {
            job_id: "sidecar-1".into(),
            kind: "sidecar_sync",
            server_url: "https://immich.example/".into(),
            asset_id: Some("asset-1".into()),
            target: Location {
                root_id: "photos".into(),
                path: "2025/Trip".into(),
            },
            provenance_original: Some((
                Location {
                    root_id: "photos".into(),
                    path: "2025/Trip/a.jpg".into(),
                },
                Some("rev-1".into()),
            )),
            files: vec![UploadFileSource {
                local_path: dir.0.join("a.jpg.xmp"),
                name: "a.jpg.xmp".into(),
                role: FileRole::Sidecar,
                expected_revision: Some("rev-2".into()),
                expected_sha256: Some("b".repeat(64)),
                track: true,
            }],
            on_conflict: "replace_if_expected",
        })
        .unwrap();
        let sha = "a".repeat(64);
        let manifest = serde_json::json!({
            "group_id": "g", "asset_id": "asset-1",
            "location": { "root_id": "photos", "path": "2025/Trip/a.jpg" }, "folder": "2025/Trip",
            "files": [
                { "role": "original", "name": "a.jpg", "path": "2025/Trip/a.jpg", "size": 6, "revision": "rev-1", "sha256": sha },
                { "role": "sidecar", "name": "a.jpg.xmp", "path": "2025/Trip/a.jpg.xmp", "size": 3, "revision": "rev-3", "sha256": sha }
            ]
        })
        .to_string()
        .into_bytes();
        let operation = serde_json::json!({
            "operation_id": "op_2", "status": "completed",
            "items": [{ "index": 0, "kind": "publish_upload", "status": "done", "error": null,
                "result": { "asset_id": null, "warnings": [], "files": [
                    { "from": null, "to": { "root_id": "photos", "path": "2025/Trip/a.jpg.xmp" }, "role": "sidecar" }
                ] } }]
        })
        .to_string()
        .into_bytes();
        let (url, requests) =
            server(vec![
            (
                "201 Created",
                br#"{"upload_id":"up_2","status":"receiving","files":[{"index":0,"received":3}]}"#
                    .to_vec(),
            ),
            ("202 Accepted", br#"{"operation_id":"op_2","status":"queued"}"#.to_vec()),
            ("200 OK", operation),
            ("200 OK", manifest),
        ])
            .await;
        let client = IsmClient::new(&url, "token").unwrap();
        match advance_upload(&db, &client, "sidecar-1").await.unwrap() {
            Advance::Ready { asset_id } => assert_eq!(asset_id, "asset-1"),
            Advance::Waiting(reason) => panic!("still waiting: {reason}"),
        }
        let requests = requests.await.unwrap();
        assert!(!requests[0].contains(r#""role":"original""#));
        assert!(requests[0].contains(r#""expected_revision":"rev-2""#));
        assert!(requests[0].contains(
            r#""original_location":{"root_id":"photos","path":"2025/Trip/a.jpg"},"expected_revision":"rev-1""#
        ));
        assert!(requests[0].contains(r#""on_conflict":"replace_if_expected""#));
        assert!(requests[0]
            .contains(r#""existing_original":{"name":"a.jpg","expected_revision":"rev-1"}"#));
        assert!(requests[3]
            .starts_with("GET /api/v1/manifest?root_id=photos&path=2025%2FTrip%2Fa.jpg "));
        let revision: String = db
            .open()
            .unwrap()
            .query_row(
                "SELECT revision FROM ism_local_files WHERE role = 'sidecar'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, "rev-3");
    }
}
