use super::*;
use crate::commands::settings::AlbumCreationPreferences;
use crate::services::{
    account_manager::AccountManager,
    db::{Account, Database},
    immich_client::{AssetSummary, ImmichClient},
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct ServerState {
    owner: String,
    editors: HashSet<String>,
    assets: HashSet<String>,
    requests: Vec<(String, String, Value)>,
    reject_editor: bool,
    reject_asset: Option<String>,
    asset_response: Option<Value>,
}

impl ServerState {
    fn album(&self) -> Value {
        json!({
            "id": "album", "albumName": "Test album", "ownerId": self.owner,
            "shared": !self.editors.is_empty(), "assetCount": self.assets.len()
        })
    }

    fn contribute(&mut self, user: &str, ids: &Value) -> Value {
        Value::Array(
            ids.as_array()
                .unwrap()
                .iter()
                .map(|id| {
                    let id = id.as_str().unwrap();
                    let allowed = (user == self.owner || self.editors.contains(user))
                        && id.starts_with(&format!("{user}-"))
                        && self.reject_asset.as_deref() != Some(id);
                    if allowed {
                        if self.assets.insert(id.to_string()) {
                            json!({"id": id, "success": true})
                        } else {
                            json!({"id": id, "success": false, "error": "duplicate"})
                        }
                    } else {
                        json!({"id": id, "success": false, "error": "no_permission"})
                    }
                })
                .collect(),
        )
    }
}

struct Fixture {
    state: AppState,
    accounts: Vec<Account>,
    server: Arc<Mutex<ServerState>>,
    task: tokio::task::JoinHandle<()>,
    path: std::path::PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        std::fs::remove_file(&self.path).unwrap();
    }
}

impl Fixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = Arc::new(Mutex::new(ServerState::default()));
        let data = server.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    bytes.push(stream.read_u8().await.unwrap());
                }
                let headers = String::from_utf8(bytes).unwrap();
                let request = headers.lines().next().unwrap().to_string();
                let headers = headers.to_ascii_lowercase();
                let user = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("x-api-key: "))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .map(|value| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                let payload: Value = if body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap()
                };
                let (status, response) = {
                    let mut data = data.lock().unwrap();
                    data.requests
                        .push((request.clone(), user.clone(), payload.clone()));
                    if request.starts_with("GET /api/server/ping ") {
                        (200, json!({"res": "pong"}))
                    } else if let Some(path) = request.strip_prefix("GET /api/assets/") {
                        let id = path.split_whitespace().next().unwrap();
                        let owner = id.split('-').next().unwrap();
                        (
                            200,
                            json!({"id": id, "originalFileName": "photo.jpg", "ownerId": owner}),
                        )
                    } else if request.starts_with("POST /api/albums ") {
                        data.owner = user.clone();
                        data.contribute(&user, &payload["assetIds"]);
                        (201, data.album())
                    } else if request.starts_with("POST /api/albums/album/users ") {
                        if data.reject_editor {
                            (403, json!({"message": "no permission to share"}))
                        } else if let Some(users) = payload["albumUsers"].as_array() {
                            for user in users {
                                data.editors
                                    .insert(user["userId"].as_str().unwrap().to_string());
                            }
                            (200, data.album())
                        } else {
                            (400, json!({"message": "albumUsers must be an array"}))
                        }
                    } else if request.starts_with("PUT /api/albums/album/assets ") {
                        let response = data.contribute(&user, &payload["ids"]);
                        (200, data.asset_response.clone().unwrap_or(response))
                    } else if request.starts_with("GET /api/albums/album?") {
                        let mut album = data.album();
                        album["assets"] = json!(data
                            .assets
                            .iter()
                            .map(|id| json!({
                                "id": id, "originalFileName": "photo.jpg"
                            }))
                            .collect::<Vec<_>>());
                        (200, album)
                    } else if request.starts_with("GET /api/albums?")
                        || request.starts_with("GET /api/albums ")
                    {
                        (200, json!([data.album()]))
                    } else {
                        (404, json!({"message": "unknown fixture endpoint"}))
                    }
                };
                let body = response.to_string();
                stream.write_all(format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                ).as_bytes()).await.unwrap();
            }
        });
        let path =
            std::env::temp_dir().join(format!("album-creation-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Arc::new(Database::test_database(path.clone()).unwrap());
        let registry = Arc::new(AccountManager::new());
        let mut accounts = Vec::new();
        for user in ["first", "second"] {
            let account = db
                .upsert_account(&url, user, None, None, "api_key", user)
                .unwrap();
            let client = Arc::new(ImmichClient::new());
            client
                .hydrate_offline_session(&url, user, false, user, None)
                .await
                .unwrap();
            registry.insert(account.id.clone(), client);
            let asset: AssetSummary = serde_json::from_value(json!({
                "id": format!("{user}-photo"), "originalFileName": "photo.jpg"
            }))
            .unwrap();
            db.upsert_assets(&account.id, &[asset]).unwrap();
            accounts.push(account);
        }
        let state = AppState {
            db,
            immich: registry.client(&accounts[0].id).unwrap(),
            accounts: registry,
            sync_cancel: Arc::new(AtomicBool::new(false)),
            sync_progress: Default::default(),
        };
        Self {
            state,
            accounts,
            server,
            task,
            path,
        }
    }

    fn configure(&self, owner: usize, editors: &[&str]) {
        let mut settings = self.state.db.get_settings().unwrap();
        settings.album_creation = Some(AlbumCreationPreferences {
            owner_account_id: self.accounts[owner].id.clone(),
            editor_user_ids: editors.iter().map(|id| id.to_string()).collect(),
        });
        self.state.db.update_settings(&settings).unwrap();
    }

    async fn create(&self, ids: &[&str]) -> Result<AlbumSummary, String> {
        create_album_with_assets_internal(
            "Test album",
            &ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
            &self.state,
        )
        .await
    }
}

