use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::services::db::Database;

mod detect;
mod events;
mod operations;
mod uploads;

pub use detect::{detect_ism_local_changes, process_ism_background_work};
pub use operations::{run_operation, ActivityEntry, ExpectedEntry, OperationAction, OperationView};
pub use uploads::{advance_upload, Advance, NewUpload, UploadFileSource};

pub struct Provider {
    pub base_url: String,
    pub client_token: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeletionBinding {
    instance_id: String,
    base_url: String,
    credential_hash: String,
    request_key: String,
}

impl DeletionBinding {
    pub fn request_key(&self) -> &str {
        &self.request_key
    }
}

impl Database {
    pub fn ism_guards_local_changes(&self, asset_id: &str) -> Result<bool, String> {
        self.open()?
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM ism_local_files WHERE asset_id = ?1
                    UNION ALL
                    SELECT 1 FROM ism_local_deletion_requests WHERE asset_id = ?1
                    UNION ALL
                    SELECT 1 FROM assets
                    JOIN accounts ON accounts.id = assets.account_id
                    JOIN ism_providers ON ism_providers.server_url = rtrim(accounts.server_url, '/')
                    WHERE assets.id = ?1
                )",
                [asset_id],
                |row| row.get(0),
            )
            .map_err(|err| format!("Cannot verify ISM local-change protection: {err}"))
    }

    pub fn ism_provider(&self, server_url: &str) -> Result<Option<Provider>, String> {
        use rusqlite::OptionalExtension;
        self.open()?
            .query_row(
                "SELECT base_url, client_token FROM ism_providers WHERE server_url = ?1",
                [server_url.trim_end_matches('/')],
                |row| {
                    Ok(Provider {
                        base_url: row.get(0)?,
                        client_token: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn save_ism_provider(&self, server_url: &str, provider: &Provider) -> Result<(), String> {
        self.open()?.execute(
            "INSERT INTO ism_providers (server_url, base_url, client_token) VALUES (?1, ?2, ?3)
             ON CONFLICT(server_url) DO UPDATE SET base_url = excluded.base_url, client_token = excluded.client_token",
            rusqlite::params![server_url.trim_end_matches('/'), provider.base_url, provider.client_token],
        ).map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn ism_import_folder(&self, server_url: &str) -> Result<Option<Location>, String> {
        use rusqlite::OptionalExtension;
        Ok(self
            .open()?
            .query_row(
                "SELECT import_root_id, import_path FROM ism_providers WHERE server_url = ?1",
                [server_url.trim_end_matches('/')],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?
            .and_then(|(root_id, path)| {
                Some(Location {
                    root_id: root_id?,
                    path: path?,
                })
            }))
    }

    pub fn set_ism_import_folder(
        &self,
        server_url: &str,
        folder: Option<&Location>,
    ) -> Result<(), String> {
        if let Some(folder) = folder {
            if folder.root_id.is_empty() || !valid_relative_path(&folder.path, true) {
                return Err("ISM import folder is invalid".into());
            }
        }
        let updated = self
            .open()?
            .execute(
                "UPDATE ism_providers SET import_root_id = ?2, import_path = ?3 WHERE server_url = ?1",
                rusqlite::params![
                    server_url.trim_end_matches('/'),
                    folder.map(|f| f.root_id.as_str()),
                    folder.map(|f| f.path.as_str())
                ],
            )
            .map_err(|err| err.to_string())?;
        if updated != 1 {
            return Err("ISM is not configured for this server".into());
        }
        Ok(())
    }

    pub fn remove_ism_provider(&self, server_url: &str) -> Result<(), String> {
        self.open()?
            .execute(
                "DELETE FROM ism_providers WHERE server_url = ?1",
                [server_url.trim_end_matches('/')],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn record_ism_download(
        &self,
        asset_id: &str,
        server_url: &str,
        group: &DownloadedGroup,
        album_id: Option<&str>,
        source_kind: &str,
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        for file in &group.files {
            let path = file
                .local_path
                .to_str()
                .ok_or("Downloaded path is not valid UTF-8")?;
            upsert_ism_local_file(
                &tx,
                asset_id,
                server_url,
                &group.manifest,
                &file.manifest_file,
                path,
            )?;
            if file.manifest_file.role == FileRole::Original {
                let name = file
                    .local_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Downloaded filename is invalid")?;
                let metadata = fs::metadata(&file.local_path).map_err(|err| err.to_string())?;
                let mtime = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|time| i64::try_from(time.as_millis()).ok());
                tx.execute(
                    "INSERT INTO local_saved_assets (asset_id, album_id, local_path, file_name, source_kind, last_known_mtime_ms, last_known_size_bytes)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(asset_id, local_path) DO UPDATE SET album_id=excluded.album_id, file_name=excluded.file_name,
                       source_kind=excluded.source_kind, last_known_mtime_ms=excluded.last_known_mtime_ms,
                       last_known_size_bytes=excluded.last_known_size_bytes,
                       last_scanned_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                       updated_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
                    rusqlite::params![asset_id, album_id, path, name, source_kind, mtime, file.manifest_file.size as i64],
                ).map_err(|err| err.to_string())?;
            }
        }
        tx.commit().map_err(|err| err.to_string())
    }

    pub fn ism_deletion_request(
        &self,
        change_id: i64,
        asset_id: &str,
        server_url: &str,
    ) -> Result<Option<(String, String)>, String> {
        use rusqlite::OptionalExtension;
        self.open()?
            .query_row(
                "SELECT root_id, remote_path FROM ism_local_deletion_requests
                 WHERE change_id = ?1 AND asset_id = ?2 AND server_url = ?3",
                rusqlite::params![change_id, asset_id, server_url.trim_end_matches('/')],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|err| format!("Cannot read ISM deletion retry state: {err}"))
    }

    /// The original's revision recorded with a deletion request, if it was known then.
    pub fn ism_deletion_revision(&self, change_id: i64) -> Result<Option<String>, String> {
        use rusqlite::OptionalExtension;
        self.open()?
            .query_row(
                "SELECT expected_revision FROM ism_local_deletion_requests WHERE change_id = ?1",
                [change_id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(|err| format!("Cannot read ISM deletion retry state: {err}"))
    }

    pub fn ism_deletion_request_for_change(
        &self,
        change_id: i64,
    ) -> Result<Option<(String, String, String, String)>, String> {
        use rusqlite::OptionalExtension;
        self.open()?
            .query_row(
                "SELECT asset_id, server_url, root_id, remote_path FROM ism_local_deletion_requests WHERE change_id = ?1",
                [change_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|err| format!("Cannot read ISM deletion retry state: {err}"))
    }

    pub fn record_ism_deletion_request(
        &self,
        change_id: i64,
        asset_id: &str,
        server_url: &str,
        location: &Location,
        binding: Option<&DeletionBinding>,
        expected_revision: Option<&str>,
    ) -> Result<(String, String), String> {
        let mut conn = self.open()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO ism_local_deletion_requests
             (change_id, asset_id, server_url, root_id, remote_path, expected_revision)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (
               SELECT 1 FROM local_saved_asset_changes
               WHERE id = ?1 AND asset_id = ?2 AND change_kind = 'deleted' AND resolved_at IS NULL
             )",
                rusqlite::params![
                    change_id,
                    asset_id,
                    server_url.trim_end_matches('/'),
                    location.root_id,
                    location.path,
                    expected_revision
                ],
            )
            .map_err(|err| format!("Cannot persist ISM deletion retry state: {err}"))?;
        if inserted == 1 {
            if let Some(binding) = binding {
                tx.execute(
                    "INSERT INTO ism_local_deletion_bindings (change_id, instance_id, base_url, credential_hash, request_key)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![change_id, binding.instance_id, binding.base_url, binding.credential_hash, binding.request_key],
                )
                .map_err(|err| format!("Cannot persist ISM deletion identity: {err}"))?;
            }
        }
        let saved: (String, String, String, String) = tx
            .query_row(
                "SELECT asset_id, server_url, root_id, remote_path
                 FROM ism_local_deletion_requests WHERE change_id = ?1",
                [change_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|err| format!("Cannot persist ISM deletion: notice is no longer pending or its retry state cannot be read: {err}"))?;
        if saved.0 != asset_id || saved.1 != server_url.trim_end_matches('/') {
            return Err("ISM deletion change ID was reused for a different asset".into());
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok((saved.2, saved.3))
    }

    pub fn ism_deletion_binding(&self, change_id: i64) -> Result<Option<DeletionBinding>, String> {
        use rusqlite::OptionalExtension;
        self.open()?
            .query_row(
                "SELECT instance_id, base_url, credential_hash, COALESCE(request_key, 'ila-local-deletion:' || change_id) FROM ism_local_deletion_bindings WHERE change_id = ?1",
                [change_id],
                |row| Ok(DeletionBinding {
                    instance_id: row.get(0)?,
                    base_url: row.get(1)?,
                    credential_hash: row.get(2)?,
                    request_key: row.get(3)?,
                }),
            )
            .optional()
            .map_err(|err| format!("Cannot read ISM deletion identity: {err}"))
    }

    pub fn dismiss_cancelled_ism_deletion(
        &self,
        change_id: i64,
        binding: &DeletionBinding,
        keep_local_copy: bool,
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let removed = tx.execute(
            "DELETE FROM ism_local_deletion_bindings WHERE change_id = ?1 AND instance_id = ?2 AND base_url = ?3 AND credential_hash = ?4 AND COALESCE(request_key, 'ila-local-deletion:' || change_id) = ?5",
            rusqlite::params![change_id, binding.instance_id, binding.base_url, binding.credential_hash, binding.request_key],
        ).map_err(|err| err.to_string())?;
        if removed != 1 {
            return Err(
                "ISM deletion identity changed while cancelling; the notice was retained".into(),
            );
        }
        if !keep_local_copy {
            tx.execute(
                "DELETE FROM local_saved_assets WHERE EXISTS (
                    SELECT 1 FROM local_saved_asset_changes c WHERE c.id = ?1
                    AND c.resolved_at IS NULL AND c.asset_id = local_saved_assets.asset_id
                    AND c.local_path = local_saved_assets.local_path
                )",
                [change_id],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.execute(
            "DELETE FROM ism_local_deletion_requests WHERE change_id = ?1",
            [change_id],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            "UPDATE local_saved_asset_changes SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
             WHERE id = ?1 AND resolved_at IS NULL",
            [change_id],
        )
        .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())
    }

    pub fn resolve_ism_deletion(&self, change_id: i64) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        tx.execute(
            "UPDATE local_saved_asset_changes
             SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
             WHERE id = ?1 AND resolved_at IS NULL",
            [change_id],
        )
        .map_err(|err| format!("Cannot resolve ISM local deletion: {err}"))?;
        tx.execute(
            "DELETE FROM ism_local_deletion_requests WHERE change_id = ?1",
            [change_id],
        )
        .map_err(|err| format!("Cannot clear ISM deletion retry state: {err}"))?;
        tx.execute(
            "DELETE FROM ism_local_deletion_bindings WHERE change_id = ?1",
            [change_id],
        )
        .map_err(|err| format!("Cannot clear ISM deletion identity: {err}"))?;
        tx.commit()
            .map_err(|err| format!("Cannot commit ISM local deletion: {err}"))
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ClientInfo {
    pub instance_id: String,
    pub instance_name: String,
    pub version: String,
    pub api_version: u32,
    pub token_kind: String,
    pub actions: Vec<String>,
    pub roots: Vec<ClientRoot>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ClientRoot {
    pub root_id: String,
    pub name: String,
    pub immich_import_path: Option<String>,
    pub opm_prefix: Option<String>,
    pub available: bool,
    /// `enabled`, `not_linked` or `blocked`.
    pub direct_writes: String,
    /// Why writes are refused when `direct_writes` is `blocked`.
    #[serde(default)]
    pub direct_writes_reason: Option<String>,
    #[serde(default)]
    pub direct_writes_detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Location {
    pub root_id: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileRole {
    Original,
    Sidecar,
    Companion,
}

#[derive(Clone, Deserialize)]
pub struct ManifestFile {
    pub role: FileRole,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub revision: String,
    pub sha256: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct Manifest {
    pub group_id: String,
    pub asset_id: Option<String>,
    pub location: Location,
    pub folder: String,
    pub files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
struct OperationAccepted {
    operation_id: String,
}

#[derive(Deserialize)]
struct OperationStatus {
    status: String,
    #[serde(default)]
    items: Vec<OperationItem>,
}

#[derive(Deserialize)]
struct OperationItem {
    kind: Option<String>,
    status: Option<String>,
    error: Option<OperationError>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum CancellationResult {
    CancelledBeforeSubmission,
    Operation { operation: OperationStatus },
}

#[derive(Deserialize)]
struct OperationError {
    message: String,
}

pub struct DownloadedFile {
    pub manifest_file: ManifestFile,
    pub local_path: PathBuf,
}

pub struct DownloadedGroup {
    pub manifest: Manifest,
    pub files: Vec<DownloadedFile>,
}

enum DownloadError {
    Changed,
    Message(String),
}

impl From<String> for DownloadError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&str> for DownloadError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

#[derive(Clone)]
pub struct IsmClient {
    base_url: Url,
    authorization: HeaderValue,
    client: Client,
    credential_hash: String,
}

impl IsmClient {
    pub fn new(base_url: &str, token: &str) -> Result<Self, String> {
        let mut base_url =
            Url::parse(base_url.trim()).map_err(|_| "Invalid ISM URL".to_string())?;
        if !matches!(base_url.scheme(), "http" | "https")
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(
                "ISM URL must be an HTTP(S) URL without credentials, query, or fragment".into(),
            );
        }
        let path = format!("{}/", base_url.path().trim_end_matches('/'));
        base_url.set_path(&path);
        if token.trim().is_empty() || token != token.trim() {
            return Err("ISM token is required".into());
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "Invalid ISM token")?;
        authorization.set_sensitive(true);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|err| err.without_url().to_string())?;
        Ok(Self {
            base_url,
            authorization,
            client,
            credential_hash: hex::encode(Sha256::digest(token.as_bytes())),
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url, String> {
        self.base_url
            .join(path)
            .map_err(|_| "Invalid ISM endpoint".into())
    }

    pub fn base_url(&self) -> &str {
        self.base_url.as_str()
    }

    fn validate_deletion_info(info: &ClientInfo) -> Result<(), String> {
        if info.api_version != 1
            || info.token_kind != "ila"
            || info.instance_id.is_empty()
            || ![
                "trash_if_asset_matches",
                "cancel_operation_by_key",
                "instance_scoped_operations",
            ]
            .iter()
            .all(|required| {
                info.capabilities
                    .iter()
                    .any(|capability| capability == required)
            })
        {
            return Err(
                "ISM cannot safely reconcile deletion requests; update the ISM server".into(),
            );
        }
        Ok(())
    }

    pub fn deletion_binding(&self, info: &ClientInfo) -> Result<DeletionBinding, String> {
        Self::validate_deletion_info(info)?;
        Ok(DeletionBinding {
            instance_id: info.instance_id.clone(),
            base_url: self.base_url.to_string(),
            credential_hash: self.credential_hash.clone(),
            request_key: format!("ila-local-deletion:{}", Uuid::new_v4()),
        })
    }

    fn verify_deletion_binding(
        &self,
        info: &ClientInfo,
        binding: &DeletionBinding,
    ) -> Result<(), String> {
        Self::validate_deletion_info(info)?;
        if info.instance_id != binding.instance_id
            || self.base_url.as_str() != binding.base_url
            || self.credential_hash != binding.credential_hash
        {
            return Err(
                "ISM deletion server or credential changed; the notice was retained".into(),
            );
        }
        Ok(())
    }

    fn scoped_operation_url(&self, instance_id: &str, cancel: bool) -> Result<Url, String> {
        let mut url = self.endpoint("api/v1/instances/")?;
        let mut segments = url.path_segments_mut().map_err(|_| "Invalid ISM URL")?;
        segments.pop_if_empty().push(instance_id).push("operations");
        if cancel {
            segments.push("cancel-by-key");
        }
        drop(segments);
        Ok(url)
    }

    async fn get(&self, url: Url) -> Result<reqwest::Response, String> {
        self.client
            .get(url)
            .header(AUTHORIZATION, self.authorization.clone())
            .send()
            .await
            .map_err(|err| format!("ISM request failed: {}", err.without_url()))
    }

    async fn post_json<T: Serialize + ?Sized>(
        &self,
        url: Url,
        body: &T,
    ) -> Result<reqwest::Response, String> {
        self.client
            .post(url)
            .header(AUTHORIZATION, self.authorization.clone())
            .json(body)
            .send()
            .await
            .map_err(|err| format!("ISM request failed: {}", err.without_url()))
    }

    pub async fn trash_asset_at(
        &self,
        root_id: &str,
        path: &str,
        asset_id: &str,
        idempotency_key: &str,
        binding: Option<&DeletionBinding>,
        expected_revision: Option<&str>,
    ) -> Result<(), String> {
        if root_id.is_empty()
            || path.is_empty()
            || asset_id.is_empty()
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
        {
            return Err("ISM deletion location is invalid".into());
        }
        let info = self.info().await?;
        if info.api_version != 1
            || info.token_kind != "ila"
            || !info
                .capabilities
                .iter()
                .any(|c| c == "trash_if_asset_matches")
        {
            return Err(
                "ISM cannot verify the asset identity for deletion; update the ISM server".into(),
            );
        }
        if let Some(binding) = binding {
            self.verify_deletion_binding(&info, binding)?;
            if binding.request_key != idempotency_key {
                return Err(
                    "ISM deletion request identity changed; the notice was retained".into(),
                );
            }
        }
        let body =
            deletion_request_body(root_id, path, asset_id, idempotency_key, expected_revision);
        let url = match binding {
            Some(binding) => self.scoped_operation_url(&binding.instance_id, false)?,
            None => self.endpoint("api/v1/operations")?,
        };
        let response = self.post_json(url, &body).await?;
        let accepted: OperationAccepted = successful(response)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid ISM operation response".to_string())?;
        self.wait_for_operation(&accepted.operation_id, binding)
            .await
    }

    pub async fn cancel_deletion(
        &self,
        binding: &DeletionBinding,
        root_id: &str,
        path: &str,
        asset_id: &str,
        expected_revision: Option<&str>,
    ) -> Result<(), String> {
        let info = self.info().await?;
        self.verify_deletion_binding(&info, binding)?;
        let key = binding.request_key();
        let body = serde_json::json!({
            "idempotency_key": key,
            "expected_request": deletion_request_body(root_id, path, asset_id, key, expected_revision),
        });
        let response = self
            .post_json(
                self.scoped_operation_url(&binding.instance_id, true)?,
                &body,
            )
            .await?;
        let result: CancellationResult = successful(response)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid ISM cancellation response".to_string())?;
        match result {
            CancellationResult::CancelledBeforeSubmission => Ok(()),
            CancellationResult::Operation { operation }
                if operation.status == "cancelled"
                    && operation.items.len() == 1
                    && operation.items[0].kind.as_deref() == Some("trash_if_asset_matches")
                    && operation.items[0].status.as_deref() == Some("skipped") => Ok(()),
            CancellationResult::Operation { operation } => Err(format!(
                "ISM deletion is {} and cannot be safely skipped; check its operation before proceeding",
                operation.status
            )),
        }
    }

    async fn wait_for_operation(
        &self,
        operation_id: &str,
        binding: Option<&DeletionBinding>,
    ) -> Result<(), String> {
        let mut url = match binding {
            Some(binding) => self.scoped_operation_url(&binding.instance_id, false)?,
            None => self.endpoint("api/v1/operations/")?,
        };
        url.path_segments_mut()
            .map_err(|_| "Invalid ISM URL")?
            .pop_if_empty()
            .push(operation_id);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            let response = successful(self.get(url.clone()).await?).await?;
            let operation: OperationStatus = response
                .json()
                .await
                .map_err(|_| "Invalid ISM operation status".to_string())?;
            match operation.status.as_str() {
                "completed" => return Ok(()),
                "failed" | "partial" | "recovery_required" | "cancelled" => {
                    let reason = operation
                        .items
                        .iter()
                        .find_map(|item| item.error.as_ref().map(|error| error.message.as_str()))
                        .unwrap_or("ISM operation did not complete");
                    return Err(format!("ISM operation {}: {reason}", operation.status));
                }
                "queued" | "waiting_maintenance" | "running" => {}
                status => return Err(format!("ISM returned unknown operation status: {status}")),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "ISM operation {operation_id} is still pending; retry to check it again"
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    pub async fn info(&self) -> Result<ClientInfo, String> {
        let response = self.get(self.endpoint("api/v1/client/info")?).await?;
        let response = successful(response).await?;
        response
            .json()
            .await
            .map_err(|_| "Invalid ISM client information".into())
    }

    async fn manifest(&self, asset_id: &str) -> Result<Manifest, String> {
        let mut url = self.endpoint("api/v1/assets/")?;
        url.path_segments_mut()
            .map_err(|_| "Invalid ISM URL")?
            .pop_if_empty()
            .push(asset_id)
            .push("manifest");
        let response = successful(self.get(url).await?).await?;
        let manifest: Manifest = response
            .json()
            .await
            .map_err(|_| "Invalid ISM manifest".to_string())?;
        validate_manifest(&manifest, Some(asset_id))?;
        Ok(manifest)
    }

    /// The asset's current location and the revision of its original file.
    pub async fn asset_original(&self, asset_id: &str) -> Result<(Location, String), String> {
        let manifest = self.manifest(asset_id).await?;
        let revision = manifest
            .files
            .iter()
            .find(|file| file.role == FileRole::Original)
            .map(|file| file.revision.clone())
            .ok_or("ISM manifest has no original")?;
        Ok((manifest.location, revision))
    }

    pub async fn download_group<F>(
        &self,
        asset_id: &str,
        destination: &Path,
        mut progress: F,
    ) -> Result<DownloadedGroup, String>
    where
        F: FnMut(u64, u64),
    {
        for attempt in 0..3 {
            let manifest = self.manifest(asset_id).await?;
            match self
                .download_manifest(manifest, destination, &mut progress)
                .await
            {
                Ok(group) => return Ok(group),
                Err(DownloadError::Changed) if attempt < 2 => continue,
                Err(DownloadError::Changed) => {
                    return Err("ISM files changed repeatedly during download".into());
                }
                Err(DownloadError::Message(message)) => return Err(message),
            }
        }
        Err("ISM download failed".into())
    }

    async fn download_manifest<F>(
        &self,
        manifest: Manifest,
        destination: &Path,
        progress: &mut F,
    ) -> Result<DownloadedGroup, DownloadError>
    where
        F: FnMut(u64, u64),
    {
        let names = destination_names(&manifest, destination)?;
        let total = manifest
            .files
            .iter()
            .try_fold(0u64, |sum, file| {
                sum.checked_add(file.size)
                    .ok_or("ISM manifest size is too large")
            })
            .map_err(str::to_string)?;
        let stage = Stage::new(destination)?;
        let mut completed = 0u64;
        progress(0, total);
        for (index, file) in manifest.files.iter().enumerate() {
            let mut url = self.endpoint("api/v1/content")?;
            url.query_pairs_mut()
                .append_pair("root_id", &manifest.location.root_id)
                .append_pair("path", &file.path)
                .append_pair("revision", &file.revision);
            let mut response = self.get(url).await?;
            if response.status() == StatusCode::PRECONDITION_FAILED {
                return Err(DownloadError::Changed);
            }
            response = successful(response).await?;
            let mut output = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(stage.file(index))
                .await
                .map_err(|err| format!("Cannot create ISM download staging file: {err}"))?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|err| format!("ISM download failed: {}", err.without_url()))?
            {
                size = size
                    .checked_add(chunk.len() as u64)
                    .ok_or("ISM file is too large")?;
                if size > file.size {
                    return Err("ISM download exceeded its manifest size".to_string().into());
                }
                output
                    .write_all(&chunk)
                    .await
                    .map_err(|err| format!("Cannot write ISM download: {err}"))?;
                hash.update(&chunk);
                progress(completed + size, total);
            }
            output
                .sync_all()
                .await
                .map_err(|err| format!("Cannot sync ISM download: {err}"))?;
            let expected = file
                .sha256
                .as_deref()
                .ok_or("ISM manifest is missing a SHA-256 hash")?;
            if size != file.size || !hex::encode(hash.finalize()).eq_ignore_ascii_case(expected) {
                return Err("ISM download does not match its manifest"
                    .to_string()
                    .into());
            }
            completed += size;
        }
        let mut files = Vec::with_capacity(manifest.files.len());
        for (index, (file, name)) in manifest.files.iter().zip(names).enumerate() {
            let local_path = destination.join(name);
            if let Err(err) = fs::hard_link(stage.file(index), &local_path) {
                let published = files
                    .iter()
                    .map(|file: &DownloadedFile| file.local_path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                let suffix = if published.is_empty() {
                    String::new()
                } else {
                    format!("; already published: {published}")
                };
                return Err(format!("Cannot publish ISM download: {err}{suffix}").into());
            }
            files.push(DownloadedFile {
                manifest_file: file.clone(),
                local_path,
            });
        }
        Ok(DownloadedGroup { manifest, files })
    }
}

fn deletion_request_body(
    root_id: &str,
    path: &str,
    asset_id: &str,
    key: &str,
    expected_revision: Option<&str>,
) -> serde_json::Value {
    let mut action = serde_json::json!({
        "kind": "trash_if_asset_matches",
        "source": { "root_id": root_id, "path": path },
        "expected_asset_id": asset_id
    });
    // Requests recorded before revisions were kept must be resent byte-for-byte as before.
    if let Some(revision) = expected_revision {
        action["expected_revision"] = revision.into();
    }
    serde_json::json!({
        "idempotency_key": key,
        "label": "Delete local asset",
        "actions": [action],
        "allow_owner_transfer": false
    })
}

async fn successful(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    #[derive(Deserialize)]
    struct ErrorBody {
        error: ErrorDetail,
    }
    #[derive(Deserialize)]
    struct ErrorDetail {
        code: String,
        message: String,
    }
    match response.json::<ErrorBody>().await {
        Ok(body) => Err(format!("ISM {}: {}", body.error.code, body.error.message)),
        Err(_) => Err(format!("ISM request failed ({status})")),
    }
}

fn upsert_ism_local_file(
    tx: &rusqlite::Transaction<'_>,
    asset_id: &str,
    server_url: &str,
    manifest: &Manifest,
    file: &ManifestFile,
    local_path: &str,
) -> Result<(), String> {
    let size = i64::try_from(file.size).map_err(|_| "ISM file is too large to track")?;
    let role = match file.role {
        FileRole::Original => "original",
        FileRole::Sidecar => "sidecar",
        FileRole::Companion => "companion",
    };
    let recorded = tx
        .execute(
            "INSERT INTO ism_local_files (asset_id, server_url, group_id, role, local_path, root_id, remote_path, folder, revision, size_bytes, sha256)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(local_path) DO UPDATE SET
               server_url=excluded.server_url, group_id=excluded.group_id, root_id=excluded.root_id,
               remote_path=excluded.remote_path, folder=excluded.folder, revision=excluded.revision,
               size_bytes=excluded.size_bytes, sha256=excluded.sha256
             WHERE ism_local_files.asset_id=excluded.asset_id AND ism_local_files.role=excluded.role
               AND ism_local_files.server_url=excluded.server_url",
            rusqlite::params![
                asset_id,
                server_url,
                manifest.group_id,
                role,
                local_path,
                manifest.location.root_id,
                file.path,
                manifest.folder,
                file.revision,
                size,
                file.sha256
            ],
        )
        .map_err(|err| err.to_string())?;
    if recorded != 1 {
        return Err("Local path is tracked for another ISM file".into());
    }
    Ok(())
}

/// Validates an ISM root-relative path; `allow_empty` accepts the root itself.
fn valid_relative_path(path: &str, allow_empty: bool) -> bool {
    if path.is_empty() {
        return allow_empty;
    }
    path.split('/')
        .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains(['\\', '\0']))
}

fn sha256_file(path: &Path) -> Result<(u64, String), String> {
    let mut file =
        fs::File::open(path).map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    let mut hash = Sha256::new();
    let size = io::copy(&mut file, &mut hash)
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    Ok((size, hex::encode(hash.finalize())))
}

fn valid_name(name: &str) -> bool {
    let valid = !name.is_empty()
        && !name.contains(['/', '\\', '\0'])
        && matches!(
            Path::new(name).components().collect::<Vec<_>>().as_slice(),
            [Component::Normal(_)]
        );
    #[cfg(windows)]
    {
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        valid
            && !reserved
            && !name.ends_with(['.', ' '])
            && !name
                .chars()
                .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    }
    #[cfg(not(windows))]
    {
        valid
    }
}

fn validate_manifest(manifest: &Manifest, asset_id: Option<&str>) -> Result<(), String> {
    if asset_id.is_some_and(|asset_id| {
        manifest
            .asset_id
            .as_deref()
            .is_some_and(|id| id != asset_id)
    }) || manifest.location.root_id.is_empty()
        || manifest.group_id.is_empty()
    {
        return Err("ISM manifest does not match the requested asset".into());
    }
    let mut names = HashSet::new();
    let mut originals = 0;
    for file in &manifest.files {
        if !valid_name(&file.name)
            || !names.insert(file.name.to_lowercase())
            || file.revision.is_empty()
            || !file
                .sha256
                .as_deref()
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("ISM manifest contains an invalid file".into());
        }
        let expected_path = if manifest.folder.is_empty() {
            file.name.clone()
        } else {
            format!("{}/{}", manifest.folder, file.name)
        };
        if file.path != expected_path
            || file
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
        {
            return Err("ISM manifest contains an invalid path".into());
        }
        if file.role == FileRole::Original {
            originals += 1;
            if file.path != manifest.location.path {
                return Err("ISM manifest original does not match its location".into());
            }
        }
    }
    if originals != 1 {
        return Err("ISM manifest must contain exactly one original".into());
    }
    Ok(())
}

fn destination_names(manifest: &Manifest, destination: &Path) -> Result<Vec<String>, String> {
    let original = manifest
        .files
        .iter()
        .find(|f| f.role == FileRole::Original)
        .ok_or("ISM manifest has no original")?;
    let original_path = Path::new(&original.name);
    let stem = original_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid original filename")?;
    let extension = original_path.extension().and_then(|s| s.to_str());
    for number in 0..10_000 {
        let new_stem = if number == 0 {
            stem.to_string()
        } else {
            format!("{stem} ({number})")
        };
        let new_original = match extension {
            Some(ext) => format!("{new_stem}.{ext}"),
            None => new_stem.clone(),
        };
        let mut names = Vec::with_capacity(manifest.files.len());
        let mut distinct = HashSet::new();
        let mut available = true;
        for file in &manifest.files {
            let name = if file.role == FileRole::Original {
                new_original.clone()
            } else if let Some(suffix) = file
                .name
                .strip_prefix(&original.name)
                .filter(|s| s.starts_with('.'))
            {
                format!("{new_original}{suffix}")
            } else if let Some(suffix) = file.name.strip_prefix(stem).filter(|s| s.starts_with('.'))
            {
                format!("{new_stem}{suffix}")
            } else {
                return Err("ISM companion name does not match the original".into());
            };
            if !distinct.insert(name.to_lowercase()) {
                return Err("ISM manifest produces duplicate local filenames".into());
            }
            match fs::symlink_metadata(destination.join(&name)) {
                Ok(_) => available = false,
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("Cannot inspect download destination: {err}")),
            }
            names.push(name);
        }
        if available {
            return Ok(names);
        }
    }
    Err("No collision-free filename is available for the ISM file group".into())
}

struct Stage {
    path: PathBuf,
}

impl Stage {
    fn new(destination: &Path) -> Result<Self, String> {
        let path = destination.join(format!(".ism-download-{}", Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|err| format!("Cannot create ISM download staging folder: {err}"))?;
        Ok(Self { path })
    }

    fn file(&self, index: usize) -> PathBuf {
        self.path.join(index.to_string())
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        if let Err(err) = fs::remove_dir_all(&self.path) {
            log::warn!("Failed to remove ISM download staging folder: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub(super) struct TestDir(pub(super) PathBuf);

    impl TestDir {
        pub(super) fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ism-download-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn manifest(original: &[u8], sidecar: &[u8]) -> String {
        serde_json::json!({
                "group_id": "photos:2025/example",
                "asset_id": "asset-1",
                "location": { "root_id": "photos", "path": "2025/example.CR3" },
                "folder": "2025",
                "files": [
                    { "role": "original", "name": "example.CR3", "path": "2025/example.CR3",
                      "size": original.len(), "revision": "rev-1", "sha256": hex::encode(Sha256::digest(original)) },
                    { "role": "sidecar", "name": "example.CR3.xmp", "path": "2025/example.CR3.xmp",
                      "size": sidecar.len(), "revision": "rev-2", "sha256": hex::encode(Sha256::digest(sidecar)) }
                ]
            }).to_string()
    }

    pub(super) fn client_info(capabilities: &[&str]) -> Vec<u8> {
        serde_json::json!({
            "instance_id": "ism-test", "instance_name": "Test", "version": "0.1.0",
            "api_version": 1, "token_kind": "ila", "actions": ["read", "trash"],
            "roots": [], "capabilities": capabilities
        })
        .to_string()
        .into_bytes()
    }

    pub(super) async fn server(
        responses: Vec<(&'static str, Vec<u8>)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 1024];
                    let count = socket.read(&mut buf).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buf[..count]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let header_end = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .unwrap()
                    + 4;
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while request.len() < header_end + content_length {
                    let mut buf = [0; 1024];
                    let count = socket.read(&mut buf).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buf[..count]);
                }
                requests.push(String::from_utf8(request).unwrap());
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            }
            requests
        });
        (format!("http://{addr}"), task)
    }

    #[tokio::test]
    async fn downloads_verified_group_with_collision_safe_names() {
        let original = b"original";
        let sidecar = b"sidecar";
        let (url, requests) = server(vec![
            ("200 OK", manifest(original, sidecar).into_bytes()),
            ("200 OK", original.to_vec()),
            ("200 OK", sidecar.to_vec()),
        ])
        .await;
        let dir = TestDir::new();
        fs::write(dir.0.join("example.CR3.xmp"), b"existing").unwrap();
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        let mut progress = Vec::new();
        let group = client
            .download_group("asset-1", &dir.0, |done, total| {
                progress.push((done, total))
            })
            .await
            .unwrap();
        assert_eq!(fs::read(dir.0.join("example (1).CR3")).unwrap(), original);
        assert_eq!(
            fs::read(dir.0.join("example (1).CR3.xmp")).unwrap(),
            sidecar
        );
        assert_eq!(
            fs::read(dir.0.join("example.CR3.xmp")).unwrap(),
            b"existing"
        );
        assert_eq!(group.files.len(), 2);
        assert_eq!(progress.last(), Some(&(15, 15)));
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 3);
        let requests = requests.await.unwrap();
        assert!(requests.iter().all(|request| request
            .to_ascii_lowercase()
            .contains("authorization: bearer ism_test_token")));
        assert!(requests[1].contains("revision=rev-1"));
    }

    #[tokio::test]
    async fn hash_mismatch_publishes_nothing() {
        let (url, requests) = server(vec![
            ("200 OK", manifest(b"original", b"sidecar").into_bytes()),
            ("200 OK", b"original".to_vec()),
            ("200 OK", b"changed".to_vec()),
        ])
        .await;
        let dir = TestDir::new();
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        assert!(client
            .download_group("asset-1", &dir.0, |_, _| {})
            .await
            .err()
            .unwrap()
            .contains("does not match"));
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
        requests.await.unwrap();
    }

    #[tokio::test]
    async fn revision_change_restarts_with_a_fresh_manifest() {
        let (url, requests) = server(vec![
            ("200 OK", manifest(b"before", b"sidecar").into_bytes()),
            ("412 Precondition Failed", Vec::new()),
            ("200 OK", manifest(b"after", b"sidecar").into_bytes()),
            ("200 OK", b"after".to_vec()),
            ("200 OK", b"sidecar".to_vec()),
        ])
        .await;
        let dir = TestDir::new();
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        client
            .download_group("asset-1", &dir.0, |_, _| {})
            .await
            .unwrap();
        assert_eq!(fs::read(dir.0.join("example.CR3")).unwrap(), b"after");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
        requests.await.unwrap();
    }

    #[tokio::test]
    async fn local_deletion_uses_fresh_manifest_and_waits_for_ism_completion() {
        let original = b"original";
        let sidecar = b"sidecar";
        let (url, requests) = server(vec![
            ("200 OK", manifest(original, sidecar).into_bytes()),
            ("200 OK", client_info(&["trash_if_asset_matches"])),
            (
                "202 Accepted",
                br#"{"operation_id":"op-1","status":"queued"}"#.to_vec(),
            ),
            (
                "200 OK",
                br#"{"operation_id":"op-1","status":"completed","items":[]}"#.to_vec(),
            ),
        ])
        .await;
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        let (location, revision) = client.asset_original("asset-1").await.unwrap();
        client
            .trash_asset_at(
                &location.root_id,
                &location.path,
                "asset-1",
                "ila-local-deletion:42",
                None,
                Some(&revision),
            )
            .await
            .unwrap();
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("GET /api/v1/assets/asset-1/manifest "));
        assert!(requests[1].starts_with("GET /api/v1/client/info "));
        assert!(requests[2].starts_with("POST /api/v1/operations "));
        let body: serde_json::Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["idempotency_key"], "ila-local-deletion:42");
        assert_eq!(body["actions"][0]["kind"], "trash_if_asset_matches");
        assert_eq!(body["actions"][0]["expected_asset_id"], "asset-1");
        assert_eq!(body["actions"][0]["expected_revision"], revision.as_str());
        assert_eq!(body["actions"][0]["source"]["root_id"], "photos");
        assert_eq!(body["actions"][0]["source"]["path"], "2025/example.CR3");
        assert!(requests[3].starts_with("GET /api/v1/operations/op-1 "));
    }

    #[tokio::test]
    async fn local_deletion_retry_reuses_persisted_request_after_maintenance_refusal() {
        let (url, requests) = server(vec![
            ("200 OK", manifest(b"original", b"sidecar").into_bytes()),
            ("200 OK", client_info(&["trash_if_asset_matches"])),
            (
                "409 Conflict",
                br#"{"error":{"code":"maintenance_blocked","message":"watcher state unverified"}}"#
                    .to_vec(),
            ),
            ("200 OK", client_info(&["trash_if_asset_matches"])),
            (
                "202 Accepted",
                br#"{"operation_id":"op-1","status":"queued"}"#.to_vec(),
            ),
            (
                "200 OK",
                br#"{"operation_id":"op-1","status":"completed","items":[]}"#.to_vec(),
            ),
        ])
        .await;
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.open()
            .unwrap()
            .execute(
                "INSERT INTO local_saved_asset_changes
                 (id, asset_id, local_path, file_name, change_kind, details_json)
                 VALUES (43, 'asset-1', '/photos/example.CR3', 'example.CR3', 'deleted', '{}')",
                [],
            )
            .unwrap();
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        let (location, _) = client.asset_original("asset-1").await.unwrap();
        let saved = db
            .record_ism_deletion_request(
                43,
                "asset-1",
                "https://immich.example",
                &location,
                None,
                None,
            )
            .unwrap();
        let error = client
            .trash_asset_at(
                &saved.0,
                &saved.1,
                "asset-1",
                "ila-local-deletion:43",
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("ISM maintenance_blocked"));
        assert!(error.contains("watcher state unverified"));
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/example.CR3",
            "example.CR3",
            "deleted",
            r#"{"message":"still missing"}"#,
        )
        .unwrap();
        let changes = db.list_unresolved_local_saved_asset_changes().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].id, 43);
        assert!(changes[0].details_json.contains("still missing"));
        let saved_retry = db
            .ism_deletion_request(43, "asset-1", "https://immich.example")
            .unwrap()
            .unwrap();
        client
            .trash_asset_at(
                &saved_retry.0,
                &saved_retry.1,
                "asset-1",
                "ila-local-deletion:43",
                None,
                None,
            )
            .await
            .unwrap();
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests[0].starts_with("GET /api/v1/assets/asset-1/manifest "));
        assert!(requests[2].starts_with("POST /api/v1/operations "));
        assert!(requests[4].starts_with("POST /api/v1/operations "));
        let first_body: serde_json::Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        let retry_body: serde_json::Value =
            serde_json::from_str(requests[4].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(first_body, retry_body);
        assert!(requests[5].starts_with("GET /api/v1/operations/op-1 "));
        db.resolve_ism_deletion(43).unwrap();
        assert!(db
            .ism_deletion_request(43, "asset-1", "https://immich.example")
            .unwrap()
            .is_none());
        assert!(db
            .list_unresolved_local_saved_asset_changes()
            .unwrap()
            .is_empty());
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/example.CR3",
            "example.CR3",
            "deleted",
            "{}",
        )
        .unwrap();
        let next = db.list_unresolved_local_saved_asset_changes().unwrap();
        assert_eq!(next.len(), 1);
        assert_ne!(next[0].id, 43);
        assert!(db
            .ism_deletion_request(next[0].id, "asset-1", "https://immich.example")
            .unwrap()
            .is_none());
    }

    #[test]
    fn deletion_requests_keep_the_synced_revision_and_legacy_rows_have_none() {
        let dir = TestDir::new();
        let path = dir.0.join("db.sqlite");
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE ism_local_deletion_requests (
                    change_id INTEGER PRIMARY KEY, asset_id TEXT NOT NULL, server_url TEXT NOT NULL,
                    root_id TEXT NOT NULL, remote_path TEXT NOT NULL);
                 INSERT INTO ism_local_deletion_requests
                 VALUES (7, 'asset-0', 'https://immich.example', 'photos', 'old.jpg');",
            )
            .unwrap();
        let db = Database::test_database(path).unwrap();
        assert_eq!(db.ism_deletion_revision(7).unwrap(), None);
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/example.jpg",
            "example.jpg",
            "deleted",
            "{}",
        )
        .unwrap();
        let change_id = db.list_unresolved_local_saved_asset_changes().unwrap()[0].id;
        db.record_ism_deletion_request(
            change_id,
            "asset-1",
            "https://immich.example",
            &Location {
                root_id: "photos".to_string(),
                path: "example.jpg".to_string(),
            },
            None,
            Some("rev-1"),
        )
        .unwrap();
        assert_eq!(
            db.ism_deletion_revision(change_id).unwrap().as_deref(),
            Some("rev-1")
        );
    }

    #[test]
    fn reappearing_file_keeps_unconfirmed_ism_deletion_notice() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.upsert_local_saved_asset(
            "asset-1",
            Some("album-1"),
            "/photos/example.jpg",
            "example.jpg",
            "download",
            None,
            None,
        )
        .unwrap();
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/example.jpg",
            "example.jpg",
            "deleted",
            "{}",
        )
        .unwrap();
        let change_id = db.list_unresolved_local_saved_asset_changes().unwrap()[0].id;
        db.record_ism_deletion_request(
            change_id,
            "asset-1",
            "https://immich.example",
            &Location {
                root_id: "photos".to_string(),
                path: "example.jpg".to_string(),
            },
            None,
            None,
        )
        .unwrap();

        assert!(db.ism_guards_local_changes("asset-1").unwrap());
        assert!(db.dismiss_local_saved_deletion(change_id).is_err());
        assert_eq!(
            db.list_local_saved_asset_paths_for_asset("asset-1")
                .unwrap(),
            vec!["/photos/example.jpg".to_string()]
        );
        db.delete_unresolved_local_saved_asset_changes_for_album("album-1")
            .unwrap();
        db.resolve_unresolved_local_saved_asset_change("asset-1", "/photos/example.jpg", "deleted")
            .unwrap();
        db.resolve_local_saved_asset_changes_by_ids(&[change_id])
            .unwrap();

        let pending = db.list_unresolved_local_saved_asset_changes().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, change_id);
        assert!(db
            .ism_deletion_request(change_id, "asset-1", "https://immich.example")
            .unwrap()
            .is_some());
    }

    #[test]
    fn dismissed_notice_cannot_start_a_late_ism_deletion() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/example.jpg",
            "example.jpg",
            "deleted",
            "{}",
        )
        .unwrap();
        let change_id = db.list_unresolved_local_saved_asset_changes().unwrap()[0].id;
        assert!(db.dismiss_local_saved_deletion(change_id).unwrap());
        assert!(db
            .record_ism_deletion_request(
                change_id,
                "asset-1",
                "https://immich.example",
                &Location {
                    root_id: "photos".to_string(),
                    path: "example.jpg".to_string()
                },
                None,
                None
            )
            .is_err());
        assert!(db
            .ism_deletion_request(change_id, "asset-1", "https://immich.example")
            .unwrap()
            .is_none());
    }

    #[test]
    fn startup_recovers_previously_hidden_ism_deletion_notice() {
        let dir = TestDir::new();
        let path = dir.0.join("db.sqlite");
        let db = Database::test_database(path.clone()).unwrap();
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/example.jpg",
            "example.jpg",
            "deleted",
            "{}",
        )
        .unwrap();
        let change_id = db.list_unresolved_local_saved_asset_changes().unwrap()[0].id;
        db.record_ism_deletion_request(
            change_id,
            "asset-1",
            "https://immich.example",
            &Location {
                root_id: "photos".to_string(),
                path: "example.jpg".to_string(),
            },
            None,
            None,
        )
        .unwrap();
        db.open()
            .unwrap()
            .execute(
                "UPDATE local_saved_asset_changes SET resolved_at = '2025-01-01' WHERE id = ?1",
                [change_id],
            )
            .unwrap();
        drop(db);

        let reopened = Database::test_database(path).unwrap();
        assert_eq!(
            reopened
                .list_unresolved_local_saved_asset_changes()
                .unwrap()[0]
                .id,
            change_id
        );
    }

    #[tokio::test]
    async fn local_deletion_rejects_invalid_persisted_paths_before_network_io() {
        let client = IsmClient::new("http://127.0.0.1:1", "ism_test_token").unwrap();
        let error = client
            .trash_asset_at(
                "photos",
                "../escape.jpg",
                "asset-1",
                "ila-local-deletion:44",
                None,
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error, "ISM deletion location is invalid");
    }

    #[tokio::test]
    async fn local_deletion_refuses_older_server_without_identity_capability() {
        let mut old_info: serde_json::Value = serde_json::from_slice(&client_info(&[])).unwrap();
        old_info.as_object_mut().unwrap().remove("capabilities");
        let (url, requests) = server(vec![("200 OK", old_info.to_string().into_bytes())]).await;
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        let error = client
            .trash_asset_at(
                "photos",
                "2025/a.jpg",
                "asset-1",
                "ila-local-deletion:45",
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("cannot verify the asset identity"));
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /api/v1/client/info "));
    }

    #[tokio::test]
    async fn cancellation_is_bound_to_the_original_request_and_server() {
        let caps = [
            "trash_if_asset_matches",
            "cancel_operation_by_key",
            "instance_scoped_operations",
        ];
        let (url, requests) = server(vec![
            ("200 OK", client_info(&caps)),
            (
                "200 OK",
                br#"{"status":"cancelled_before_submission"}"#.to_vec(),
            ),
        ])
        .await;
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        let info: ClientInfo = serde_json::from_slice(&client_info(&caps)).unwrap();
        let binding = client.deletion_binding(&info).unwrap();
        client
            .cancel_deletion(&binding, "photos", "a.jpg", "asset-1", None)
            .await
            .unwrap();
        let requests = requests.await.unwrap();
        assert!(
            requests[1].starts_with("POST /api/v1/instances/ism-test/operations/cancel-by-key ")
        );
        let body: serde_json::Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["idempotency_key"], binding.request_key());
        assert_eq!(
            body["expected_request"]["actions"][0]["expected_asset_id"],
            "asset-1"
        );
        assert!(body["expected_request"]["actions"][0]
            .get("expected_revision")
            .is_none());
    }

    #[test]
    fn deletion_request_keys_are_unique_across_local_databases_and_persisted() {
        let caps = [
            "trash_if_asset_matches",
            "cancel_operation_by_key",
            "instance_scoped_operations",
        ];
        let client = IsmClient::new("https://sync.example", "ism_test_token").unwrap();
        let info: ClientInfo = serde_json::from_slice(&client_info(&caps)).unwrap();
        let first = client.deletion_binding(&info).unwrap();
        let second = client.deletion_binding(&info).unwrap();
        assert_ne!(first.request_key(), second.request_key());
        let dir = TestDir::new();
        let db_path = dir.0.join("db.sqlite");
        let db = Database::test_database(db_path.clone()).unwrap();
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/a.jpg",
            "a.jpg",
            "deleted",
            "{}",
        )
        .unwrap();
        let id = db.list_unresolved_local_saved_asset_changes().unwrap()[0].id;
        db.record_ism_deletion_request(
            id,
            "asset-1",
            "https://immich.example",
            &Location {
                root_id: "photos".to_string(),
                path: "a.jpg".to_string(),
            },
            Some(&first),
            None,
        )
        .unwrap();
        drop(db);
        let reopened = Database::test_database(db_path).unwrap();
        assert_eq!(reopened.ism_deletion_binding(id).unwrap().unwrap(), first);
    }

    #[test]
    fn legacy_bound_request_keeps_its_original_numeric_key_after_migration() {
        let caps = [
            "trash_if_asset_matches",
            "cancel_operation_by_key",
            "instance_scoped_operations",
        ];
        let client = IsmClient::new("https://sync.example", "ism_test_token").unwrap();
        let info: ClientInfo = serde_json::from_slice(&client_info(&caps)).unwrap();
        let binding = client.deletion_binding(&info).unwrap();
        let dir = TestDir::new();
        let path = dir.0.join("db.sqlite");
        let db = Database::test_database(path.clone()).unwrap();
        db.upsert_unresolved_local_saved_asset_change(
            "asset-1",
            "/photos/a.jpg",
            "a.jpg",
            "deleted",
            "{}",
        )
        .unwrap();
        let id = db.list_unresolved_local_saved_asset_changes().unwrap()[0].id;
        db.record_ism_deletion_request(
            id,
            "asset-1",
            "https://immich.example",
            &Location {
                root_id: "photos".to_string(),
                path: "a.jpg".to_string(),
            },
            Some(&binding),
            None,
        )
        .unwrap();
        db.open()
            .unwrap()
            .execute(
                "ALTER TABLE ism_local_deletion_bindings DROP COLUMN request_key",
                [],
            )
            .unwrap();
        drop(db);
        let reopened = Database::test_database(path).unwrap();
        assert_eq!(
            reopened
                .ism_deletion_binding(id)
                .unwrap()
                .unwrap()
                .request_key(),
            format!("ila-local-deletion:{id}")
        );
    }

    #[tokio::test]
    async fn cancellation_refuses_changed_credentials_or_completed_operations() {
        let caps = [
            "trash_if_asset_matches",
            "cancel_operation_by_key",
            "instance_scoped_operations",
        ];
        let (url, requests) = server(vec![
            ("200 OK", client_info(&caps)),
            ("200 OK", client_info(&caps)),
            ("200 OK", br#"{"status":"operation","operation":{"status":"completed","items":[{"kind":"trash_if_asset_matches","status":"done"}]}}"#.to_vec()),
        ]).await;
        let original = IsmClient::new(&url, "ism_test_token").unwrap();
        let info: ClientInfo = serde_json::from_slice(&client_info(&caps)).unwrap();
        let binding = original.deletion_binding(&info).unwrap();
        let changed = IsmClient::new(&url, "other_test_token").unwrap();
        assert!(changed
            .cancel_deletion(&binding, "photos", "a.jpg", "asset-1", None)
            .await
            .unwrap_err()
            .contains("credential changed"));
        assert!(original
            .cancel_deletion(&binding, "photos", "a.jpg", "asset-1", None)
            .await
            .unwrap_err()
            .contains("completed"));
        assert_eq!(requests.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn cancellation_accepts_only_a_single_skipped_trash_item() {
        let caps = [
            "trash_if_asset_matches",
            "cancel_operation_by_key",
            "instance_scoped_operations",
        ];
        let (url, requests) = server(vec![
            ("200 OK", client_info(&caps)),
            ("200 OK", br#"{"status":"operation","operation":{"status":"cancelled","items":[{"kind":"trash_if_asset_matches","status":"skipped"}]}}"#.to_vec()),
        ]).await;
        let client = IsmClient::new(&url, "ism_test_token").unwrap();
        let info: ClientInfo = serde_json::from_slice(&client_info(&caps)).unwrap();
        let binding = client.deletion_binding(&info).unwrap();
        client
            .cancel_deletion(&binding, "photos", "a.jpg", "asset-1", None)
            .await
            .unwrap();
        assert_eq!(requests.await.unwrap().len(), 2);
    }

    #[test]
    fn rejects_manifest_with_traversal_or_wrong_asset() {
        let mut value: Manifest = serde_json::from_str(&manifest(b"a", b"b")).unwrap();
        value.files[1].name = "../escape.xmp".into();
        assert!(validate_manifest(&value, Some("asset-1")).is_err());
        let value: Manifest = serde_json::from_str(&manifest(b"a", b"b")).unwrap();
        assert!(validate_manifest(&value, Some("different-asset")).is_err());
    }

    #[test]
    fn provider_and_group_provenance_are_persisted_atomically() {
        let dir = TestDir::new();
        let db = Database::test_database(dir.0.join("db.sqlite")).unwrap();
        db.save_ism_provider(
            "https://immich.example/",
            &Provider {
                base_url: "https://sync.example/".into(),
                client_token: "fixture-token".into(),
            },
        )
        .unwrap();
        let provider = db.ism_provider("https://immich.example").unwrap().unwrap();
        assert_eq!(provider.base_url, "https://sync.example/");
        assert_eq!(provider.client_token, "fixture-token");
        let manifest: Manifest = serde_json::from_str(&manifest(b"a", b"b")).unwrap();
        let first = dir.0.join("example.CR3");
        let second = dir.0.join("example.CR3.xmp");
        fs::write(&first, b"a").unwrap();
        fs::write(&second, b"b").unwrap();
        let group = DownloadedGroup {
            files: vec![
                DownloadedFile {
                    manifest_file: manifest.files[0].clone(),
                    local_path: first.clone(),
                },
                DownloadedFile {
                    manifest_file: manifest.files[1].clone(),
                    local_path: second.clone(),
                },
            ],
            manifest: manifest.clone(),
        };
        db.record_ism_download(
            "asset-1",
            "https://immich.example",
            &group,
            None,
            "explorer_copy",
        )
        .unwrap();
        db.record_ism_download(
            "asset-1",
            "https://immich.example",
            &group,
            None,
            "explorer_copy",
        )
        .unwrap();
        let other = dir.0.join("other.CR3");
        fs::write(&other, b"a").unwrap();
        let conflicting = DownloadedGroup {
            files: vec![
                DownloadedFile {
                    manifest_file: manifest.files[0].clone(),
                    local_path: other,
                },
                DownloadedFile {
                    manifest_file: manifest.files[1].clone(),
                    local_path: second,
                },
            ],
            manifest,
        };
        assert!(db
            .record_ism_download(
                "asset-2",
                "https://immich.example",
                &conflicting,
                None,
                "explorer_copy"
            )
            .is_err());
        let conn = db.open().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ism_local_files WHERE asset_id = 'asset-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let saved: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_saved_assets WHERE asset_id = 'asset-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((count, saved), (0, 0));
        assert_eq!(
            db.list_local_saved_asset_paths_for_asset("asset-1")
                .unwrap(),
            vec![first.to_string_lossy().to_string()]
        );
        db.remove_ism_provider("https://immich.example/").unwrap();
        assert!(db.ism_provider("https://immich.example").unwrap().is_none());
    }
}
