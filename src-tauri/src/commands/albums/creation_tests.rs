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
    viewers: HashSet<String>,
    assets: HashSet<String>,
    requests: Vec<(String, String, Value)>,
    reject_editor: bool,
    reject_editor_user: Option<String>,
    reject_asset: Option<String>,
    reject_contributor: Option<String>,
    asset_response: Option<Value>,
}

impl ServerState {
    fn album(&self) -> Value {
        let users: Vec<_> = std::iter::once(json!({
            "user": { "id": self.owner }, "role": "owner"
        }))
        .chain(self.editors.iter().map(|id| {
            json!({
                "user": { "id": id }, "role": "editor"
            })
        }))
        .chain(self.viewers.iter().map(|id| {
            json!({
                "user": { "id": id }, "role": "viewer"
            })
        }))
        .collect();
        json!({
            "id": "album", "albumName": "Test album", "albumUsers": users,
            "shared": !self.editors.is_empty() || !self.viewers.is_empty(),
            "assetCount": self.assets.len()
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
                    } else if request.starts_with("PUT /api/albums/album/users ") {
                        if data.reject_editor
                            || user != data.owner
                            || data.reject_editor_user.as_deref().is_some_and(|id| {
                                payload["albumUsers"][0]["userId"].as_str() == Some(id)
                            })
                        {
                            (403, json!({"message": "no permission to share"}))
                        } else if let Some(users) = payload["albumUsers"].as_array() {
                            for user in users {
                                assert_eq!(user["role"], "editor");
                                let id = user["userId"].as_str().unwrap();
                                if !data.viewers.contains(id) {
                                    data.editors.insert(id.to_string());
                                }
                            }
                            (200, data.album())
                        } else {
                            (400, json!({"message": "albumUsers must be an array"}))
                        }
                    } else if let Some(path) = request.strip_prefix("PUT /api/albums/album/user/") {
                        let id = path.split_whitespace().next().unwrap();
                        if data.reject_editor || user != data.owner {
                            (403, json!({"message": "no permission to share"}))
                        } else if payload["role"] == "viewer" && data.editors.remove(id) {
                            data.viewers.insert(id.to_string());
                            (204, Value::Null)
                        } else if data.viewers.remove(id) {
                            assert_eq!(payload, json!({"role": "editor"}));
                            data.editors.insert(id.to_string());
                            (204, Value::Null)
                        } else {
                            (400, json!({"message": "user has no role to change"}))
                        }
                    } else if request.starts_with("PUT /api/albums/album/assets ") {
                        if (user != data.owner && !data.editors.contains(&user))
                            || data.reject_contributor.as_deref() == Some(&user)
                        {
                            (
                                400,
                                json!({"message": "Not found or no albumAsset.create access"}),
                            )
                        } else {
                            let response = data.contribute(&user, &payload["ids"]);
                            (200, data.asset_response.clone().unwrap_or(response))
                        }
                    } else if request.starts_with("GET /api/albums/album?")
                        || request.starts_with("GET /api/albums/album ")
                    {
                        if user != data.owner
                            && !data.editors.contains(&user)
                            && !data.viewers.contains(&user)
                        {
                            (400, json!({"message": "Not found or no album.read access"}))
                        } else {
                            let mut album = data.album();
                            album["assets"] = json!(data
                                .assets
                                .iter()
                                .map(|id| json!({
                                    "id": id, "originalFileName": "photo.jpg"
                                }))
                                .collect::<Vec<_>>());
                            (200, album)
                        }
                    } else if request.starts_with("POST /api/albums/album/users ") {
                        (
                            404,
                            json!({"message": "Cannot POST /api/albums/album/users"}),
                        )
                    } else if request.starts_with("GET /api/albums?")
                        || request.starts_with("GET /api/albums ")
                    {
                        (200, json!([data.album()]))
                    } else if request.starts_with("GET /api/users ") {
                        (
                            200,
                            json!([
                                {"id": "first", "name": "First", "email": "first@example.com"},
                                {"id": "second", "name": "Second", "email": "second@example.com"},
                                {"id": "third", "name": "Third", "email": "third@example.com"}
                            ]),
                        )
                    } else {
                        (404, json!({"message": "unknown fixture endpoint"}))
                    }
                };
                let body = if status == 204 {
                    String::new()
                } else {
                    response.to_string()
                };
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

    fn seed_album(&self, owner: &str, cached_account: usize) {
        let mut server = self.server.lock().unwrap();
        server.owner = owner.to_string();
        let mut album = server.album();
        album["ownerId"] = json!(owner);
        let album: AlbumSummary = serde_json::from_value(album).unwrap();
        self.state
            .db
            .upsert_albums(&self.accounts[cached_account].id, &[album])
            .unwrap();
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
        .position(|(request, _, _)| request.starts_with("PUT /api/albums/album/assets "))
        .unwrap();
    let invites: Vec<_> = server
        .requests
        .iter()
        .enumerate()
        .filter(|(_, (request, _, _))| request.starts_with("PUT /api/albums/album/users "))
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
        .any(|(request, _, _)| request.starts_with("PUT /api/albums/album/assets ")));
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
        .find(|(request, _, _)| request.starts_with("PUT /api/albums/album/assets "))
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
        .any(|(request, _, _)| request.starts_with("PUT /api/albums/album/assets ")));
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

#[tokio::test]
async fn existing_album_adds_configured_editors_before_any_photo() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second", "remote-user"]);
    fixture.seed_album("first", 0);
    add_assets_to_album_internal(
        "album",
        &["first-photo".into(), "second-photo".into()],
        &fixture.state,
    )
    .await
    .unwrap();
    let server = fixture.server.lock().unwrap();
    assert_eq!(server.assets.len(), 2);
    assert_eq!(
        server.editors,
        HashSet::from(["second".into(), "remote-user".into()])
    );
    let first_photo = server
        .requests
        .iter()
        .position(|(request, _, _)| request.starts_with("PUT /api/albums/album/assets "))
        .unwrap();
    let invites: Vec<_> = server
        .requests
        .iter()
        .enumerate()
        .filter(|(_, (request, _, _))| request.starts_with("PUT /api/albums/album/users "))
        .collect();
    assert_eq!(invites.len(), 2);
    assert!(invites
        .iter()
        .all(|(index, (_, user, _))| *index < first_photo && user == "first"));
    assert!(!server
        .requests
        .iter()
        .any(|(request, _, _)| request.starts_with("POST ")));
}