#[tokio::test]
async fn new_album_contains_photos_from_both_accounts() {
    let fixture = Fixture::new().await;
    let created = fixture
        .create(&["first-photo", "second-photo"])
        .await
        .unwrap();
    assert_eq!(created.asset_count, Some(2));
    assert!(created.shared);
    let (cached, _) = fixture
        .state
        .db
        .get_album_assets("album", 0, 100, None, None)
        .unwrap();
    assert_eq!(cached.len(), 2);
    let server = fixture.server.lock().unwrap();
    assert_eq!(
        server.assets,
        HashSet::from(["first-photo".into(), "second-photo".into()]),
        "Album creation must not silently omit photos owned by another account"
    );
}

#[tokio::test]
async fn selection_owned_only_by_another_account_does_not_create_an_empty_album() {
    let fixture = Fixture::new().await;
    assert_eq!(
        fixture.create(&["second-photo"]).await.unwrap().asset_count,
        Some(1)
    );
    assert!(fixture
        .server
        .lock()
        .unwrap()
        .assets
        .contains("second-photo"));
}

#[tokio::test]
async fn configured_owner_and_remote_editors_are_persisted_and_all_shared_before_contributions() {
    let fixture = Fixture::new().await;
    fixture.configure(1, &["first", "remote-user", "first", "second"]);
    let reopened = Database::test_database(fixture.path.clone()).unwrap();
    let settings = reopened.get_settings().unwrap();
    assert_eq!(
        settings.album_creation.unwrap().owner_account_id,
        fixture.accounts[1].id
    );
    assert!(
        fixture
            .state
            .db
            .get_primary_account()
            .unwrap()
            .unwrap()
            .is_primary
    );
    assert_eq!(
        fixture.state.db.get_primary_account().unwrap().unwrap().id,
        fixture.accounts[0].id
    );
    let created = fixture
        .create(&["first-photo", "second-photo", "first-photo"])
        .await
        .unwrap();
    assert_eq!(created.owner_id, "second");
    assert_eq!(created.asset_count, Some(2));
    assert_eq!(
        fixture
            .state
            .db
            .get_album_account_id("album")
            .unwrap()
            .unwrap(),
        fixture.accounts[1].id
    );
    let server = fixture.server.lock().unwrap();
    assert_eq!(
        server.editors,
        HashSet::from(["first".into(), "remote-user".into()])
    );
    let create = server
        .requests
        .iter()
        .find(|(request, _, _)| request.starts_with("POST /api/albums "))
        .unwrap();
    assert_eq!(create.1, "second");
    assert_eq!(create.2["assetIds"], json!([]));
    let first_contribution = server
        .requests
        .iter()
        .position(|(request, _, _)| request.starts_with("PUT "))
        .unwrap();
    let invites: Vec<_> = server
        .requests
        .iter()
        .enumerate()
        .filter(|(_, (request, _, _))| request.starts_with("POST /api/albums/album/users "))
        .collect();
    assert_eq!(invites.len(), 2);
    for (index, (_, user, payload)) in invites {
        assert!(index < first_contribution);
        assert_eq!(user, "second");
        assert_eq!(payload["albumUsers"][0]["role"], "editor");
    }
}

