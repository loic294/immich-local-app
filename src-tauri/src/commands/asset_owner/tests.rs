use super::*;
use crate::commands::deletion::{change_deleted_state, refresh_deleted_assets_inner};
use crate::commands::settings::DeleteBehavior;
use crate::services::{
    account_manager::AccountManager,
    db::{Account, Database},
    immich_client::{AssetSummary, ImmichClient},
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Server {
    requests: Vec<(String, String, Value)>,
    offline: bool,
    reject_owner: bool,
    omit_owner: bool,
    edit_stack: bool,
    primary_restored: bool,
    archived: bool,
    trashed: bool,
    reader_loses_access: bool,
    fail_owner_listing: bool,
    favorite: bool,
    rating: Option<i64>,
    description: Option<String>,
    capture_time: Option<String>,
}

impl Server {
    fn respond(&mut self, line: &str, user: &str, body: Value) -> (u16, Value) {
        self.requests
            .push((line.to_string(), user.to_string(), body.clone()));
        if line.starts_with("GET /api/server/ping ") {
            return (200, json!({"res": "pong"}));
        }
        if line.starts_with("GET /api/timeline/buckets?") {
            if user == "owner" && self.fail_owner_listing {
                return (500, json!({"message": "listing unavailable"}));
            }
            let matches = if line.contains("isTrashed=true") {
                self.trashed
            } else {
                self.archived && !self.trashed
            };
            return (
                200,
                if user == "owner" && matches {
                    json!([{"timeBucket": "2026-11-01"}])
                } else {
                    json!([])
                },
            );
        }
        if line.starts_with("GET /api/timeline/bucket?") {
            return (200, json!({"id": ["photo"]}));
        }
        let mut asset = json!({
            "id": "photo", "originalFileName": "photo.jpg",
            "visibility": if self.archived { "archive" } else { "timeline" },
            "isTrashed": self.trashed,
            "isFavorite": self.favorite,
            "fileCreatedAt": self.capture_time.as_deref().unwrap_or("2026-11-01T10:00:00.000Z"),
            "exifInfo": { "rating": self.rating, "description": self.description }
        });
        if !self.omit_owner {
            asset["ownerId"] = json!("owner");
        }
        if self.edit_stack {
            asset["stack"] = json!({"id": "stack"});
        }
        if line.starts_with("GET /api/assets/photo ") || line.starts_with("GET /api/asset/photo ") {
            if user == "reader" && self.reader_loses_access && self.trashed {
                return (404, json!({"message": "Asset not found"}));
            }
            return (200, asset);
        }
        if line.starts_with("GET /api/stacks/stack ") {
            return (
                200,
                json!({
                    "primaryAssetId": if self.primary_restored { "original" } else { "photo" },
                    "assets": [{"id": "photo"}, {"id": "original"}]
                }),
            );
        }
        if line.starts_with("PUT /api/stacks/stack ") && user == "owner" {
            assert_eq!(body["primaryAssetId"], "original");
            self.primary_restored = true;
            return (200, json!({}));
        }
        if line.starts_with("PATCH /api/asset/photo ") || line.starts_with("PUT /api/assets/photo ")
        {
            return if user == "owner" && !self.reject_owner {
                if let Some(visibility) = body["visibility"].as_str() {
                    self.archived = visibility == "archive";
                    asset["visibility"] = body["visibility"].clone();
                }
                if let Some(favorite) = body["isFavorite"].as_bool() {
                    self.favorite = favorite;
                    asset["isFavorite"] = json!(favorite);
                }
                if body.get("rating").is_some() {
                    self.rating = body["rating"].as_i64();
                    asset["exifInfo"]["rating"] = body["rating"].clone();
                }
                if body.get("description").is_some() {
                    self.description = body["description"].as_str().map(str::to_string);
                    asset["exifInfo"]["description"] = body["description"].clone();
                }
                if let Some(time) = body["dateTimeOriginal"].as_str() {
                    self.capture_time = Some(time.to_string());
                    asset["fileCreatedAt"] = json!(time);
                }
                (200, asset)
            } else {
                (
                    400,
                    json!({"message": "Not found or no asset.update access"}),
                )
            };
        }
        if line.starts_with("DELETE /api/assets ")
            || line.starts_with("POST /api/trash/restore/assets ")
        {
            return if user == "owner" && !self.reject_owner {
                assert_eq!(body["ids"], json!(["photo"]));
                if line.starts_with("DELETE ") {
                    assert_eq!(body["force"], false);
                    self.trashed = true;
                } else {
                    self.trashed = false;
                }
                (204, Value::Null)
            } else {
                (
                    400,
                    json!({"message": "Not found or no asset.delete access"}),
                )
            };
        }
        if line.starts_with("POST /api/shared-links ") && user == "owner" {
            return (201, json!({"key": "photos"}));
        }
        (404, json!({"message": "unknown fixture endpoint"}))
    }

    fn writes(&self) -> Vec<(String, String, Value)> {
        self.requests
            .iter()
            .filter(|(line, _, _)| !line.starts_with("GET "))
            .cloned()
            .collect()
    }
}

struct Fixture {
    state: AppState,
    reader: Account,
    owner: Account,
    server: Arc<Mutex<Server>>,
    task: tokio::task::JoinHandle<()>,
    folder: PathBuf,
}

impl Fixture {
    async fn new(owner_signed_in: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = Arc::new(Mutex::new(Server::default()));
        let data = server.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                }
                let head = String::from_utf8(head).unwrap();
                let line = head.lines().next().unwrap();
                let lower = head.to_ascii_lowercase();
                let header = |name: &str| lower.lines().find_map(|line| line.strip_prefix(name));
                let user = header("x-api-key: ").unwrap_or_default();
                let length = header("content-length: ").map_or(0, |v| v.parse().unwrap());
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                let body = if body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap()
                };
                let response = {
                    let mut data = data.lock().unwrap();
                    if data.offline {
                        None
                    } else {
                        Some(data.respond(line, user, body))
                    }
                };
                let Some((status, body)) = response else {
                    continue;
                };
                let body = if status == 204 {
                    String::new()
                } else {
                    body.to_string()
                };
                stream.write_all(format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                ).as_bytes()).await.unwrap();
            }
        });
        let folder = std::env::temp_dir().join(format!("delete-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let db = Arc::new(Database::test_database(folder.join("db.sqlite")).unwrap());
        let accounts = Arc::new(AccountManager::new());
        let mut records = Vec::new();
        for user in ["reader", "owner"] {
            let account = db
                .upsert_account(&url, user, None, None, "api_key", user)
                .unwrap();
            if user == "reader" || owner_signed_in {
                let client = Arc::new(ImmichClient::new());
                client
                    .hydrate_offline_session(&url, user, false, user, None)
                    .await
                    .unwrap();
                accounts.insert(account.id.clone(), client);
            }
            records.push(account);
        }
        let owner = records.pop().unwrap();
        let reader = records.pop().unwrap();
        let asset = serde_json::from_value(json!({
            "id": "photo", "originalFileName": "photo.jpg", "visibility": "timeline",
            "fileCreatedAt": "2026-11-01T10:00:00.000Z"
        }))
        .unwrap();
        db.upsert_assets(&reader.id, &[asset]).unwrap();
        let state = AppState {
            db,
            immich: accounts.client(&reader.id).unwrap(),
            accounts,
            sync_cancel: Arc::new(AtomicBool::new(false)),
            sync_progress: Default::default(),
        };
        Self {
            state,
            reader,
            owner,
            server,
            task,
            folder,
        }
    }

    async fn change(&self, mode: DeleteBehavior, restore: bool) -> Result<AssetSummary, String> {
        change_deleted_state("photo".into(), mode, restore, &self.state).await
    }

    fn make_edit(&self, mode: DeleteBehavior) {
        let original = serde_json::from_value(json!({
            "id": "original", "originalFileName": "original.jpg"
        }))
        .unwrap();
        self.state
            .db
            .upsert_assets(&self.reader.id, &[original])
            .unwrap();
        self.state
            .db
            .record_edit_stack("original", "photo", &["original".into(), "photo".into()])
            .unwrap();
        let mut settings = self.state.db.get_settings().unwrap();
        settings.delete_behavior = mode;
        self.state.db.update_settings(&settings).unwrap();
        self.server.lock().unwrap().edit_stack = true;
    }

    async fn flush(&self) -> i64 {
        crate::commands::assets::flush_pending_mutations_inner(&self.state)
            .await
            .unwrap()
    }

    fn assert_unchanged(&self) {
        let asset = self.state.db.get_asset_summary("photo").unwrap().unwrap();
        assert!(!asset.is_archived && !asset.is_trashed);
        assert_eq!(self.state.db.count_pending_mutations().unwrap(), 0);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        std::fs::remove_dir_all(&self.folder).unwrap();
    }
}