#[tokio::test]
async fn existing_album_promotes_selected_viewers_using_actual_owner_and_retry_is_idempotent() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second", "remote-user"]);
    {
        let mut server = fixture.server.lock().unwrap();
        server.viewers.insert("second".into());
        server.editors.insert("unselected-existing-editor".into());
    }
    fixture.seed_album("first", 1);
    for _ in 0..2 {
        add_assets_to_album_internal(
            "album",
            &["first-photo".into(), "second-photo".into()],
            &fixture.state,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        fixture
            .state
            .db
            .get_album_account_id("album")
            .unwrap()
            .as_deref(),
        Some(fixture.accounts[0].id.as_str())
    );
    let server = fixture.server.lock().unwrap();
    assert_eq!(server.assets.len(), 2);
    assert!(server.viewers.is_empty());
    assert_eq!(
        server.editors,
        HashSet::from([
            "second".into(),
            "remote-user".into(),
            "unselected-existing-editor".into()
        ])
    );
    let sharing: Vec<_> = server
        .requests
        .iter()
        .filter(|(request, _, _)| request.starts_with("PUT /api/albums/album/user"))
        .collect();
    assert_eq!(
        sharing.len(),
        2,
        "Already-present editors must not be invited again"
    );
    assert!(sharing.iter().all(|(_, user, _)| user == "first"));
    assert!(sharing
        .iter()
        .any(|(request, _, _)| { request.starts_with("PUT /api/albums/album/user/second ") }));
}

#[tokio::test]
async fn failed_creation_can_be_retried_as_existing_album_without_recreating_it() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second", "remote-user"]);
    fixture.server.lock().unwrap().reject_editor = true;
    assert!(fixture
        .create(&["second-photo"])
        .await
        .unwrap_err()
        .contains("No photos were submitted"));
    let error = add_assets_to_album_internal("album", &["second-photo".into()], &fixture.state)
        .await
        .unwrap_err();
    assert!(error.contains("No photos were submitted"), "{error}");
    {
        let mut server = fixture.server.lock().unwrap();
        assert!(server.assets.is_empty());
        assert!(!server
            .requests
            .iter()
            .any(|(request, _, _)| { request.starts_with("PUT /api/albums/album/assets ") }));
        server.reject_editor = false;
    }
    add_assets_to_album_internal("album", &["second-photo".into()], &fixture.state)
        .await
        .unwrap();
    let server = fixture.server.lock().unwrap();
    assert_eq!(server.assets, HashSet::from(["second-photo".into()]));
    assert_eq!(
        server
            .requests
            .iter()
            .filter(|(request, _, _)| { request.starts_with("POST /api/albums ") })
            .count(),
        1
    );
}

