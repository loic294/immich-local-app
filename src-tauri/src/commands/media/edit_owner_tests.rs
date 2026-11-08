use super::super::process_media_uploads;
use super::OWNER_NOT_SIGNED_IN;
use crate::services::{
    account_manager::AccountManager,
    db::{Account, Database},
    immich_client::{AlbumSummary, AssetSummary, ImmichClient},
    media::UploadJob,
};
use crate::AppState;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Minimal Immich: API tokens equal user ids, and stacks/trash require the
/// caller to own every asset, as on a real server.
#[derive(Default)]
struct Server {
    owners: HashMap<String, String>,
    album_members: HashSet<String>,
    requests: Vec<(String, String, String)>,
}

impl Server {
    fn requests(&self, prefix: &str) -> Vec<(String, String)> {
        self.requests
            .iter()
            .filter(|(line, _, _)| line.starts_with(prefix))
            .map(|(_, user, body)| (user.clone(), body.clone()))
            .collect()
    }

    fn owns_all(&self, user: &str, ids: &Value) -> bool {
        ids.as_array().unwrap().iter().all(|id| {
            self.owners.get(id.as_str().unwrap()).map(String::as_str) == Some(user)
        })
    }

    fn respond(&mut self, line: &str, user: &str, body: &str) -> (u16, Value) {
        let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        if line.starts_with("GET /api/server/ping ") {
            (200, json!({"res": "pong"}))
        } else if let Some(path) = line.strip_prefix("GET /api/assets/") {
            let id = path.split_whitespace().next().unwrap();
            match self.owners.get(id) {
                Some(owner) => (
                    200,
                    json!({"id": id, "originalFileName": "photo.jpg", "ownerId": owner}),
                ),
                None => (404, json!({"message": "Asset not found"})),
            }
        } else if line.starts_with("POST /api/assets ") {
            let id = format!("{user}-edit");
            self.owners.insert(id.clone(), user.to_string());
            (201, json!({"id": id, "status": "created"}))
        } else if line.starts_with("DELETE /api/assets ") {
            if self.owns_all(user, &payload["ids"]) {
                (204, Value::Null)
            } else {
                (400, json!({"message": "Not found or no asset.delete access"}))
            }
        } else if line.starts_with("PUT /api/albums/album/assets ") {
            if !self.album_members.contains(user) {
                return (400, json!({"message": "Not found or no albumAsset.create access"}));
            }
            let results = payload["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| json!({"id": id, "success": true}))
                .collect();
            (200, Value::Array(results))
        } else if line.starts_with("POST /api/stacks ") {
            if self.owns_all(user, &payload["assetIds"]) {
                (201, json!({"id": "stack"}))
            } else {
                (400, json!({"message": "Not found or no asset.update access"}))
            }
        } else {
            (404, json!({"message": "unknown fixture endpoint"}))
        }
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

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

impl Fixture {
    /// Two accounts on one server: `reader` (primary) caches the original,
    /// while `owner` owns it on the server, like a shared or partner photo.
    async fn new(owner_signed_in: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = Arc::new(Mutex::new(Server::default()));
        server
            .lock()
            .unwrap()
            .owners
            .insert("original".into(), "owner".into());
        let data = server.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let line = head.lines().next().unwrap().to_string();
                let lower = head.to_ascii_lowercase();
                let header = |name: &str| {
                    lower
                        .lines()
                        .find_map(|l| l.strip_prefix(name))
                        .map(|v| v.trim().to_string())
                };
                let user = header("x-api-key: ").unwrap_or_default();
                let length = header("content-length: ").map_or(0, |v| v.parse().unwrap());
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                let body = String::from_utf8_lossy(&body).to_string();
                let (status, response) = {
                    let mut data = data.lock().unwrap();
                    data.requests.push((line.clone(), user.clone(), body.clone()));
                    data.respond(&line, &user, &body)
                };
                let response = if status == 204 { String::new() } else { response.to_string() };
                stream.write_all(format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                ).as_bytes()).await.unwrap();
            }
        });
        let folder = std::env::temp_dir().join(format!("edit-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let db = Arc::new(Database::test_database(folder.join("db.sqlite")).unwrap());
        let registry = Arc::new(AccountManager::new());
        let mut accounts = Vec::new();
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
                registry.insert(account.id.clone(), client);
            }
            accounts.push(account);
        }
        let owner = accounts.pop().unwrap();
        let reader = accounts.pop().unwrap();
        assert!(reader.is_primary && !owner.is_primary);
        let original: AssetSummary = serde_json::from_value(json!({
            "id": "original", "originalFileName": "photo.cr2"
        }))
        .unwrap();
        db.upsert_assets(&reader.id, &[original]).unwrap();
        db.open()
            .unwrap()
            .execute(
                "INSERT INTO album_assets(album_id,asset_id,account_id) VALUES('album','original',?1)",
                [&reader.id],
            )
            .unwrap();
        let state = AppState {
            db,
            immich: registry.client(&reader.id).unwrap(),
            accounts: registry,
            sync_cancel: Arc::new(AtomicBool::new(false)),
            sync_progress: Default::default(),
        };
        Self { state, reader, owner, server, task, folder }
    }

    /// Queues the edit like `export_media_edits`: under the original's cached account.
    fn queue_edit(&self) -> String {
        let path = self.folder.join("photo-edited-20260101.jpg");
        std::fs::write(&path, b"edited-fixture").unwrap();
        let path = path.to_string_lossy().into_owned();
        self.state
            .db
            .queue_media(&UploadJob {
                id: "job".into(),
                account_id: self.reader.id.clone(),
                local_path: path.clone(),
                checksum: "edited-checksum".into(),
                album_ids: vec!["album".into()],
                original_asset_id: Some("original".into()),
                server_asset_id: None,
                state: "queued".into(),
                error: None,
            })
            .unwrap();
        path
    }

    fn job(&self) -> UploadJob {
        self.state
            .db
            .media_uploads_for_edits(&["job".into()])
            .unwrap()
            .remove(0)
    }

    fn server(&self) -> std::sync::MutexGuard<'_, Server> {
        self.server.lock().unwrap()
    }
}