#[tokio::test]
async fn sharing_failure_stops_before_any_photo_submission() {
    let fixture = Fixture::new().await;
    fixture.server.lock().unwrap().reject_editor = true;
    let error = fixture
        .create(&["first-photo", "second-photo"])
        .await
        .unwrap_err();
    assert!(error.contains("was created"), "{error}");
    assert!(error.contains("No photos were submitted"), "{error}");
    let server = fixture.server.lock().unwrap();
    assert!(server.assets.is_empty());
    assert!(!server
        .requests
        .iter()
        .any(|(request, _, _)| request.starts_with("PUT ")));
    assert_eq!(
        server
            .requests
            .iter()
            .filter(|(request, _, _)| request.contains("/users "))
            .count(),
        1
    );
}

#[tokio::test]
async fn per_photo_rejections_are_errors_and_partial_membership_is_cached() {
    let fixture = Fixture::new().await;
    let asset: AssetSummary = serde_json::from_value(json!({
        "id": "second-denied", "originalFileName": "denied.jpg"
    }))
    .unwrap();
    fixture
        .state
        .db
        .upsert_assets(&fixture.accounts[1].id, &[asset])
        .unwrap();
    fixture.server.lock().unwrap().reject_asset = Some("second-denied".into());
    let error = fixture
        .create(&["second-photo", "second-denied"])
        .await
        .unwrap_err();
    assert!(error.contains("no_permission"), "{error}");
    assert!(error.contains("was created"), "{error}");
    assert_eq!(
        fixture.state.db.get_albums().unwrap()[0].asset_count,
        Some(1)
    );
    let (cached, _) = fixture
        .state
        .db
        .get_album_assets("album", 0, 100, None, None)
        .unwrap();
    assert_eq!(
        cached
            .iter()
            .map(|asset| asset.id.as_str())
            .collect::<Vec<_>>(),
        ["second-photo"]
    );
    let server = fixture.server.lock().unwrap();
    assert!(!server
        .requests
        .iter()
        .any(|(request, _, _)| request.starts_with("POST /api/albums/album/assets ")));
}

#[tokio::test]
async fn unselected_photo_owner_fails_before_creating_an_album() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["remote-user"]);
    assert!(fixture
        .create(&["second-photo"])
        .await
        .unwrap_err()
        .contains("Settings > Albums"));
    assert!(fixture
        .server
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|(request, _, _)| request.starts_with("GET ")));
}

#[tokio::test]
async fn shared_album_cache_attribution_is_not_mistaken_for_photo_ownership() {
    let fixture = Fixture::new().await;
    let asset: AssetSummary = serde_json::from_value(json!({
        "id": "second-photo", "originalFileName": "photo.jpg"
    }))
    .unwrap();
    fixture
        .state
        .db
        .upsert_assets(&fixture.accounts[0].id, &[asset])
        .unwrap();
    fixture.create(&["second-photo"]).await.unwrap();
    let server = fixture.server.lock().unwrap();
    let contribution = server
        .requests
        .iter()
        .find(|(request, _, _)| request.starts_with("PUT "))
        .unwrap();
    assert_eq!(contribution.1, "second");
    assert!(server.assets.contains("second-photo"));
}

#[tokio::test]
async fn missing_or_malformed_bulk_confirmations_never_report_success() {
    let fixture = Fixture::new().await;
    fixture.create(&[]).await.unwrap();
    let client = fixture
        .state
        .accounts
        .client(&fixture.accounts[0].id)
        .unwrap();
    for response in [
        json!({}),
        json!([]),
        json!([{"id": "first-photo"}]),
        json!([{"id": "different", "success": true}]),
    ] {
        fixture.server.lock().unwrap().asset_response = Some(response.clone());
        assert!(
            client
                .add_assets_to_album("album", &["first-photo".into()])
                .await
                .is_err(),
            "{response}"
        );
    }
}