#[tokio::test]
async fn existing_album_with_other_owner_keeps_its_sharing_unchanged() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second", "remote-user"]);
    fixture.seed_album("second", 1);
    add_assets_to_album_internal("album", &["second-photo".into()], &fixture.state)
        .await
        .unwrap();
    let server = fixture.server.lock().unwrap();
    assert!(server.editors.is_empty());
    assert_eq!(server.assets, HashSet::from(["second-photo".into()]));
    assert!(!server
        .requests
        .iter()
        .any(|(request, _, _)| { request.starts_with("PUT /api/albums/album/user") }));
}

#[tokio::test]
async fn existing_album_checks_all_contributor_roles_before_any_write() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["remote-user"]);
    fixture.seed_album("first", 0);
    let error = add_assets_to_album_internal(
        "album",
        &["first-photo".into(), "second-photo".into()],
        &fixture.state,
    )
    .await
    .unwrap_err();
    assert!(error.contains("second"), "{error}");
    assert!(error.contains("editor access"), "{error}");
    assert!(error.contains("No photos were submitted"), "{error}");
    assert!(fixture
        .server
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|(request, _, _)| { request.starts_with("GET ") }));
}

#[tokio::test]
async fn existing_album_cannot_grant_itself_access_when_configured_account_is_not_owner() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second", "remote-user"]);
    fixture
        .server
        .lock()
        .unwrap()
        .viewers
        .insert("first".into());
    fixture.seed_album("second", 0);
    let error = add_assets_to_album_internal(
        "album",
        &["first-photo".into(), "second-photo".into()],
        &fixture.state,
    )
    .await
    .unwrap_err();
    assert!(error.contains("editor access"), "{error}");
    assert!(fixture
        .server
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|(request, _, _)| { request.starts_with("GET ") }));
}

#[tokio::test]
async fn matching_owner_user_id_on_different_server_never_changes_sharing() {
    let fixture = Fixture::new().await;
    let foreign = fixture
        .state
        .db
        .upsert_account(
            "http://different.invalid",
            "first",
            None,
            None,
            "api_key",
            "fixture",
        )
        .unwrap();
    let mut settings = fixture.state.db.get_settings().unwrap();
    settings.album_creation = Some(AlbumCreationPreferences {
        owner_account_id: foreign.id,
        editor_user_ids: vec!["second".into()],
    });
    fixture.state.db.update_settings(&settings).unwrap();
    fixture.seed_album("first", 0);
    add_assets_to_album_internal("album", &["first-photo".into()], &fixture.state)
        .await
        .unwrap();
    assert!(fixture.server.lock().unwrap().editors.is_empty());
}

#[tokio::test]
async fn existing_album_api_key_rejection_is_reported_without_retrying_other_payloads() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second"]);
    fixture.seed_album("first", 0);
    fixture.server.lock().unwrap().reject_contributor = Some("second".into());
    let error = add_assets_to_album_internal("album", &["second-photo".into()], &fixture.state)
        .await
        .unwrap_err();
    assert!(error.contains("albumAsset.create"), "{error}");
    assert!(error.contains("API-key"), "{error}");
    let server = fixture.server.lock().unwrap();
    assert!(server.editors.contains("second"));
    assert!(server.assets.is_empty());
    assert_eq!(
        server
            .requests
            .iter()
            .filter(|(request, _, _)| {
                request.contains("/assets ") && !request.starts_with("GET ")
            })
            .count(),
        1
    );
    assert_eq!(
        fixture.state.db.get_albums().unwrap()[0].asset_count,
        Some(0)
    );
}