#[tokio::test]
async fn delete_shared_photo_uses_owner_instead_of_cached_reader() {
    let fixture = Fixture::new(true).await;
    let result = fixture.change(DeleteBehavior::Archive, false).await;
    assert!(result.is_ok(), "delete_asset failed: {result:?}");
    assert!(result.unwrap().is_archived);
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, "owner");
    assert_eq!(writes[0].2, json!({"visibility": "archive"}));
    assert_eq!(
        fixture.state.db.get_asset_account_id("photo").unwrap(),
        Some(fixture.reader.id.clone())
    );
    assert_ne!(fixture.reader.id, fixture.owner.id);
    assert_eq!(fixture.state.db.count_pending_mutations().unwrap(), 0);
}

#[tokio::test]
async fn archive_trash_and_restore_route_to_owner_without_reassigning_cache() {
    let fixture = Fixture::new(true).await;
    for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
        for restore in [false, true] {
            let asset = fixture.change(mode, restore).await.unwrap();
            assert_eq!(
                asset.is_archived,
                mode == DeleteBehavior::Archive && !restore
            );
            assert_eq!(asset.is_trashed, mode == DeleteBehavior::Trash && !restore);
            assert_eq!(
                fixture.state.db.get_asset_account_id("photo").unwrap(),
                Some(fixture.reader.id.clone())
            );
        }
    }
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 4);
    assert!(writes.iter().all(|(_, user, _)| user == "owner"));
    assert_eq!(writes[0].2["visibility"], "archive");
    assert_eq!(writes[1].2["visibility"], "timeline");
    assert!(writes[2].0.starts_with("DELETE /api/assets "));
    assert!(writes[3].0.starts_with("POST /api/trash/restore/assets "));
    fixture.assert_unchanged();
}

