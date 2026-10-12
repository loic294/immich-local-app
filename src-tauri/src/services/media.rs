use crate::services::{db::Database, immich_client::ImmichClient};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct MediaPreferences {
    pub editor_executable: String,
    pub editor_export_args: Vec<String>,
    pub editor_sidecars: Vec<String>,
    pub import_requires_album: bool,
    pub telemetry_enabled: bool,
    pub session_replay_enabled: bool,
}

impl Default for MediaPreferences {
    fn default() -> Self {
        Self {
            editor_executable: if cfg!(target_os = "macos") {
                "/Applications/RapidRAW.app/Contents/MacOS/RapidRAW".into()
            } else {
                "RapidRAW.exe".into()
            },
            editor_export_args: vec![
                "export".into(),
                "{input}".into(),
                "--output".into(),
                "{output}".into(),
                "--format".into(),
                "jpeg".into(),
                "--quality".into(),
                "100".into(),
                "--keep-metadata".into(),
            ],
            editor_sidecars: vec!["rrdata".into(), "xml".into(), "xmp".into()],
            import_requires_album: true,
            telemetry_enabled: true,
            session_replay_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadJob {
    pub id: String,
    pub account_id: String,
    pub local_path: String,
    pub checksum: String,
    pub album_ids: Vec<String>,
    pub original_asset_id: Option<String>,
    pub server_asset_id: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorJob {
    pub asset_id: String,
    pub local_path: String,
    pub snapshot: String,
}

fn jpeg_metadata_app1(payload: &[u8]) -> bool {
    payload.starts_with(b"Exif\0\0")
        || payload.starts_with(b"http://ns.adobe.com/xap/1.0/\0")
        || payload.starts_with(b"http://ns.adobe.com/xmp/extension/\0")
}

fn jpeg_app1_segments(bytes: &[u8]) -> Result<Vec<(usize, usize)>, String> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] {
        return Err("JPEG data has no SOI marker".into());
    }
    let mut segments = Vec::new();
    let mut offset = 2;
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            return Err("Invalid JPEG marker sequence".into());
        }
        let start = offset;
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset).ok_or("Truncated JPEG marker")?;
        offset += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length_bytes = bytes.get(offset..offset + 2).ok_or("Truncated JPEG segment")?;
        let length = u16::from_be_bytes([length_bytes[0], length_bytes[1]]) as usize;
        if length < 2 {
            return Err("Invalid JPEG segment length".into());
        }
        let end = offset.checked_add(length).ok_or("Invalid JPEG segment length")?;
        if end > bytes.len() {
            return Err("Truncated JPEG segment data".into());
        }
        let payload = &bytes[offset + 2..end];
        if marker == 0xe1 && jpeg_metadata_app1(payload) {
            segments.push((start, end));
        }
        offset = end;
    }
    Ok(segments)
}

fn copy_jpeg_metadata_bytes(source: &[u8], destination: &[u8]) -> Result<Vec<u8>, String> {
    let source_segments = jpeg_app1_segments(source)?;
    let destination_segments = jpeg_app1_segments(destination)?;
    let mut output = Vec::with_capacity(destination.len() + source.len());
    output.extend_from_slice(&destination[..2]);
    for (start, end) in source_segments {
        output.extend_from_slice(&source[start..end]);
    }
    let mut cursor = 2;
    for (start, end) in destination_segments {
        output.extend_from_slice(&destination[cursor..start]);
        cursor = end;
    }
    output.extend_from_slice(&destination[cursor..]);
    Ok(output)
}

/// Replaces exported JPEG EXIF/XMP APP1 blocks with the corresponding blocks
/// from the original, preserving date, GPS, camera, and other embedded tags.
pub fn copy_jpeg_metadata(source: &Path, destination: &Path) -> Result<(), String> {
    let source_bytes = std::fs::read(source).map_err(|error| error.to_string())?;
    let destination_bytes = std::fs::read(destination).map_err(|error| error.to_string())?;
    let output = copy_jpeg_metadata_bytes(&source_bytes, &destination_bytes)?;
    std::fs::write(destination, output).map_err(|error| error.to_string())
}