#[tokio::test]
async fn existing_album_partial_results_are_cached_and_retry_preserves_existing_photos() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second"]);
    fixture.seed_album("first", 0);
    let denied: AssetSummary = serde_json::from_value(json!({
        "id": "second-denied", "originalFileName": "denied.jpg"
    }))
    .unwrap();
    fixture
        .state
        .db
        .upsert_assets(&fixture.accounts[1].id, &[denied])
        .unwrap();
    fixture.server.lock().unwrap().reject_asset = Some("second-denied".into());
    let ids = ["second-photo".into(), "second-denied".into()];
    let error = add_assets_to_album_internal("album", &ids, &fixture.state)
        .await
        .unwrap_err();
    assert!(error.contains("no_permission"), "{error}");
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
    fixture.server.lock().unwrap().reject_asset = None;
    add_assets_to_album_internal("album", &ids, &fixture.state)
        .await
        .unwrap();
    assert_eq!(
        fixture.state.db.get_albums().unwrap()[0].asset_count,
        Some(2)
    );
    assert_eq!(fixture.server.lock().unwrap().assets.len(), 2);
}

#[tokio::test]
async fn offline_existing_album_does_not_change_sharing_or_cached_membership() {
    let fixture = Fixture::new().await;
    fixture.configure(0, &["second"]);
    fixture.seed_album("first", 0);
    fixture.task.abort();
    tokio::task::yield_now().await;
    let error = add_assets_to_album_internal("album", &["second-photo".into()], &fixture.state)
        .await
        .unwrap_err();
    assert!(error.starts_with("offline:"), "{error}");
    assert_eq!(
        fixture.state.db.get_albums().unwrap()[0].asset_count,
        Some(0)
    );
    assert!(fixture.server.lock().unwrap().editors.is_empty());
}

#[tokio::test]
async fn sharing_controls_use_album_details_and_only_the_owner_can_manage() {
    let fixture = Fixture::new().await;
    fixture
        .server
        .lock()
        .unwrap()
        .editors
        .insert("second".into());
    fixture.seed_album("first", 0);
    let owner = fixture
        .state
        .accounts
        .client(&fixture.accounts[0].id)
        .unwrap();
    let editor = fixture
        .state
        .accounts
        .client(&fixture.accounts[1].id)
        .unwrap();
    assert!(owner.can_manage_album_sharing("album").await.unwrap());
    assert!(!editor.can_manage_album_sharing("album").await.unwrap());
    let users = owner.get_album_share_users("album").await.unwrap();
    assert!(users
        .iter()
        .any(|user| user.id == "second" && user.role.as_deref() == Some("editor")));
    assert!(fixture
        .server
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|(request, _, _)| { request.starts_with("GET /api/albums/album?") }));
}

#[tokio::test]
async fn sharing_uses_the_signed_in_owner_when_the_cache_names_a_reader() {
    for (owner, reader, cached_account) in [("second", "first", 0), ("first", "second", 1)] {
        let fixture = Fixture::new().await;
        fixture.server.lock().unwrap().viewers.insert(reader.into());
        fixture.seed_album(owner, cached_account);

        let cached = fixture.state.account_and_client_for_album("album").1;
        assert!(!cached.can_manage_album_sharing("album").await.unwrap());

        let client = sharing_client(&fixture.state, "album");
        assert!(client.can_manage_album_sharing("album").await.unwrap());
        let users = client.get_album_share_users("album").await.unwrap();
        assert!(users.iter().any(|user| user.id == reader));
        let server = fixture.server.lock().unwrap();
        assert_eq!(server.requests.last().unwrap().1, owner);
    }
}

#[tokio::test]
async fn sharing_keeps_the_cached_account_when_the_owner_is_not_signed_in() {
    let fixture = Fixture::new().await;
    fixture
        .server
        .lock()
        .unwrap()
        .viewers
        .insert("first".into());
    fixture.seed_album("second", 0);
    fixture.state.accounts.remove(&fixture.accounts[1].id);

    let client = sharing_client(&fixture.state, "album");
    assert!(!client.can_manage_album_sharing("album").await.unwrap());
    assert_eq!(
        fixture.server.lock().unwrap().requests.last().unwrap().1,
        "first"
    );
}

#[tokio::test]
async fn sharing_keeps_the_cached_account_when_it_already_owns_the_album() {
    let fixture = Fixture::new().await;
    fixture.seed_album("first", 0);

    let client = sharing_client(&fixture.state, "album");
    assert!(client.can_manage_album_sharing("album").await.unwrap());
    assert_eq!(
        fixture.server.lock().unwrap().requests.last().unwrap().1,
        "first"
    );
}