#[tokio::test]
async fn missing_owner_session_never_mutates_as_reader_or_queues_online() {
    let fixture = Fixture::new(false).await;
    for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
        let error = fixture.change(mode, false).await.unwrap_err();
        assert!(
            error.contains("owner's account is not signed in"),
            "{error}"
        );
    }
    assert!(fixture.server.lock().unwrap().writes().is_empty());
    fixture.assert_unchanged();
}

#[tokio::test]
async fn owner_on_different_server_cannot_authorize_deletion() {
    let fixture = Fixture::new(true).await;
    fixture
        .state
        .db
        .open()
        .unwrap()
        .execute(
            "UPDATE accounts SET server_url='http://different.invalid' WHERE id=?1",
            [&fixture.owner.id],
        )
        .unwrap();
    let error = fixture
        .change(DeleteBehavior::Archive, false)
        .await
        .unwrap_err();
    assert!(
        error.contains("owner's account is not signed in"),
        "{error}"
    );
    assert!(fixture.server.lock().unwrap().writes().is_empty());
    fixture.assert_unchanged();
}

#[tokio::test]
async fn mismatched_owner_session_never_falls_back_to_reader() {
    let fixture = Fixture::new(true).await;
    fixture
        .state
        .accounts
        .insert(fixture.owner.id.clone(), fixture.state.immich.clone());
    let error = fixture
        .change(DeleteBehavior::Archive, false)
        .await
        .unwrap_err();
    assert!(
        error.contains("owner's account is not signed in"),
        "{error}"
    );
    assert!(fixture.server.lock().unwrap().writes().is_empty());
    fixture.assert_unchanged();
}