impl Database {
    pub fn init_media(&self) -> Result<(), String> {
        self.open()?
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS media_uploads (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL, local_path TEXT NOT NULL,
                checksum TEXT NOT NULL, album_ids TEXT NOT NULL, original_asset_id TEXT,
                server_asset_id TEXT, state TEXT NOT NULL DEFAULT 'queued', error TEXT,
                completed_at TEXT, UNIQUE(account_id, checksum)
             );
             CREATE TABLE IF NOT EXISTS editor_jobs (
                asset_id TEXT PRIMARY KEY, local_path TEXT NOT NULL, snapshot TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS edit_versions (
                asset_id TEXT PRIMARY KEY, original_asset_id TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS import_hashes (
                path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime TEXT NOT NULL,
                checksum TEXT NOT NULL
             );",
            )
            .map_err(|e| format!("[media:db] initialization failed: {e}"))
    }

    pub fn media_preferences(&self) -> Result<MediaPreferences, String> {
        let text: Option<String> = self
            .open()?
            .query_row(
                "SELECT value FROM settings WHERE key='media_preferences'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match text {
            Some(text) => {
                serde_json::from_str(&text).map_err(|e| format!("Invalid media preferences: {e}"))
            }
            None => Ok(MediaPreferences::default()),
        }
    }

    pub fn save_media_preferences(&self, value: &MediaPreferences) -> Result<(), String> {
        self.open()?
            .execute(
                "INSERT INTO settings(key,value) VALUES('media_preferences',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [serde_json::to_string(value).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn media_uploads(&self) -> Result<Vec<UploadJob>, String> {
        self.init_media()?;
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT id,account_id,local_path,checksum,album_ids,original_asset_id,
                    server_asset_id,state,error FROM media_uploads WHERE completed_at IS NULL
             ORDER BY rowid",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let albums: String = row.get(4)?;
                let album_ids = serde_json::from_str(&albums).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(UploadJob {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    local_path: row.get(2)?,
                    checksum: row.get(3)?,
                    album_ids,
                    original_asset_id: row.get(5)?,
                    server_asset_id: row.get(6)?,
                    state: row.get(7)?,
                    error: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn set_media_upload_state(
        &self,
        id: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        if !["queued", "uploading", "failed"].contains(&state) {
            return Err("Invalid pending upload state".into());
        }
        self.init_media()?;
        self.open()?
            .execute(
                "UPDATE media_uploads SET state=?1,error=?2 WHERE id=?3 AND completed_at IS NULL",
                params![state, error, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // Only called while holding the processor lock: an uploading row here was interrupted.
    pub fn recover_media_uploads(&self) -> Result<(), String> {
        self.init_media()?;
        let count = self.open()?.execute("UPDATE media_uploads SET state='queued',error=NULL WHERE state='uploading' AND completed_at IS NULL", [])
            .map_err(|e| e.to_string())?;
        if count > 0 {
            log::warn!("[media:upload] recovered interrupted jobs count={count}");
        }
        Ok(())
    }

    pub fn known_media_hash(&self, account: &str, checksum: &str) -> Result<bool, String> {
        self.init_media()?;
        self.open()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM media_uploads WHERE account_id=?1 AND checksum=?2
              UNION ALL SELECT 1 FROM assets WHERE account_id=?1 AND checksum=?2)",
                params![account, checksum],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn cached_import_hash(&self, path: &Path) -> Result<String, String> {
        self.init_media()?;
        let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
        let modified = metadata.modified().map_err(|error| error.to_string())?;
        let modified = format!("{modified:?}");
        let path_text = path.to_string_lossy();
        let cached: Option<String> = self
            .open()?
            .query_row(
                "SELECT checksum FROM import_hashes WHERE path=?1 AND size=?2 AND mtime=?3",
                params![path_text, metadata.len() as i64, modified],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(cached) = cached {
            return Ok(cached);
        }
        let checksum = file_hash(path)?;
        self.open()?.execute(
            "INSERT INTO import_hashes(path,size,mtime,checksum) VALUES(?1,?2,?3,?4)
             ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,checksum=excluded.checksum",
            params![path_text, metadata.len() as i64, modified, checksum],
        ).map_err(|error| error.to_string())?;
        Ok(checksum)
    }

    pub fn queue_media(&self, job: &UploadJob) -> Result<(), String> {
        self.init_media()?;
        self.open()?.execute(
            "INSERT INTO media_uploads(id,account_id,local_path,checksum,album_ids,original_asset_id)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![job.id,job.account_id,job.local_path,job.checksum,
                serde_json::to_string(&job.album_ids).map_err(|e|e.to_string())?,job.original_asset_id],
        ).map_err(|e| format!("Could not queue retained original: {e}"))?;
        Ok(())
    }

    pub fn editor_jobs(&self) -> Result<Vec<EditorJob>, String> {
        self.init_media()?;
        let conn = self.open()?;
        let mut stmt = conn
            .prepare("SELECT asset_id,local_path,snapshot FROM editor_jobs")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(EditorJob {
                    asset_id: r.get(0)?,
                    local_path: r.get(1)?,
                    snapshot: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn save_editor_job(&self, job: &EditorJob) -> Result<(), String> {
        self.init_media()?;
        self.open()?.execute(
            "INSERT INTO editor_jobs(asset_id,local_path,snapshot) VALUES(?1,?2,?3)
             ON CONFLICT(asset_id) DO UPDATE SET local_path=excluded.local_path,snapshot=excluded.snapshot",
            params![job.asset_id, job.local_path, job.snapshot],
        ).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn original_edit_asset(&self, id: &str) -> Result<String, String> {
        self.init_media()?;
        let original: Option<String> = self
            .open()?
            .query_row(
                "SELECT original_asset_id FROM edit_versions WHERE asset_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(original.unwrap_or_else(|| id.to_string()))
    }

    pub fn is_deletable_edit_version(&self, asset_id: &str) -> Result<bool, String> {
        self.init_media()?;
        let conn = self.open()?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM edit_versions ev JOIN assets a ON a.id=ev.asset_id
             WHERE ev.asset_id=?1 AND ev.asset_id<>ev.original_asset_id)",
            [asset_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| error.to_string())
    }

    pub fn remove_edit_version_from_cache(
        &self,
        asset_id: &str,
        queued_account: Option<&str>,
    ) -> Result<(), String> {
        self.init_media()?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let (original, secondary, account): (String, bool, String) = tx
            .query_row(
                "SELECT ev.original_asset_id,COALESCE(a.is_stack_secondary,0),a.account_id
                 FROM edit_versions ev JOIN assets a ON a.id=ev.asset_id
                 WHERE ev.asset_id=?1 AND ev.asset_id<>ev.original_asset_id",
                [asset_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or("Only an edited version can be deleted; the original is protected")?;
        if !secondary {
            let restored = tx
                .execute(
                    "UPDATE assets SET is_stack_secondary=0 WHERE id=?1",
                    [&original],
                )
                .map_err(|error| error.to_string())?;
            if restored != 1 {
                return Err("Cannot restore the missing original version".into());
            }
            tx.execute(
                "INSERT OR IGNORE INTO album_assets(album_id,asset_id,account_id)
                 SELECT album_id,?1,account_id FROM album_assets WHERE asset_id=?2",
                params![original, asset_id],
            )
            .map_err(|error| error.to_string())?;
        }
        if let Some(queued_account) = queued_account {
            if queued_account != account {
                return Err("Cannot queue deletion for a different account".into());
            }
            let payload = serde_json::json!({ "originalAssetId": original }).to_string();
            tx.execute(
                "INSERT INTO pending_mutations(asset_id,account_id,kind,payload_json,created_at)
                 VALUES(?1,?2,'delete_version',?3,?4)",
                params![asset_id, account, payload, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.execute("DELETE FROM edit_versions WHERE asset_id=?1", [asset_id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM asset_people WHERE asset_id=?1", [asset_id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM album_assets WHERE asset_id=?1", [asset_id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM assets WHERE id=?1", [asset_id])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        log::info!(
            "[media:version-delete] removed cached edit={asset_id} original={original} restored={} queued={}",
            !secondary,
            queued_account.is_some()
        );
        Ok(())
    }

    pub fn edit_version_ids(&self, original: &str) -> Result<Vec<String>, String> {
        self.init_media()?;
        let conn = self.open()?;
        let mut stmt=conn.prepare("SELECT asset_id FROM edit_versions WHERE original_asset_id=?1 ORDER BY created_at DESC")
            .map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([original], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn record_edit_stack(
        &self,
        original: &str,
        primary: &str,
        ids: &[String],
    ) -> Result<(), String> {
        self.init_media()?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in ids {
            if id != original {
                tx.execute(
                    "INSERT INTO edit_versions(asset_id,original_asset_id,created_at) VALUES(?1,?2,?3)
                     ON CONFLICT(asset_id) DO UPDATE SET original_asset_id=excluded.original_asset_id",
                    params![id, original, chrono::Utc::now().to_rfc3339()],
                ).map_err(|e| e.to_string())?;
            }
            tx.execute(
                "UPDATE assets SET is_stack_secondary=?2 WHERE id=?1",
                params![id, id != primary],
            )
            .map_err(|e| e.to_string())?;
        }
        // Keep the primary in every album, including ones discovered after export was queued.
        tx.execute(
            "INSERT OR IGNORE INTO album_assets(album_id,asset_id,account_id)
             SELECT DISTINCT aa.album_id,?1,aa.account_id FROM album_assets aa
             WHERE aa.asset_id=?2 OR aa.asset_id IN
                (SELECT asset_id FROM edit_versions WHERE original_asset_id=?2)",
            params![primary, original],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        log::info!(
            "[media:stack] persisted primary={primary} members={}",
            ids.len()
        );
        Ok(())
    }

    pub fn sync_asset_stack(
        &self,
        account: &str,
        stack: &crate::services::immich_client::AssetStack,
    ) -> Result<(), String> {
        if !stack
            .assets
            .iter()
            .any(|asset| asset.id == stack.primary_asset_id)
        {
            return Err(format!(
                "Stack primary {} is missing from its members",
                stack.primary_asset_id
            ));
        }
        // A server refresh can race offline replay. Do not resurrect queued
        // deletions or let their old server primary hide the local fallback.
        let pending = self.list_pending_mutations()?;
        let deletions: Vec<_> = pending
            .iter()
            .filter(|mutation| mutation.account_id == account && mutation.kind == "delete_version")
            .collect();
        let assets: Vec<_> = stack
            .assets
            .iter()
            .filter(|asset| !deletions.iter().any(|mutation| mutation.asset_id == asset.id))
            .cloned()
            .collect();
        if assets.len() != stack.assets.len() {
            log::info!(
                "[media:stack] suppressing queued deletions account={account} count={}",
                stack.assets.len() - assets.len()
            );
        }
        let mut candidates = assets.clone();
        candidates.sort_by_key(|asset| {
            (
                asset.original_file_name.contains("-edited-"),
                asset.file_created_at.clone().unwrap_or_default(),
                asset.id.clone(),
            )
        });
        let mut original = candidates.first().ok_or("Stack has no assets")?.id.clone();
        for mutation in &deletions {
            if stack.assets.iter().any(|asset| asset.id == mutation.asset_id) {
                let payload: serde_json::Value =
                    serde_json::from_str(&mutation.payload_json).map_err(|error| error.to_string())?;
                if let Some(root) = payload
                    .get("originalAssetId")
                    .and_then(serde_json::Value::as_str)
                {
                    if assets.iter().any(|asset| asset.id == root) {
                        original = root.to_string();
                        break;
                    }
                }
            }
        }
        for asset in &assets {
            let known = self.original_edit_asset(&asset.id)?;
            if known != asset.id && assets.iter().any(|asset| asset.id == known) {
                original = known;
                break;
            }
        }
        let primary = if assets.iter().any(|asset| asset.id == stack.primary_asset_id) {
            &stack.primary_asset_id
        } else {
            &original
        };
        self.upsert_assets(account, &assets)?;
        self.record_edit_stack(
            &original,
            primary,
            &assets
                .iter()
                .map(|asset| asset.id.clone())
                .collect::<Vec<_>>(),
        )
    }

    pub fn media_album_ids(&self, asset: &str) -> Result<Vec<String>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare("SELECT album_id FROM album_assets WHERE asset_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([asset], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

pub fn file_hash(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut hash = Sha1::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(STANDARD.encode(hash.finalize()))
}

impl ImmichClient {
    pub async fn upload_retained_media(
        &self,
        path: &Path,
        checksum: &str,
        captured_at: Option<&str>,
        sidecar: Option<&Path>,
    ) -> Result<String, String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or("Not authenticated")?;
        if !self.ping(&session.server_url).await {
            return Err("offline: upload retained locally".into());
        }
        let metadata = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
        let modified = metadata.modified().map_err(|e| e.to_string())?;
        let date = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339();
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid upload filename")?;
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| e.to_string())?;
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
        let part = reqwest::multipart::Part::stream_with_length(body, metadata.len())
            .file_name(filename.to_string());
        let mut form = reqwest::multipart::Form::new()
            .part("assetData", part)
            .text("fileCreatedAt", captured_at.unwrap_or(&date).to_string())
            .text("fileModifiedAt", date)
            .text("deviceId", "immich-local-app")
            .text("deviceAssetId", checksum.to_string());
        // Immich supports one metadata sidecar, not arbitrary editor project attachments.
        if let Some(sidecar) = sidecar {
            let data = tokio::fs::read(sidecar).await.map_err(|e| e.to_string())?;
            form = form.part(
                "sidecarData",
                reqwest::multipart::Part::bytes(data).file_name(format!("{filename}.xmp")),
            );
        }
        log::info!("[media:upload] start bytes={}", metadata.len());
        let response = self
            .client
            .post(format!(
                "{}/api/assets",
                session.server_url.trim_end_matches('/')
            ))
            .header("x-api-key", &session.access_token)
            .header("x-immich-checksum", checksum)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(3600))
            .send()
            .await
            .map_err(|e| format!("Upload request failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Immich rejected upload (HTTP {})",
                response.status().as_u16()
            ));
        }
        let value: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        value["id"]
            .as_str()
            .map(str::to_string)
            .ok_or("Immich upload response omitted asset ID".into())
    }

    pub async fn create_edit_stack(&self, ids: &[String]) -> Result<(), String> {
        // Immich POST /stacks merges existing stacks and makes the first ID primary.
        if ids.len() < 2 {
            return Err("An edited-photo stack requires at least two versions".into());
        }
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or("Not authenticated")?;
        let response = self
            .client
            .post(format!(
                "{}/api/stacks",
                session.server_url.trim_end_matches('/')
            ))
            .header("x-api-key", &session.access_token)
            .json(&serde_json::json!({"assetIds":ids}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "Immich rejected edited-photo stack (HTTP {})",
                response.status().as_u16()
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app1(payload: &[u8]) -> Vec<u8> {
        let length = (payload.len() + 2) as u16;
        let mut segment = vec![0xff, 0xe1];
        segment.extend_from_slice(&length.to_be_bytes());
        segment.extend_from_slice(payload);
        segment
    }

    #[test]
    fn export_metadata_replaces_existing_exif_and_preserves_xmp() {
        let mut source = vec![0xff, 0xd8];
        source.extend(app1(b"Exif\0\0original-camera-gps-date"));
        source.extend(app1(b"http://ns.adobe.com/xap/1.0/\0original-xmp"));
        source.extend_from_slice(&[0xff, 0xda, 0, 2, 1, 2, 0xff, 0xd9]);
        let mut destination = vec![0xff, 0xd8];
        destination.extend(app1(b"Exif\0\0stale-export-tags"));
        destination.extend_from_slice(&[0xff, 0xda, 0, 2, 3, 4, 0xff, 0xd9]);

        let result = copy_jpeg_metadata_bytes(&source, &destination).unwrap();
        assert!(result.windows(b"original-camera-gps-date".len()).any(|window| window == b"original-camera-gps-date"));
        assert!(result.windows(b"original-xmp".len()).any(|window| window == b"original-xmp"));
        assert!(!result.windows(b"stale-export-tags".len()).any(|window| window == b"stale-export-tags"));
        assert!(result.ends_with(&[0xff, 0xda, 0, 2, 3, 4, 0xff, 0xd9]));
    }

    #[test]
    fn editor_defaults_preserve_metadata() {
        let p = MediaPreferences::default();
        assert!(p.editor_export_args.contains(&"--keep-metadata".into()));
        assert!(p
            .editor_export_args
            .windows(2)
            .any(|w| w == ["--quality", "100"]));
        assert!(p.import_requires_album);
    }
    #[test]
    fn partial_preferences_are_backward_compatible() {
        let p: MediaPreferences = serde_json::from_str("{\"telemetryEnabled\":false}").unwrap();
        assert!(!p.telemetry_enabled);
        assert!(!p.session_replay_enabled);
        assert!(!p.editor_executable.is_empty());
    }

    #[test]
    fn edited_primary_is_unique_in_all_views_and_sync_preserves_original() {
        use crate::services::immich_client::{AssetStack, AssetSummary};
        let folder = std::env::current_dir()
            .unwrap()
            .join(format!("immich-stack-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("db.sqlite");
        let db = Database::test_database(path.clone()).unwrap();
        let asset = |id: &str, name: &str| {
            serde_json::from_value::<AssetSummary>(serde_json::json!({
                "id":id,"originalFileName":name,"originalPath":format!("/photos/{name}"),
                "fileCreatedAt":"2025-06-20T10:00:00Z","checksum":null,
                "type":"IMAGE","width":600,"height":400
            }))
            .unwrap()
        };
        let original = asset("original", "camera.dng");
        let first = asset("first", "camera-edited-20250620.jpg");
        let second = asset("second", "camera-edited-20250621.jpg");
        db.upsert_assets(
            "account",
            &[original.clone(), first.clone(), second.clone()],
        )
        .unwrap();
        db.open().unwrap().execute("INSERT INTO album_assets(album_id,asset_id,account_id) VALUES('album','original','account')",[]).unwrap();
        db.record_edit_stack("original", "first", &["first".into(), "original".into()])
            .unwrap();
        assert_eq!(db.original_edit_asset("first").unwrap(), "original");
        db.sync_asset_stack(
            "account",
            &AssetStack {
                primary_asset_id: "second".into(),
                assets: vec![second.clone(), first.clone(), original.clone()],
            },
        )
        .unwrap();
        assert_eq!(db.original_edit_asset("second").unwrap(), "original");
        assert!(db.is_deletable_edit_version("first").unwrap());
        assert!(db.is_deletable_edit_version("second").unwrap());
        assert!(!db.is_deletable_edit_version("original").unwrap());
        let album_items = db.get_album_assets("album", 0, 100, None, None).unwrap().0;
        assert_eq!(album_items[0].stack_count, Some(3));
        assert_eq!(
            db.get_assets(0, 100, None, None, None, None)
                .unwrap()
                .0
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            ["second"]
        );
        assert_eq!(
            db.get_album_assets("album", 0, 100, None, None)
                .unwrap()
                .0
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            ["second"]
        );
        assert!(db.get_asset_summary("original").unwrap().is_some());
        drop(db);
        let db = Database::test_database(path.clone()).unwrap();
        assert_eq!(db.original_edit_asset("second").unwrap(), "original");
        assert_eq!(db.edit_version_ids("original").unwrap().len(), 2);
        assert!(db.remove_edit_version_from_cache("original", None).is_err());
        assert!(db
            .remove_edit_version_from_cache("second", Some("wrong-account"))
            .is_err());
        assert_eq!(
            db.get_assets(0, 100, None, None, None, None).unwrap().0[0].id,
            "second"
        );
        db.open().unwrap().execute(
            "INSERT INTO album_assets(album_id,asset_id,account_id) VALUES('primary-only','second','account')",
            [],
        ).unwrap();
        db.remove_edit_version_from_cache("second", Some("account"))
            .unwrap();
        db.sync_asset_stack(
            "account",
            &AssetStack {
                primary_asset_id: "second".into(),
                assets: vec![second, first, original],
            },
        )
        .unwrap();
        assert!(db.get_asset_summary("second").unwrap().is_none());
        assert_eq!(
            db.get_assets(0, 100, None, None, None, None).unwrap().0[0].id,
            "original"
        );
        assert_eq!(
            db.get_album_assets("primary-only", 0, 100, None, None)
                .unwrap()
                .0[0]
                .id,
            "original"
        );
        assert!(
            db.get_asset_summary("first")
                .unwrap()
                .unwrap()
                .is_stack_secondary
        );
        assert_eq!(
            db.get_asset_summary("original")
                .unwrap()
                .unwrap()
                .stack_count,
            Some(2)
        );
        let pending = db.list_pending_mutations().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].kind, "delete_version");
        assert_eq!(pending[0].asset_id, "second");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&pending[0].payload_json).unwrap()
                ["originalAssetId"],
            "original"
        );
        db.remove_edit_version_from_cache("first", None).unwrap();
        assert!(db.edit_version_ids("original").unwrap().is_empty());
        assert_eq!(
            db.get_asset_summary("original")
                .unwrap()
                .unwrap()
                .stack_count,
            None
        );
        drop(db);
        for name in ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"] {
            let path = folder.join(name);
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        std::fs::remove_dir(folder).unwrap();
    }

    async fn mock_server(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) =
                    tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut request = Vec::new();
                let header_end = loop {
                    let mut byte = [0u8; 1];
                    stream.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break request.len();
                    }
                };
                let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .map(|length| length.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                request.resize(header_end + length, 0);
                stream.read_exact(&mut request[header_end..]).await.unwrap();
                requests.push(String::from_utf8_lossy(&request).into_owned());
                let response=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (url, requests)
    }

    async fn fixture_client(
        responses: Vec<(u16, &'static str)>,
    ) -> (ImmichClient, tokio::task::JoinHandle<Vec<String>>) {
        let (url, requests) = mock_server(responses).await;
        let client = ImmichClient::new();
        *client.session.lock().await = Some(crate::services::immich_client::AuthSession {
            server_url: url,
            access_token: "fixture-token".into(),
            refresh_token: None,
            user_id: "fixture-user".into(),
            user_name: None,
        });
        (client, requests)
    }

    #[tokio::test]
    async fn deleting_active_edit_restores_original_before_trash() {
        let (client, requests) = fixture_client(vec![
            (200, r#"{"stack":{"id":"stack"}}"#),
            (200, r#"{"primaryAssetId":"edit","assets":[{"id":"edit"},{"id":"original"},{"id":"older"}]}"#),
            (200, "{}"),
            (204, ""),
        ]).await;
        client.trash_edit_version("edit", "original").await.unwrap();
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("GET /api/assets/edit "));
        assert!(requests[1].starts_with("GET /api/stacks/stack "));
        assert!(requests[2].starts_with("PUT /api/stacks/stack "));
        assert!(requests[2].ends_with(r#"{"primaryAssetId":"original"}"#));
        assert!(requests[3].starts_with("DELETE /api/assets "));
        assert!(requests[3].ends_with(r#"{"force":false,"ids":["edit"]}"#));
    }

    #[tokio::test]
    async fn deleting_secondary_or_replaying_old_edit_preserves_newer_primary() {
        let (client, requests) = fixture_client(vec![
            (200, r#"{"stack":{"id":"stack"}}"#),
            (200, r#"{"primaryAssetId":"newer","assets":[{"id":"edit"},{"id":"original"},{"id":"newer"}]}"#),
            (204, ""),
        ]).await;
        client.trash_edit_version("edit", "original").await.unwrap();
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].starts_with("DELETE /api/assets "));
    }

    #[tokio::test]
    async fn restore_rejection_prevents_trash_and_original_is_protected() {
        let (client, requests) = fixture_client(vec![
            (200, r#"{"stack":{"id":"stack"}}"#),
            (
                200,
                r#"{"primaryAssetId":"edit","assets":[{"id":"edit"},{"id":"original"}]}"#,
            ),
            (403, "{}"),
        ])
        .await;
        assert!(client
            .trash_edit_version("original", "original")
            .await
            .unwrap_err()
            .contains("cannot be deleted"));
        assert!(client
            .trash_edit_version("edit", "original")
            .await
            .unwrap_err()
            .contains("restore rejected"));
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(!requests
            .iter()
            .any(|request| request.starts_with("DELETE ")));
    }

    #[tokio::test]
    async fn missing_original_prevents_active_edit_deletion() {
        let (client, requests) = fixture_client(vec![
            (200, r#"{"stack":{"id":"stack"}}"#),
            (
                200,
                r#"{"primaryAssetId":"edit","assets":[{"id":"edit"},{"id":"other"}]}"#,
            ),
        ])
        .await;
        assert!(client
            .trash_edit_version("edit", "original")
            .await
            .unwrap_err()
            .contains("missing from the server stack"));
        assert_eq!(requests.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn upload_preserves_capture_time_streams_original_and_creates_edited_first_stack() {
        let folder = std::env::current_dir()
            .unwrap()
            .join(format!("immich-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("photo.jpg");
        let sidecar = folder.join("photo.xmp");
        std::fs::write(&file, b"original-fixture").unwrap();
        std::fs::write(&sidecar, b"metadata-fixture").unwrap();
        let (url, requests) =
            mock_server(vec![(200, "{}"), (201, r#"{"id":"edited"}"#), (201, "{}")]).await;
        let client = ImmichClient::new();
        *client.session.lock().await = Some(crate::services::immich_client::AuthSession {
            server_url: url,
            access_token: "fixture-token".into(),
            refresh_token: None,
            user_id: "fixture-user".into(),
            user_name: None,
        });
        assert_eq!(
            client
                .upload_retained_media(
                    &file,
                    "fixture-checksum",
                    Some("2025-06-20T10:00:00Z"),
                    Some(&sidecar)
                )
                .await
                .unwrap(),
            "edited"
        );
        client
            .create_edit_stack(&["edited".into(), "original".into()])
            .await
            .unwrap();
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("GET /api/server/ping "));
        let upload = &requests[1];
        for value in [
            "POST /api/assets ",
            "fixture-checksum",
            "name=\"assetData\"",
            "original-fixture",
            "name=\"sidecarData\"",
            "metadata-fixture",
            "2025-06-20T10:00:00Z",
            "name=\"fileModifiedAt\"",
            "name=\"deviceId\"",
            "name=\"deviceAssetId\"",
        ] {
            assert!(upload.contains(value), "missing {value}");
        }
        assert!(requests[2].ends_with(r#"{"assetIds":["edited","original"]}"#));
        std::fs::remove_file(file).unwrap();
        std::fs::remove_file(sidecar).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }

    #[tokio::test]
    async fn reachable_upload_rejections_are_explicit() {
        let file = std::env::current_dir()
            .unwrap()
            .join(format!("immich-reject-{}.jpg", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"fixture").unwrap();
        let (url, requests) = mock_server(vec![(200, "{}"), (403, "{}")]).await;
        let client = ImmichClient::new();
        *client.session.lock().await = Some(crate::services::immich_client::AuthSession {
            server_url: url,
            access_token: "fixture-token".into(),
            refresh_token: None,
            user_id: "fixture-user".into(),
            user_name: None,
        });
        assert_eq!(
            client
                .upload_retained_media(&file, "checksum", None, None)
                .await
                .unwrap_err(),
            "Immich rejected upload (HTTP 403)"
        );
        requests.await.unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"fixture");
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn queue_and_deduplication_survive_restart_and_isolate_accounts() {
        let folder = std::env::current_dir()
            .unwrap()
            .join(format!("immich-media-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("db.sqlite");
        let db = Database::test_database(path.clone()).unwrap();
        let file = folder.join("photo.jpg");
        std::fs::write(&file, b"test-original").unwrap();
        let checksum = db.cached_import_hash(&file).unwrap();
        assert_eq!(checksum, file_hash(&file).unwrap());
        assert_eq!(checksum, db.cached_import_hash(&file).unwrap());
        db.queue_media(&UploadJob {
            id: "job".into(),
            account_id: "account-a".into(),
            local_path: file.to_string_lossy().into(),
            checksum: checksum.clone(),
            album_ids: vec!["album".into()],
            original_asset_id: None,
            server_asset_id: None,
            state: "queued".into(),
            error: None,
        })
        .unwrap();
        drop(db);
        let db = Database::test_database(path).unwrap();
        assert_eq!(db.media_uploads().unwrap().len(), 1);
        assert!(db.known_media_hash("account-a", &checksum).unwrap());
        assert!(!db.known_media_hash("account-b", &checksum).unwrap());
        db.set_media_upload_state("job", "uploading", None).unwrap();
        assert_eq!(db.media_uploads().unwrap()[0].state, "uploading");
        db.recover_media_uploads().unwrap();
        assert_eq!(db.media_uploads().unwrap()[0].state, "queued");
        db.set_media_upload_state("job", "failed", Some("rejected"))
            .unwrap();
        assert_eq!(
            db.media_uploads().unwrap()[0].error.as_deref(),
            Some("rejected")
        );
        db.set_media_upload_state("job", "queued", None).unwrap();
        assert!(db.media_uploads().unwrap()[0].error.is_none());
        assert!(db.set_media_upload_state("job", "invalid", None).is_err());
        let job = db.media_uploads().unwrap().remove(0);
        assert_eq!(job.album_ids, ["album"]);
        assert!(db.queue_media(&job).is_err());
        std::fs::write(&file, b"changed-original").unwrap();
        assert_ne!(db.cached_import_hash(&file).unwrap(), checksum);
        assert_eq!(std::fs::read(&file).unwrap(), b"changed-original");
        drop(db);
        std::fs::remove_file(file).unwrap();
        std::fs::remove_file(folder.join("db.sqlite")).unwrap();
        for filename in ["db.sqlite-wal", "db.sqlite-shm"] {
            let path = folder.join(filename);
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        std::fs::remove_dir(folder).unwrap();
    }
}