#[tokio::test]
async fn album_user_roles_change_in_both_directions_through_the_signed_in_owner() {
    for (owner, reader, cached_account) in [("second", "first", 0), ("first", "second", 1)] {
        let fixture = Fixture::new().await;
        fixture.server.lock().unwrap().viewers.insert(reader.into());
        fixture.seed_album(owner, cached_account);

        sharing::update_user_role(&fixture.state, "album", reader, "editor")
            .await
            .unwrap();
        {
            let server = fixture.server.lock().unwrap();
            assert!(server.editors.contains(reader) && server.viewers.is_empty());
            assert_eq!(server.requests.last().unwrap().1, owner);
        }

        sharing::update_user_role(&fixture.state, "album", reader, "viewer")
            .await
            .unwrap();
        let server = fixture.server.lock().unwrap();
        assert!(server.viewers.contains(reader) && server.editors.is_empty());
        assert_eq!(server.requests.last().unwrap().1, owner);
    }
}

#[tokio::test]
async fn album_user_roles_other_than_editor_and_viewer_never_reach_the_server() {
    let fixture = Fixture::new().await;
    fixture.seed_album("first", 0);

    for role in ["owner", "admin", ""] {
        let error = sharing::update_user_role(&fixture.state, "album", "second", role)
            .await
            .unwrap_err();
        assert!(error.contains("editor or viewer"), "{error}");
    }

    assert!(fixture.server.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn album_user_role_refused_by_the_server_is_reported_and_changes_nothing() {
    let fixture = Fixture::new().await;
    fixture
        .server
        .lock()
        .unwrap()
        .viewers
        .insert("first".into());
    fixture.seed_album("second", 0);
    fixture.state.accounts.remove(&fixture.accounts[1].id);

    let error = sharing::update_user_role(&fixture.state, "album", "first", "editor")
        .await
        .unwrap_err();

    assert!(error.contains("update album user role failed"), "{error}");
    assert!(error.contains("403"), "{error}");
    assert!(fixture.server.lock().unwrap().viewers.contains("first"));
}

#[tokio::test]
async fn album_collaborators_are_listed_through_the_signed_in_owner() {
    for (owner, cached_account) in [("second", 0), ("first", 1)] {
        let fixture = Fixture::new().await;
        fixture.seed_album(owner, cached_account);

        let users = sharing::album_shareable_users(&fixture.state, "album")
            .await
            .unwrap();

        assert_eq!(users.len(), 3);
        let server = fixture.server.lock().unwrap();
        let (request, user, _) = server.requests.last().unwrap();
        assert!(request.starts_with("GET /api/users "), "{request}");
        assert_eq!(user, owner);
    }
}

#[tokio::test]
async fn album_collaborators_report_offline_instead_of_failing_opaquely() {
    let fixture = Fixture::new().await;
    fixture.seed_album("first", 0);
    fixture.task.abort();
    tokio::task::yield_now().await;

    let error = sharing::album_shareable_users(&fixture.state, "album")
        .await
        .unwrap_err();

    assert!(error.starts_with("offline:"), "{error}");
}

#[tokio::test]
async fn partial_editor_setup_preserves_shared_cache_and_retry_skips_confirmed_editors() {
    for existing in [false, true] {
        let fixture = Fixture::new().await;
        fixture.configure(0, &["second", "z-remote"]);
        fixture.server.lock().unwrap().reject_editor_user = Some("z-remote".into());
        if existing {
            fixture.seed_album("first", 0);
            assert!(add_assets_to_album_internal(
                "album",
                &["second-photo".into()],
                &fixture.state
            )
            .await
            .is_err());
        } else {
            assert!(fixture.create(&["second-photo"]).await.is_err());
        }
        let album = fixture.state.db.get_albums().unwrap().remove(0);
        assert!(album.shared);
        assert_eq!(album.asset_count, Some(0));
        {
            let mut server = fixture.server.lock().unwrap();
            assert!(server.assets.is_empty());
            assert_eq!(server.editors, HashSet::from(["second".into()]));
            server.reject_editor_user = None;
        }
        add_assets_to_album_internal("album", &["second-photo".into()], &fixture.state)
            .await
            .unwrap();
        let server = fixture.server.lock().unwrap();
        assert_eq!(server.assets, HashSet::from(["second-photo".into()]));
        assert_eq!(
            server
                .requests
                .iter()
                .filter(|(request, _, payload)| {
                    request.starts_with("PUT /api/albums/album/users ")
                        && payload["albumUsers"][0]["userId"] == "second"
                })
                .count(),
            1
        );
    }
}