#[tokio::test]
async fn missing_server_owner_is_not_guessed_from_cache() {
    let fixture = Fixture::new(true).await;
    fixture.server.lock().unwrap().omit_owner = true;
    let error = fixture
        .change(DeleteBehavior::Archive, false)
        .await
        .unwrap_err();
    assert!(error.contains("has no owner"), "{error}");
    assert!(fixture.server.lock().unwrap().writes().is_empty());
    fixture.assert_unchanged();
}

#[tokio::test]
async fn owner_permission_rejection_is_surfaced_without_queue_or_cache_changes() {
    let fixture = Fixture::new(true).await;
    fixture.server.lock().unwrap().reject_owner = true;
    let error = fixture
        .change(DeleteBehavior::Archive, false)
        .await
        .unwrap_err();
    assert!(
        error.contains("Not found or no asset.update access"),
        "{error}"
    );
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, "owner");
    fixture.assert_unchanged();
}

#[tokio::test]
async fn offline_delete_and_restore_replay_in_order_as_owner() {
    let fixture = Fixture::new(true).await;
    fixture.server.lock().unwrap().offline = true;
    for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
        for restore in [false, true] {
            let asset = fixture.change(mode, restore).await.unwrap();
            assert_eq!(
                asset.is_archived,
                mode == DeleteBehavior::Archive && !restore
            );
            assert_eq!(asset.is_trashed, mode == DeleteBehavior::Trash && !restore);
        }
    }
    let pending = fixture.state.db.list_pending_mutations().unwrap();
    assert_eq!(pending.len(), 4);
    assert!(pending
        .iter()
        .all(|mutation| mutation.account_id == fixture.reader.id));
    assert_eq!(fixture.flush().await, 4);
    fixture.server.lock().unwrap().offline = false;
    assert_eq!(fixture.flush().await, 0);
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 4);
    assert!(writes.iter().all(|(_, user, _)| user == "owner"));
    assert_eq!(writes[0].2["visibility"], "archive");
    assert_eq!(writes[1].2["visibility"], "timeline");
    assert!(writes[2].0.starts_with("DELETE /api/assets "));
    assert!(writes[3].0.starts_with("POST /api/trash/restore/assets "));
    fixture.assert_unchanged();
}

#[tokio::test]
async fn edit_deletion_and_replay_restore_original_as_owner() {
    for offline in [false, true] {
        for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
            let fixture = Fixture::new(true).await;
            fixture.make_edit(mode);
            fixture.server.lock().unwrap().offline = offline;
            let asset = fixture.change(mode, false).await.unwrap();
            assert_eq!(asset.is_archived, mode == DeleteBehavior::Archive);
            assert_eq!(asset.is_trashed, mode == DeleteBehavior::Trash);
            assert!(
                !fixture
                    .state
                    .db
                    .get_asset_summary("original")
                    .unwrap()
                    .unwrap()
                    .is_stack_secondary
            );
            if offline {
                let pending = fixture.state.db.list_pending_mutations().unwrap();
                assert_eq!(pending.len(), 1);
                assert_eq!(pending[0].kind, "delete_version");
                assert_eq!(pending[0].account_id, fixture.reader.id);
                fixture.server.lock().unwrap().offline = false;
                assert_eq!(fixture.flush().await, 0);
            }
            let server = fixture.server.lock().unwrap();
            assert!(server.primary_restored);
            let writes = server.writes();
            assert_eq!(writes.len(), 2);
            assert!(writes.iter().all(|(_, user, _)| user == "owner"));
            assert!(writes[0].0.starts_with("PUT /api/stacks/stack "));
        }
    }
}

#[tokio::test]
async fn original_protection_runs_before_any_owner_request() {
    let fixture = Fixture::new(true).await;
    fixture.make_edit(DeleteBehavior::Archive);
    let error = change_deleted_state(
        "original".into(),
        DeleteBehavior::Archive,
        false,
        &fixture.state,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "The original version cannot be deleted");
    assert!(fixture.server.lock().unwrap().requests.is_empty());
    fixture.assert_unchanged();
}

