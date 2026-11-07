use super::management::{delete_album_internal, rename_album_internal};
use super::*;
use crate::services::{
    account_manager::AccountManager,
    db::{Account, Database},
    immich_client::ImmichClient,
};
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct ServerState {
    requests: Vec<(String, Value)>,
    reject_status: Option<u16>,
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
    /// Two accounts on one mock server. Only the first (primary) account has a
    /// signed-in client; the second one models an account that needs re-login.
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
                let length = headers
                    .to_ascii_lowercase()
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: ").map(str::to_string))
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
                    data.requests.push((request.clone(), payload.clone()));
                    if request.starts_with("GET /api/server/ping ") {
                        (200, json!({"res": "pong"}))
                    } else if let Some(status) = data.reject_status {
                        (status, json!({"message": "Not found or no album access"}))
                    } else if request.starts_with("PATCH /api/albums/album ") {
                        (
                            200,
                            json!({"id": "album", "albumName": payload["albumName"]}),
                        )
                    } else if request.starts_with("DELETE /api/albums/album ") {
                        (204, Value::Null)
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
            std::env::temp_dir().join(format!("album-management-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Arc::new(Database::test_database(path.clone()).unwrap());
        let registry = Arc::new(AccountManager::new());
        let mut accounts = Vec::new();
        for user in ["first", "second"] {
            let account = db
                .upsert_account(&url, user, None, None, "api_key", user)
                .unwrap();
            if accounts.is_empty() {
                let client = Arc::new(ImmichClient::new());
                client
                    .hydrate_offline_session(&url, user, false, user, None)
                    .await
                    .unwrap();
                registry.insert(account.id.clone(), client);
            }
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

    fn seed_album(&self, account: usize) {
        let album: AlbumSummary = serde_json::from_value(json!({
            "id": "album", "albumName": "Old name", "ownerId": "first",
            "shared": true, "assetCount": 3
        }))
        .unwrap();
        self.state
            .db
            .upsert_albums(&self.accounts[account].id, &[album])
            .unwrap();
        self.state.db.record_recent_album("album").unwrap();
    }

    fn cached_name(&self) -> Option<String> {
        self.state
            .db
            .get_albums()
            .unwrap()
            .into_iter()
            .find(|album| album.id == "album")
            .map(|album| album.album_name)
    }

    fn requests(&self) -> Vec<String> {
        self.server
            .lock()
            .unwrap()
            .requests
            .iter()
            .map(|(request, _)| request.clone())
            .filter(|request| !request.starts_with("GET /api/server/ping "))
            .collect()
    }

    async fn go_offline(&self) {
        self.task.abort();
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn rename_saves_the_trimmed_name_on_the_server_and_in_the_cache() {
    let fixture = Fixture::new().await;
    fixture.seed_album(0);

    let saved = rename_album_internal("album", "  Summer 2025  ", &fixture.state)
        .await
        .unwrap();

    assert_eq!(saved, "Summer 2025");
    assert_eq!(fixture.cached_name().as_deref(), Some("Summer 2025"));
    let server = fixture.server.lock().unwrap();
    let (request, payload) = server.requests.last().unwrap();
    assert!(request.starts_with("PATCH /api/albums/album "), "{request}");
    assert_eq!(payload, &json!({"albumName": "Summer 2025"}));
    drop(server);
    let cached = fixture.state.db.get_albums().unwrap().remove(0);
    assert_eq!(cached.asset_count, Some(3));
    assert!(cached.shared);
}

#[tokio::test]
async fn rename_rejects_a_blank_name_before_contacting_the_server() {
    let fixture = Fixture::new().await;
    fixture.seed_album(0);

    let error = rename_album_internal("album", "   ", &fixture.state)
        .await
        .unwrap_err();

    assert_eq!(error, "Enter an album name.");
    assert!(fixture.requests().is_empty());
    assert_eq!(fixture.cached_name().as_deref(), Some("Old name"));
}

#[tokio::test]
async fn rename_while_offline_reports_offline_and_keeps_the_cached_name() {
    let fixture = Fixture::new().await;
    fixture.seed_album(0);
    fixture.go_offline().await;

    let error = rename_album_internal("album", "Summer 2025", &fixture.state)
        .await
        .unwrap_err();

    assert!(error.starts_with("offline:"), "{error}");
    assert_eq!(fixture.cached_name().as_deref(), Some("Old name"));
}

#[tokio::test]
async fn rename_refused_by_the_server_keeps_the_cached_name() {
    let fixture = Fixture::new().await;
    fixture.seed_album(0);
    fixture.server.lock().unwrap().reject_status = Some(400);

    let error = rename_album_internal("album", "Summer 2025", &fixture.state)
        .await
        .unwrap_err();

    assert!(!error.starts_with("offline:"), "{error}");
    assert!(error.contains("album.update"), "{error}");
    assert_eq!(fixture.cached_name().as_deref(), Some("Old name"));
}

#[tokio::test]
async fn delete_removes_the_album_from_the_server_and_every_cache() {
    let fixture = Fixture::new().await;
    fixture.seed_album(0);
    assert_eq!(fixture.state.db.get_recent_albums(10).unwrap().len(), 1);

    delete_album_internal("album", &fixture.state).await.unwrap();

    assert_eq!(fixture.requests(), vec!["DELETE /api/albums/album HTTP/1.1"]);
    assert_eq!(fixture.cached_name(), None);
    assert!(fixture.state.db.get_recent_albums(10).unwrap().is_empty());
}

#[tokio::test]
async fn delete_while_offline_keeps_the_album_and_never_queues_a_delete() {
    let fixture = Fixture::new().await;
    fixture.seed_album(0);
    fixture.go_offline().await;

    let error = delete_album_internal("album", &fixture.state)
        .await
        .unwrap_err();

    assert!(error.starts_with("offline:"), "{error}");
    assert_eq!(fixture.cached_name().as_deref(), Some("Old name"));
    assert_eq!(fixture.state.db.count_pending_mutations().unwrap(), 0);
}

#[tokio::test]
async fn delete_refused_by_the_server_keeps_the_album_cached() {
    let fixture = Fixture::new().await;
    fixture.seed_album(0);
    fixture.server.lock().unwrap().reject_status = Some(403);

    let error = delete_album_internal("album", &fixture.state)
        .await
        .unwrap_err();

    assert!(!error.starts_with("offline:"), "{error}");
    assert!(error.contains("album.delete"), "{error}");
    assert_eq!(fixture.cached_name().as_deref(), Some("Old name"));
    assert_eq!(fixture.state.db.get_recent_albums(10).unwrap().len(), 1);
}

#[tokio::test]
async fn albums_of_an_account_that_is_not_signed_in_are_never_sent_with_another_login() {
    let fixture = Fixture::new().await;
    fixture.seed_album(1);

    let rename = rename_album_internal("album", "Summer 2025", &fixture.state)
        .await
        .unwrap_err();
    let delete = delete_album_internal("album", &fixture.state)
        .await
        .unwrap_err();

    assert!(rename.contains("not signed in"), "{rename}");
    assert!(delete.contains("not signed in"), "{delete}");
    assert!(fixture.requests().is_empty());
    assert_eq!(fixture.cached_name().as_deref(), Some("Old name"));
}

#[tokio::test]
async fn albums_missing_from_the_cache_are_reported_without_contacting_the_server() {
    let fixture = Fixture::new().await;

    let error = delete_album_internal("album", &fixture.state)
        .await
        .unwrap_err();

    assert!(error.contains("no cached account"), "{error}");
    assert!(fixture.requests().is_empty());
}
