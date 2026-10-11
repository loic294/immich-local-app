//! Time correction ("Fix time"): shifts the capture date/time of assets by a
//! fixed offset. Only Immich metadata (`dateTimeOriginal`) and the local SQLite
//! cache are modified — original file bytes are never touched. When the
//! account's server is unreachable the change is applied optimistically to the
//! cache and queued as a `time` mutation, replayed by `flush_pending_mutations`.

use std::collections::HashMap;

use chrono::{DateTime, FixedOffset, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::StatusCode;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::db::Database;
use crate::services::immich_client::ImmichClient;
use crate::AppState;

const API_KEY_HEADER: &str = "x-api-key";
/// Guard against absurd offsets (roughly 200 years).
const MAX_OFFSET_SECONDS: i64 = 200 * 366 * 24 * 3600;
pub(crate) const TIME_MUTATION_KIND: &str = "time";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftAssetTimesPayload {
    pub asset_ids: Vec<String>,
    pub offset_seconds: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftAssetTimeFailure {
    pub asset_id: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftAssetTimesResult {
    pub updated_count: usize,
    pub queued_count: usize,
    pub failed: Vec<ShiftAssetTimeFailure>,
}

/// Capture time of an asset plus the UTC offset of its local wall clock.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AssetTime {
    pub instant: DateTime<Utc>,
    pub offset_seconds: i32,
}

/// Values written to Immich / the cache after shifting.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ShiftedTime {
    /// UTC timestamp stored in `assets.file_created_at`.
    pub file_created_at: String,
    /// Offset-aware timestamp sent to Immich as `dateTimeOriginal`.
    pub date_time_original: String,
}

pub(crate) fn parse_timestamp(value: &str) -> Option<DateTime<FixedOffset>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed);
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y:%m:%d %H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(Utc.from_utc_datetime(&naive).fixed_offset());
        }
    }
    None
}

fn has_explicit_offset(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.ends_with('Z') || trimmed.ends_with('z') {
        return false;
    }
    trimmed
        .get(10..)
        .map(|tail| tail.contains('+') || tail.contains('-'))
        .unwrap_or(false)
}