#[tokio::test]
async fn refresh_keeps_shared_deleted_photo_under_cached_account() {
    for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
        let fixture = Fixture::new(true).await;
        fixture.server.lock().unwrap().reader_loses_access = true;
        fixture.change(mode, false).await.unwrap();
        refresh_deleted_assets_inner(mode, &fixture.state)
            .await
            .unwrap();
        let asset = fixture
            .state
            .db
            .get_asset_summary("photo")
            .unwrap()
            .unwrap();
        assert_eq!(asset.is_archived, mode == DeleteBehavior::Archive);
        assert_eq!(asset.is_trashed, mode == DeleteBehavior::Trash);
        assert_eq!(
            fixture.state.db.get_asset_account_id("photo").unwrap(),
            Some(fixture.reader.id.clone())
        );
    }
}

#[tokio::test]
async fn restore_finds_owner_when_trash_is_no_longer_readable_by_cached_account() {
    let fixture = Fixture::new(true).await;
    fixture.server.lock().unwrap().reader_loses_access = true;
    fixture.change(DeleteBehavior::Trash, false).await.unwrap();
    fixture.change(DeleteBehavior::Trash, true).await.unwrap();
    fixture.assert_unchanged();
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 2);
    assert!(writes.iter().all(|(_, user, _)| user == "owner"));
}

#[tokio::test]
async fn deleted_refresh_preserves_pending_shared_restore() {
    for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
        let fixture = Fixture::new(true).await;
        fixture.change(mode, false).await.unwrap();
        fixture.server.lock().unwrap().offline = true;
        fixture.change(mode, true).await.unwrap();
        fixture.server.lock().unwrap().offline = false;
        refresh_deleted_assets_inner(mode, &fixture.state)
            .await
            .unwrap();
        let asset = fixture
            .state
            .db
            .get_asset_summary("photo")
            .unwrap()
            .unwrap();
        assert!(!asset.is_archived && !asset.is_trashed);
        assert_eq!(fixture.state.db.count_pending_mutations().unwrap(), 1);
        assert_eq!(fixture.flush().await, 0);
        fixture.assert_unchanged();
    }
}

#[tokio::test]
async fn failed_owner_listing_preserves_cached_shared_deletion() {
    for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
        let fixture = Fixture::new(true).await;
        fixture.change(mode, false).await.unwrap();
        fixture.server.lock().unwrap().fail_owner_listing = true;
        let error = refresh_deleted_assets_inner(mode, &fixture.state)
            .await
            .unwrap_err();
        assert!(error.contains("500"), "{error}");
        let asset = fixture
            .state
            .db
            .get_asset_summary("photo")
            .unwrap()
            .unwrap();
        assert_eq!(asset.is_archived, mode == DeleteBehavior::Archive);
        assert_eq!(asset.is_trashed, mode == DeleteBehavior::Trash);
    }
}

#[tokio::test]
async fn deleted_refresh_reconciles_shared_remote_restore() {
    for mode in [DeleteBehavior::Archive, DeleteBehavior::Trash] {
        let fixture = Fixture::new(true).await;
        fixture.change(mode, false).await.unwrap();
        {
            let mut server = fixture.server.lock().unwrap();
            server.archived = false;
            server.trashed = false;
        }
        refresh_deleted_assets_inner(mode, &fixture.state)
            .await
            .unwrap();
        fixture.assert_unchanged();
    }
}

#[tokio::test]
async fn legacy_queued_version_deletion_still_resolves_owner() {
    let fixture = Fixture::new(true).await;
    fixture
        .state
        .db
        .enqueue_mutation(&fixture.reader.id, "photo", "delete_version", "{}")
        .unwrap();
    assert_eq!(fixture.flush().await, 0);
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, "owner");
    assert!(writes[0].0.starts_with("DELETE /api/assets "));
}