#[tokio::test]
async fn legacy_preferences_remain_compatible_and_defaults_can_be_restored() {
    let fixture = Fixture::new().await;
    let defaults = fixture.state.db.get_settings().unwrap();
    assert!(defaults.album_creation.is_none());
    let mut json = serde_json::to_value(&defaults).unwrap();
    json.as_object_mut().unwrap().remove("albumCreation");
    let legacy: crate::commands::settings::Settings = serde_json::from_value(json).unwrap();
    assert!(legacy.album_creation.is_none());
    fixture.configure(1, &["remote-user"]);
    fixture.state.db.update_settings(&defaults).unwrap();
    assert!(fixture
        .state
        .db
        .get_settings()
        .unwrap()
        .album_creation
        .is_none());
}

#[tokio::test]
async fn missing_configured_owner_never_falls_back_to_primary() {
    let fixture = Fixture::new().await;
    fixture.configure(1, &[]);
    fixture
        .state
        .db
        .remove_account(&fixture.accounts[1].id)
        .unwrap();
    assert!(fixture
        .create(&[])
        .await
        .unwrap_err()
        .contains("owner account no longer exists"));
    assert!(fixture.server.lock().unwrap().requests.is_empty());
    let mut settings = fixture.state.db.get_settings().unwrap();
    settings.live_photo_autoplay = false;
    fixture.state.db.update_settings(&settings).unwrap();
}

#[tokio::test]
async fn missing_contributor_session_does_not_fall_back_to_owner() {
    let fixture = Fixture::new().await;
    fixture.state.accounts.remove(&fixture.accounts[1].id);
    assert!(fixture
        .create(&["second-photo"])
        .await
        .unwrap_err()
        .contains("not signed in"));
    assert!(fixture.server.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn cross_server_selection_is_rejected_without_creating_an_album() {
    let fixture = Fixture::new().await;
    let foreign = fixture
        .state
        .db
        .upsert_account(
            "http://different.invalid",
            "foreign",
            None,
            None,
            "api_key",
            "fixture",
        )
        .unwrap();
    let asset: AssetSummary =
        serde_json::from_value(json!({"id": "foreign-photo", "originalFileName": "photo.jpg"}))
            .unwrap();
    fixture
        .state
        .db
        .upsert_assets(&foreign.id, &[asset])
        .unwrap();
    assert!(fixture
        .create(&["first-photo", "foreign-photo"])
        .await
        .unwrap_err()
        .contains("different Immich servers"));
    assert!(fixture.server.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn offline_creation_leaves_cache_intact_and_settings_readable() {
    let fixture = Fixture::new().await;
    fixture.configure(1, &["remote-user"]);
    fixture.task.abort();
    tokio::task::yield_now().await;
    assert!(fixture
        .create(&[])
        .await
        .unwrap_err()
        .starts_with("offline:"));
    assert!(fixture.state.db.get_albums().unwrap().is_empty());
    assert!(fixture
        .state
        .db
        .get_settings()
        .unwrap()
        .album_creation
        .is_some());
}

#[tokio::test]
async fn import_can_create_empty_album_with_selected_owner_and_remote_collaborators() {
    let fixture = Fixture::new().await;
    fixture.configure(1, &["remote-user"]);
    assert_eq!(fixture.create(&[]).await.unwrap().asset_count, Some(0));
    let server = fixture.server.lock().unwrap();
    assert_eq!(server.owner, "second");
    assert!(server.editors.contains("remote-user"));
    assert!(!server
        .requests
        .iter()
        .any(|(request, _, _)| request.starts_with("PUT ")));
}

#[tokio::test]
async fn adding_already_present_photos_is_idempotent() {
    let fixture = Fixture::new().await;
    fixture.create(&["second-photo"]).await.unwrap();
    let client = fixture
        .state
        .accounts
        .client(&fixture.accounts[1].id)
        .unwrap();
    client
        .add_assets_to_album("album", &["second-photo".into()])
        .await
        .unwrap();
    assert_eq!(fixture.server.lock().unwrap().assets.len(), 1);
}

#[tokio::test]
async fn existing_album_additions_also_use_each_photos_owner() {
    let fixture = Fixture::new().await;
    fixture.configure(1, &["first", "remote-user"]);
    fixture.create(&[]).await.unwrap();
    add_assets_to_album_internal(
        "album",
        &["first-photo".into(), "second-photo".into()],
        &fixture.state,
    )
    .await
    .unwrap();
    assert_eq!(fixture.server.lock().unwrap().assets.len(), 2);
    assert_eq!(
        fixture.state.db.get_albums().unwrap()[0].asset_count,
        Some(2)
    );
}