/// Parses EXIF time zones such as `UTC+2`, `UTC-05:30`, `+02:00` or `UTC`.
/// IANA names cannot be resolved without a tz database and yield `None`.
pub(crate) fn parse_zone_offset(zone: &str) -> Option<i32> {
    let trimmed = zone.trim();
    let rest = trimmed
        .strip_prefix("UTC")
        .or_else(|| trimmed.strip_prefix("GMT"))
        .unwrap_or(trimmed);
    if rest.is_empty() {
        return if trimmed.is_empty() { None } else { Some(0) };
    }
    let (sign, digits) = match rest.chars().next()? {
        '+' => (1, &rest[1..]),
        '-' => (-1, &rest[1..]),
        _ => return None,
    };
    let (hours, minutes) = match digits.split_once(':') {
        Some((h, m)) => (h.parse::<i32>().ok()?, m.parse::<i32>().ok()?),
        None if digits.len() == 4 => (digits[..2].parse().ok()?, digits[2..].parse().ok()?),
        None => (digits.parse::<i32>().ok()?, 0),
    };
    if hours > 14 || minutes >= 60 {
        return None;
    }
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Resolves the capture time from Immich-shaped data: EXIF `dateTimeOriginal`
/// preferred, falling back to `fileCreatedAt`. The wall-clock offset comes
/// from an explicit offset, `localDateTime - fileCreatedAt`, or the EXIF
/// `timeZone`, in that order.
pub(crate) fn resolve_asset_time(
    exif: Option<&Value>,
    file_created_at: Option<&str>,
    local_date_time: Option<&str>,
) -> Option<AssetTime> {
    let original = exif
        .and_then(|e| e.get("dateTimeOriginal"))
        .and_then(Value::as_str)
        .filter(|v| parse_timestamp(v).is_some());
    let source = original.or(file_created_at)?;
    let parsed = parse_timestamp(source)?;

    let offset_seconds = if has_explicit_offset(source) {
        parsed.offset().local_minus_utc()
    } else if let (Some(local), Some(created)) = (
        local_date_time.and_then(parse_timestamp),
        file_created_at.and_then(parse_timestamp),
    ) {
        let diff = local
            .naive_utc()
            .signed_duration_since(created.naive_utc())
            .num_seconds();
        if diff.abs() <= 14 * 3600 {
            diff as i32
        } else {
            0
        }
    } else {
        exif.and_then(|e| e.get("timeZone"))
            .and_then(Value::as_str)
            .and_then(parse_zone_offset)
            .unwrap_or(0)
    };

    Some(AssetTime {
        instant: parsed.with_timezone(&Utc),
        offset_seconds,
    })
}

pub(crate) fn shift_time(time: AssetTime, delta_seconds: i64) -> Option<ShiftedTime> {
    let shifted = time
        .instant
        .checked_add_signed(chrono::Duration::seconds(delta_seconds))?;
    let offset = FixedOffset::east_opt(time.offset_seconds)
        .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
    Some(ShiftedTime {
        file_created_at: shifted.to_rfc3339_opts(SecondsFormat::Millis, true),
        date_time_original: shifted
            .with_timezone(&offset)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

impl ImmichClient {
    async fn time_session_headers(&self) -> Result<(String, HeaderMap), String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not authenticated".to_string())?;
        let mut headers = HeaderMap::new();
        headers.insert(
            API_KEY_HEADER,
            HeaderValue::from_str(&session.access_token).map_err(|err| err.to_string())?,
        );
        Ok((session.server_url, headers))
    }

    /// Fetches the authoritative capture time of an asset from Immich.
    pub(crate) async fn get_asset_time(&self, asset_id: &str) -> Result<AssetTime, String> {
        let (server_url, headers) = self.time_session_headers().await?;
        let mut last_error = String::new();
        for url in [
            format!("{}/api/assets/{}", server_url, asset_id),
            format!("{}/api/asset/{}", server_url, asset_id),
        ] {
            let response = self
                .client
                .get(&url)
                .headers(headers.clone())
                .send()
                .await
                .map_err(|err| err.to_string())?;
            let status = response.status();
            if status == StatusCode::NOT_FOUND {
                last_error = format!("asset {asset_id} not found ({status})");
                continue;
            }
            if !status.is_success() {
                return Err(format!("asset fetch failed with status {status}"));
            }
            let value: Value = response.json().await.map_err(|err| err.to_string())?;
            return resolve_asset_time(
                value.get("exifInfo"),
                value.get("fileCreatedAt").and_then(Value::as_str),
                value.get("localDateTime").and_then(Value::as_str),
            )
            .ok_or_else(|| format!("asset {asset_id} has no capture time"));
        }
        Err(last_error)
    }

    /// Sets `dateTimeOriginal` (metadata only) for one asset. Immich updates
    /// its database/sidecar; the original file is never rewritten.
    pub(crate) async fn update_asset_date_time_original(
        &self,
        asset_id: &str,
        date_time_original: &str,
    ) -> Result<(), String> {
        let (server_url, headers) = self.time_session_headers().await?;
        let payload = serde_json::json!({ "dateTimeOriginal": date_time_original });

        let response = self
            .client
            .put(format!("{}/api/assets/{}", server_url, asset_id))
            .headers(headers.clone())
            .json(&payload)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let mut status = response.status();
        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            log::warn!(
                "[time.client] PUT /api/assets/{} returned {}, trying legacy PATCH",
                asset_id,
                status
            );
            status = self
                .client
                .patch(format!("{}/api/asset/{}", server_url, asset_id))
                .headers(headers)
                .json(&payload)
                .send()
                .await
                .map_err(|err| err.to_string())?
                .status();
        }
        if status.is_success() {
            Ok(())
        } else {
            Err(format!("date/time update failed with status {status}"))
        }
    }
}

impl Database {
    /// Reads the cached capture time of an asset (never touches the network).
    pub(crate) fn get_cached_asset_time(
        &self,
        asset_id: &str,
    ) -> Result<Option<AssetTime>, String> {
        let conn = self.open()?;
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT file_created_at, exif_info_json FROM assets WHERE id = ?1",
                params![asset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let Some((file_created_at, exif_json)) = row else {
            return Ok(None);
        };
        let exif = exif_json.and_then(|json| serde_json::from_str::<Value>(&json).ok());
        Ok(resolve_asset_time(
            exif.as_ref(),
            file_created_at.as_deref(),
            None,
        ))
    }

    /// Writes a shifted capture time into the cache (`file_created_at` and the
    /// cached EXIF `dateTimeOriginal`).
    pub(crate) fn apply_cached_asset_time(
        &self,
        asset_id: &str,
        shifted: &ShiftedTime,
    ) -> Result<(), String> {
        let conn = self.open()?;
        let exif_json: Option<String> = conn
            .query_row(
                "SELECT exif_info_json FROM assets WHERE id = ?1",
                params![asset_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        let updated_exif = exif_json.and_then(|json| {
            let mut value = serde_json::from_str::<Value>(&json).ok()?;
            let object = value.as_object_mut()?;
            object.insert(
                "dateTimeOriginal".into(),
                Value::String(shifted.date_time_original.clone()),
            );
            serde_json::to_string(&value).ok()
        });
        conn.execute(
            "UPDATE assets SET file_created_at = ?2, exif_info_json = COALESCE(?3, exif_info_json) WHERE id = ?1",
            params![asset_id, shifted.file_created_at, updated_exif],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }
}

/// Offline path: apply the shift optimistically to the cache and enqueue a
/// `time` mutation carrying the absolute target timestamp (idempotent replay).
pub(crate) fn queue_offline_time_shift(
    db: &Database,
    account_id: &str,
    asset_id: &str,
    delta: i64,
) -> Result<(), String> {
    let time = db
        .get_cached_asset_time(asset_id)?
        .ok_or_else(|| "no cached capture time".to_string())?;
    let shifted = shift_time(time, delta).ok_or_else(|| "shifted time out of range".to_string())?;
    db.apply_cached_asset_time(asset_id, &shifted)?;
    let body = serde_json::json!({
        "dateTimeOriginal": shifted.date_time_original,
        "fileCreatedAt": shifted.file_created_at,
        "offsetSeconds": delta,
    });
    db.enqueue_mutation(account_id, asset_id, TIME_MUTATION_KIND, &body.to_string())
}

/// Extracts the `dateTimeOriginal` to replay from a queued `time` payload.
pub(crate) fn time_replay_target(payload: &Value) -> Result<String, String> {
    payload
        .get("dateTimeOriginal")
        .and_then(Value::as_str)
        .filter(|value| parse_timestamp(value).is_some())
        .map(str::to_string)
        .ok_or_else(|| "queued time mutation missing dateTimeOriginal".to_string())
}

async fn account_reachable(state: &tauri::State<'_, AppState>, account_id: &str) -> bool {
    let client = state.client_for(Some(account_id));
    match state.db.get_account(account_id) {
        Ok(Some(account)) => client.ping(&account.server_url).await,
        _ => match state.db.get_auth_credentials() {
            Ok(Some((server_url, _, _))) => state.immich.ping(&server_url).await,
            _ => false,
        },
    }
}

/// Shifts the capture date/time of every asset by `offsetSeconds`.
#[tauri::command]
pub async fn shift_asset_times(
    payload: ShiftAssetTimesPayload,
    state: tauri::State<'_, AppState>,
) -> Result<ShiftAssetTimesResult, String> {
    let delta = payload.offset_seconds;
    if delta == 0 {
        return Err("time offset must not be zero".to_string());
    }
    if delta.abs() > MAX_OFFSET_SECONDS {
        return Err("time offset is too large".to_string());
    }

    let mut asset_ids = payload.asset_ids;
    asset_ids.sort();
    asset_ids.dedup();
    log::info!(
        "[time.shift] start assets={} offset_seconds={}",
        asset_ids.len(),
        delta
    );

    let mut result = ShiftAssetTimesResult {
        updated_count: 0,
        queued_count: 0,
        failed: Vec::new(),
    };
    let mut offline_accounts: HashMap<String, bool> = HashMap::new();

    for asset_id in asset_ids {
        let (account_id, client) = state.account_and_client_for_asset(&asset_id);
        let known_offline = offline_accounts.get(&account_id).copied().unwrap_or(false);

        if !known_offline {
            let online = async {
                let time = client.get_asset_time(&asset_id).await?;
                let shifted = shift_time(time, delta)
                    .ok_or_else(|| "shifted time out of range".to_string())?;
                client
                    .update_asset_date_time_original(&asset_id, &shifted.date_time_original)
                    .await?;
                Ok::<ShiftedTime, String>(shifted)
            }
            .await;

            match online {
                Ok(shifted) => {
                    if let Err(err) = state.db.apply_cached_asset_time(&asset_id, &shifted) {
                        log::warn!(
                            "[time.shift] cache write failed asset_id={} err={}",
                            asset_id,
                            err
                        );
                    }
                    result.updated_count += 1;
                    continue;
                }
                Err(err) => {
                    let reachable = match offline_accounts.get(&account_id) {
                        Some(offline) => !offline,
                        None => {
                            let reachable = account_reachable(&state, &account_id).await;
                            offline_accounts.insert(account_id.clone(), !reachable);
                            reachable
                        }
                    };
                    if reachable {
                        log::warn!(
                            "[time.shift] server rejected asset_id={} account={} err={}",
                            asset_id,
                            account_id,
                            err
                        );
                        result.failed.push(ShiftAssetTimeFailure {
                            asset_id,
                            error: err,
                        });
                        continue;
                    }
                    log::warn!(
                        "[time.shift] offline — queuing asset_id={} account={} err={}",
                        asset_id,
                        account_id,
                        err
                    );
                }
            }
        }

        match queue_offline_time_shift(&state.db, &account_id, &asset_id, delta) {
            Ok(()) => result.queued_count += 1,
            Err(err) => {
                log::warn!(
                    "[time.shift] queue failed asset_id={} err={}",
                    asset_id,
                    err
                );
                result.failed.push(ShiftAssetTimeFailure {
                    asset_id,
                    error: err,
                });
            }
        }
    }

    log::info!(
        "[time.shift] done updated={} queued={} failed={}",
        result.updated_count,
        result.queued_count,
        result.failed.len()
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_explicit_offset_when_shifting() {
        let exif = serde_json::json!({ "dateTimeOriginal": "2023-07-14T10:00:00+02:00" });
        let time = resolve_asset_time(Some(&exif), Some("2023-07-14T08:00:00.000Z"), None).unwrap();
        assert_eq!(time.offset_seconds, 7200);
        let shifted = shift_time(time, 3600 + 30).unwrap();
        assert_eq!(shifted.file_created_at, "2023-07-14T09:00:30.000Z");
        assert_eq!(shifted.date_time_original, "2023-07-14T11:00:30.000+02:00");
    }

    #[test]
    fn derives_offset_from_local_date_time() {
        let exif = serde_json::json!({ "dateTimeOriginal": "2023-07-14T08:00:00.000Z", "timeZone": "Europe/Paris" });
        let time = resolve_asset_time(
            Some(&exif),
            Some("2023-07-14T08:00:00.000Z"),
            Some("2023-07-14T10:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(time.offset_seconds, 7200);
        let shifted = shift_time(time, -86400).unwrap();
        assert_eq!(shifted.date_time_original, "2023-07-13T10:00:00.000+02:00");
    }

    #[test]
    fn falls_back_to_file_created_and_zone_names() {
        let exif = serde_json::json!({ "timeZone": "UTC-5" });
        let time = resolve_asset_time(Some(&exif), Some("2020-01-01T12:00:00Z"), None).unwrap();
        assert_eq!(time.offset_seconds, -5 * 3600);
        assert_eq!(parse_zone_offset("UTC+05:30"), Some(19800));
        assert_eq!(parse_zone_offset("Europe/Paris"), None);
        assert!(resolve_asset_time(None, None, None).is_none());
    }

    struct TestDb {
        folder: std::path::PathBuf,
        db: Database,
    }

    impl TestDb {
        // Kept under target/ (works on macOS and Windows; no system temp dir).
        fn new() -> Self {
            let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("test-dbs")
                .join(format!("time-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&folder).unwrap();
            let db = Database::test_database(folder.join("db.sqlite")).unwrap();
            Self { folder, db }
        }

        fn reopen(&mut self) {
            self.db = Database::test_database(self.folder.join("db.sqlite")).unwrap();
        }

        fn insert_asset(&self, id: &str, file_created_at: &str, exif: &Value) {
            let conn = self.db.open().unwrap();
            conn.execute(
                "INSERT INTO assets (id, account_id, original_file_name, file_created_at, updated_at, exif_info_json)
                 VALUES (?1, 'account-a', ?2, ?3, 0, ?4)",
                params![id, format!("{id}.jpg"), file_created_at, exif.to_string()],
            )
            .unwrap();
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.folder);
        }
    }

    #[test]
    fn offline_shift_updates_cache_and_queues_replayable_mutation() {
        let mut test = TestDb::new();
        let exif = serde_json::json!({ "dateTimeOriginal": "2023-07-14T10:00:00+02:00" });
        test.insert_asset("asset-1", "2023-07-14T08:00:00.000Z", &exif);

        queue_offline_time_shift(&test.db, "account-a", "asset-1", 3600).unwrap();

        let cached = test.db.get_cached_asset_time("asset-1").unwrap().unwrap();
        assert_eq!(cached.offset_seconds, 7200);
        assert_eq!(
            cached.instant.to_rfc3339_opts(SecondsFormat::Secs, true),
            "2023-07-14T09:00:00Z"
        );

        // Survives an app restart (durable queue).
        test.reopen();
        let pending = test.db.list_pending_mutations().unwrap();
        assert_eq!(pending.len(), 1);
        let mutation = &pending[0];
        assert_eq!(mutation.kind, TIME_MUTATION_KIND);
        assert_eq!(mutation.account_id, "account-a");
        assert_eq!(mutation.asset_id, "asset-1");
        let payload: Value = serde_json::from_str(&mutation.payload_json).unwrap();
        assert_eq!(
            time_replay_target(&payload).unwrap(),
            "2023-07-14T11:00:00.000+02:00"
        );
        assert_eq!(payload["offsetSeconds"], 3600);
    }

    #[test]
    fn queued_time_mutations_replay_in_order_and_dequeue() {
        let test = TestDb::new();
        let exif = serde_json::json!({ "dateTimeOriginal": "2020-01-01T12:00:00Z" });
        test.insert_asset("asset-1", "2020-01-01T12:00:00.000Z", &exif);
        test.insert_asset("asset-2", "2020-01-01T12:00:00.000Z", &exif);

        queue_offline_time_shift(&test.db, "account-a", "asset-1", 60).unwrap();
        queue_offline_time_shift(&test.db, "account-a", "asset-2", -60).unwrap();
        // A second shift of the same asset stacks on the optimistic cache value.
        queue_offline_time_shift(&test.db, "account-a", "asset-1", 60).unwrap();

        let pending = test.db.list_pending_mutations().unwrap();
        let order: Vec<_> = pending.iter().map(|m| m.asset_id.as_str()).collect();
        assert_eq!(order, ["asset-1", "asset-2", "asset-1"]);
        let targets: Vec<_> = pending
            .iter()
            .map(|m| time_replay_target(&serde_json::from_str(&m.payload_json).unwrap()).unwrap())
            .collect();
        assert_eq!(
            targets,
            [
                "2020-01-01T12:01:00.000Z",
                "2020-01-01T11:59:00.000Z",
                "2020-01-01T12:02:00.000Z"
            ]
        );

        // Accepted or server-rejected entries are both removed by replay.
        for mutation in &pending {
            test.db.delete_pending_mutation(mutation.id).unwrap();
        }
        assert_eq!(test.db.count_pending_mutations().unwrap(), 0);
    }

    #[test]
    fn offline_shift_without_cached_time_is_not_queued() {
        let test = TestDb::new();
        let err = queue_offline_time_shift(&test.db, "account-a", "missing", 60).unwrap_err();
        assert_eq!(err, "no cached capture time");
        assert_eq!(test.db.count_pending_mutations().unwrap(), 0);
    }

    #[test]
    fn rejects_corrupt_replay_payloads() {
        assert!(time_replay_target(&serde_json::json!({})).is_err());
        assert!(
            time_replay_target(&serde_json::json!({ "dateTimeOriginal": "not a date" })).is_err()
        );
        assert!(time_replay_target(&serde_json::json!({ "dateTimeOriginal": 5 })).is_err());
    }
}