#[tokio::test]
async fn owned_photo_uses_primary_session_without_registry() {
    let mut fixture = Fixture::new(true).await;
    fixture.state.immich = fixture.state.accounts.client(&fixture.owner.id).unwrap();
    fixture.state.accounts.clear();
    fixture
        .state
        .db
        .open()
        .unwrap()
        .execute(
            "UPDATE accounts SET is_primary=CASE WHEN id=?1 THEN 1 ELSE 0 END",
            [&fixture.owner.id],
        )
        .unwrap();
    let asset = fixture
        .state
        .db
        .get_asset_summary("photo")
        .unwrap()
        .unwrap();
    fixture
        .state
        .db
        .upsert_assets(&fixture.owner.id, &[asset])
        .unwrap();
    fixture
        .change(DeleteBehavior::Archive, false)
        .await
        .unwrap();
    assert_eq!(fixture.server.lock().unwrap().writes()[0].1, "owner");
}

#[tokio::test]
async fn rejected_queued_deletion_is_dropped_without_trying_reader() {
    let fixture = Fixture::new(true).await;
    fixture.server.lock().unwrap().offline = true;
    fixture
        .change(DeleteBehavior::Archive, false)
        .await
        .unwrap();
    {
        let mut server = fixture.server.lock().unwrap();
        server.offline = false;
        server.reject_owner = true;
    }
    assert_eq!(fixture.flush().await, 0);
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, "owner");
}

#[tokio::test]
async fn every_metadata_mutation_and_offline_replay_uses_the_same_owner() {
    use crate::commands::{assets::*, time::*};
    for offline in [false, true] {
        let fixture = Fixture::new(true).await;
        fixture.server.lock().unwrap().offline = offline;
        let state = &fixture.state;
        assert!(
            update_asset_favorite_inner("photo".into(), true, state)
                .await
                .unwrap()
                .is_favorite
        );
        update_asset_rating_inner("photo".into(), Some(4), state)
            .await
            .unwrap();
        update_asset_description_inner(
            UpdateAssetDescriptionPayload {
                asset_id: "photo".into(),
                description: Some("new description".into()),
            },
            state,
        )
        .await
        .unwrap();
        update_asset_visibility_inner(
            UpdateAssetVisibilityPayload {
                asset_id: "photo".into(),
                visibility: "archive".into(),
            },
            state,
        )
        .await
        .unwrap();
        let shifted = shift_asset_times_inner(
            ShiftAssetTimesPayload {
                asset_ids: vec!["photo".into()],
                offset_seconds: 3600,
            },
            state,
        )
        .await
        .unwrap();
        assert!(shifted.failed.is_empty(), "{:?}", shifted.failed);
        assert_eq!(shifted.updated_count, usize::from(!offline));
        assert_eq!(shifted.queued_count, usize::from(offline));
        assert_eq!(
            state.db.count_pending_mutations().unwrap(),
            if offline { 5 } else { 0 }
        );
        if offline {
            assert!(fixture.server.lock().unwrap().writes().is_empty());
            fixture.server.lock().unwrap().offline = false;
            assert_eq!(fixture.flush().await, 0);
        }
        assert_eq!(
            state.db.get_asset_account_id("photo").unwrap(),
            Some(fixture.reader.id.clone())
        );
        let server = fixture.server.lock().unwrap();
        let writes = server.writes();
        assert_eq!(writes.len(), 5);
        assert!(writes.iter().all(|(_, user, _)| user == "owner"));
        assert!(server.favorite && server.archived);
        assert_eq!(server.rating, Some(4));
        assert_eq!(server.description.as_deref(), Some("new description"));
        assert_eq!(
            server.capture_time.as_deref(),
            Some("2026-11-01T11:00:00.000Z")
        );
    }
}

#[tokio::test]
async fn metadata_permission_rejection_never_queues_or_uses_reader() {
    use crate::commands::{assets::*, time::*};
    let fixture = Fixture::new(true).await;
    fixture.server.lock().unwrap().reject_owner = true;
    let state = &fixture.state;
    assert!(update_asset_favorite_inner("photo".into(), true, state)
        .await
        .is_err());
    assert!(update_asset_rating_inner("photo".into(), Some(4), state)
        .await
        .is_err());
    assert!(update_asset_description_inner(
        UpdateAssetDescriptionPayload {
            asset_id: "photo".into(),
            description: Some("rejected".into()),
        },
        state
    )
    .await
    .is_err());
    assert!(update_asset_visibility_inner(
        UpdateAssetVisibilityPayload {
            asset_id: "photo".into(),
            visibility: "archive".into(),
        },
        state
    )
    .await
    .is_err());
    let shifted = shift_asset_times_inner(
        ShiftAssetTimesPayload {
            asset_ids: vec!["photo".into()],
            offset_seconds: 3600,
        },
        state,
    )
    .await
    .unwrap();
    assert_eq!(shifted.failed.len(), 1);
    assert_eq!(shifted.updated_count + shifted.queued_count, 0);
    fixture.assert_unchanged();
    assert!(
        !state
            .db
            .get_asset_summary("photo")
            .unwrap()
            .unwrap()
            .is_favorite
    );
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 5);
    assert!(writes.iter().all(|(_, user, _)| user == "owner"));
}