#[tokio::test]
async fn edit_cached_under_reader_is_uploaded_and_stacked_as_owner() {
    let fixture = Fixture::new(true).await;
    fixture.server().album_members.insert("owner".into());
    fixture.queue_edit();

    assert_eq!(process_media_uploads(&fixture.state).await.unwrap(), 1);

    let job = fixture.job();
    assert_eq!(job.state, "complete", "{:?}", job.error);
    assert_eq!(job.account_id, fixture.owner.id);
    assert_eq!(job.server_asset_id.as_deref(), Some("owner-edit"));
    let server = fixture.server();
    assert_eq!(server.requests("GET /api/assets/original ")[0].0, "reader");
    let uploads = server.requests("POST /api/assets ");
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0].0, "owner");
    assert_eq!(
        server.requests("PUT /api/albums/album/assets "),
        vec![("owner".to_string(), r#"{"ids":["owner-edit"]}"#.to_string())]
    );
    assert_eq!(
        server.requests("POST /api/stacks "),
        vec![(
            "owner".to_string(),
            r#"{"assetIds":["owner-edit","original"]}"#.to_string()
        )]
    );
    assert!(server.requests("DELETE ").is_empty());
    drop(server);
    assert_eq!(
        fixture.state.db.get_asset_account_id("owner-edit").unwrap(),
        Some(fixture.owner.id.clone())
    );
}

#[tokio::test]
async fn owner_not_signed_in_fails_before_uploading() {
    let fixture = Fixture::new(false).await;
    fixture.queue_edit();

    assert_eq!(process_media_uploads(&fixture.state).await.unwrap(), 0);

    let job = fixture.job();
    assert_eq!(job.state, "failed");
    assert_eq!(job.error.as_deref(), Some(OWNER_NOT_SIGNED_IN));
    assert_eq!(job.account_id, fixture.reader.id);
    let server = fixture.server();
    assert!(server.requests("POST /api/assets ").is_empty());
    assert!(server.requests("POST /api/stacks ").is_empty());
}

#[tokio::test]
async fn misplaced_upload_is_trashed_then_reuploaded_as_owner() {
    let fixture = Fixture::new(true).await;
    {
        let mut server = fixture.server();
        server.album_members.insert("owner".into());
        server.owners.insert("reader-edit".into(), "reader".into());
    }
    let path = fixture.queue_edit();
    let db = &fixture.state.db;
    db.open()
        .unwrap()
        .execute("UPDATE media_uploads SET server_asset_id='reader-edit'", [])
        .unwrap();
    let misplaced: AssetSummary = serde_json::from_value(json!({
        "id": "reader-edit", "originalFileName": "photo-edited-20260101.jpg"
    }))
    .unwrap();
    db.upsert_assets(&fixture.reader.id, &[misplaced]).unwrap();
    db.upsert_local_saved_asset(
        "reader-edit",
        Some("album"),
        &path,
        "photo-edited-20260101.jpg",
        "media_import",
        None,
        Some(14),
    )
    .unwrap();
    db.open()
        .unwrap()
        .execute(
            "INSERT INTO album_assets(album_id,asset_id,account_id) VALUES('album','reader-edit',?1)",
            [&fixture.reader.id],
        )
        .unwrap();

    assert_eq!(process_media_uploads(&fixture.state).await.unwrap(), 1);

    let job = fixture.job();
    assert_eq!(job.state, "complete", "{:?}", job.error);
    assert_eq!(job.account_id, fixture.owner.id);
    assert_eq!(job.server_asset_id.as_deref(), Some("owner-edit"));
    let server = fixture.server();
    assert_eq!(
        server.requests("DELETE /api/assets "),
        vec![(
            "reader".to_string(),
            r#"{"force":false,"ids":["reader-edit"]}"#.to_string()
        )]
    );
    assert_eq!(server.requests("POST /api/assets ")[0].0, "owner");
    assert_eq!(
        server.requests("POST /api/stacks ")[0].1,
        r#"{"assetIds":["owner-edit","original"]}"#
    );
    drop(server);
    assert_eq!(db.get_asset_account_id("reader-edit").unwrap(), None);
    assert!(db.media_album_ids("reader-edit").unwrap().is_empty());
    assert!(std::path::Path::new(&path).is_file());
    let saved: i64 = db
        .open()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM local_saved_assets WHERE asset_id='reader-edit'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(saved, 0);
}

#[tokio::test]
async fn edit_owned_by_job_account_keeps_its_account() {
    let fixture = Fixture::new(true).await;
    {
        let mut server = fixture.server();
        server.owners.insert("original".into(), "reader".into());
        server.album_members.insert("reader".into());
    }
    fixture.queue_edit();

    assert_eq!(process_media_uploads(&fixture.state).await.unwrap(), 1);

    let job = fixture.job();
    assert_eq!(job.state, "complete", "{:?}", job.error);
    assert_eq!(job.account_id, fixture.reader.id);
    let server = fixture.server();
    assert_eq!(server.requests("GET /api/assets/original ").len(), 1);
    assert_eq!(server.requests("POST /api/assets ")[0].0, "reader");
    assert_eq!(server.requests("POST /api/stacks ")[0].0, "reader");
}

#[tokio::test]
async fn album_add_falls_back_to_album_account_when_owner_is_rejected() {
    let fixture = Fixture::new(true).await;
    fixture.server().album_members.insert("reader".into());
    let album: AlbumSummary = serde_json::from_value(json!({
        "id": "album", "albumName": "Reader album", "assetCount": 1, "ownerId": "reader"
    }))
    .unwrap();
    fixture
        .state
        .db
        .upsert_albums(&fixture.reader.id, &[album])
        .unwrap();
    fixture.queue_edit();

    assert_eq!(process_media_uploads(&fixture.state).await.unwrap(), 1);

    let job = fixture.job();
    assert_eq!(job.state, "complete", "{:?}", job.error);
    let server = fixture.server();
    let users: Vec<_> = server
        .requests("PUT /api/albums/album/assets ")
        .into_iter()
        .map(|(user, _)| user)
        .collect();
    assert_eq!(users, vec!["owner", "reader"]);
    assert_eq!(server.requests("POST /api/stacks ")[0].0, "owner");
}