#[tokio::test]
async fn photo_share_link_uses_album_contributor_owner_resolution() {
    let fixture = Fixture::new(true).await;
    let url = crate::commands::albums::create_share_link_for_assets_inner(
        &["photo".into()],
        &fixture.state,
    )
    .await
    .unwrap();
    assert_eq!(url, format!("{}/share/photos", fixture.owner.server_url));
    let writes = fixture.server.lock().unwrap().writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, "owner");
    assert_eq!(writes[0].2["assetIds"], json!(["photo"]));
}

#[tokio::test]
async fn sharing_fallback_is_not_allowed_for_owner_only_mutations() {
    let fixture = Fixture::new(false).await;
    fixture
        .state
        .db
        .open()
        .unwrap()
        .execute("DELETE FROM accounts WHERE id=?1", [&fixture.owner.id])
        .unwrap();
    let (account, _) = resolve_asset_account(
        &fixture.state,
        &fixture.reader.id,
        "photo",
        AssetAccess::Share,
    )
    .await
    .unwrap();
    assert_eq!(account.id, fixture.reader.id);
    let error = owner_client(&fixture.state, &fixture.reader.id, "photo")
        .await
        .err()
        .unwrap();
    assert_eq!(error, OWNER_NOT_SIGNED_IN);
    assert!(fixture.server.lock().unwrap().writes().is_empty());
}

#[tokio::test]
async fn local_file_archive_uses_shared_owner_routing_online_and_on_replay() {
    use crate::commands::sync::*;
    for (offline, rejected) in [(false, false), (true, false), (false, true)] {
        let fixture = Fixture::new(true).await;
        {
            let mut server = fixture.server.lock().unwrap();
            server.offline = offline;
            server.reject_owner = rejected;
        }
        fixture
            .state
            .db
            .upsert_unresolved_local_saved_asset_change(
                "photo",
                fixture.folder.join("missing.jpg").to_str().unwrap(),
                "missing.jpg",
                "deleted",
                "{}",
            )
            .unwrap();
        let change = fixture
            .state
            .db
            .list_unresolved_local_saved_asset_changes()
            .unwrap()
            .remove(0);
        let result = apply_saved_local_file_changes_inner(
            ApplySavedLocalFileChangesInput {
                change_ids: vec![change.id],
            },
            &fixture.state,
        )
        .await
        .unwrap();
        assert_eq!(
            result.failed_count,
            u32::from(rejected),
            "{:?}",
            result.errors
        );
        assert_eq!(result.applied_count, u32::from(!rejected));
        if rejected {
            fixture.assert_unchanged();
            assert_eq!(
                fixture
                    .state
                    .db
                    .list_unresolved_local_saved_asset_changes()
                    .unwrap()
                    .len(),
                1
            );
        } else {
            assert_eq!(
                fixture
                    .state
                    .db
                    .get_asset_summary("photo")
                    .unwrap()
                    .unwrap()
                    .visibility
                    .as_deref(),
                Some("archive")
            );
            assert!(fixture
                .state
                .db
                .list_unresolved_local_saved_asset_changes()
                .unwrap()
                .is_empty());
        }
        if offline {
            assert_eq!(fixture.state.db.count_pending_mutations().unwrap(), 1);
            fixture.server.lock().unwrap().offline = false;
            assert_eq!(fixture.flush().await, 0);
        }
        let writes = fixture.server.lock().unwrap().writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].1, "owner");
    }
}
