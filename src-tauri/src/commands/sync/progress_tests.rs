use super::*;
use crate::services::immich_client::AuthSession;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Duration};

struct Request {
    line: String,
    body: String,
    respond: oneshot::Sender<String>,
}

async fn next_request(requests: &mut mpsc::UnboundedReceiver<Request>, path: &str) -> Request {
    let request = timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        request.line.contains(path),
        "unexpected request: {}",
        request.line
    );
    request
}

async fn mock_server() -> (
    Arc<ImmichClient>,
    mpsc::UnboundedReceiver<Request>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Arc::new(ImmichClient::new());
    *client.session.lock().await = Some(AuthSession {
        server_url: format!("http://{}", listener.local_addr().unwrap()),
        access_token: "fixture".into(),
        refresh_token: None,
        user_id: "fixture".into(),
        user_name: None,
    });
    let (sender, receiver) = mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let sender = sender.clone();
            connections.spawn(async move {
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(stream.read_u8().await.unwrap());
                }
                let header = String::from_utf8(header).unwrap();
                let content_length = header.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                let mut body = vec![0; content_length];
                stream.read_exact(&mut body).await.unwrap();
                let (respond, response) = oneshot::channel();
                sender.send(Request {
                    line: header.lines().next().unwrap().to_string(),
                    body: String::from_utf8(body).unwrap(),
                    respond,
                }).unwrap();
                let response = response.await.unwrap();
                stream.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(), response
                ).as_bytes()).await.unwrap();
            });
        }
    });
    (client, receiver, server)
}

fn test_db() -> (Arc<Database>, std::path::PathBuf) {
    let folder = std::env::current_dir()
        .unwrap()
        .join(format!("sync-progress-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&folder).unwrap();
    let db = Arc::new(Database::test_database(folder.join("db.sqlite")).unwrap());
    db.init_sync_state(1000).unwrap();
    (db, folder)
}

fn status(db: &Database, progress: &SyncProgress) -> Value {
    serde_json::to_value(
        SyncStatusResponse::from(db.get_sync_state().unwrap())
            .with_preparation(&progress.preparation),
    )
    .unwrap()
}

#[tokio::test]
async fn full_sync_progress_reports_preparation_before_any_asset_page_and_per_photo() {
    let (client, mut requests, server) = mock_server().await;
    let (db, folder) = test_db();
    let progress = Arc::new(SyncProgress::default());
    let mut changes = progress.preparation.subscribe();
    let run = progress.try_start().unwrap();
    let sync_db = db.clone();
    let preparation = progress.preparation.clone();
    let sync = tokio::spawn(async move {
        let _run = run;
        sync_all_assets_background(
            vec![("first".into(), client.clone()), ("second".into(), client)],
            sync_db,
            0,
            0,
            false,
            Arc::new(AtomicBool::new(false)),
            preparation,
        )
        .await
    });

    for account_index in 1..=2 {
        let people = next_request(&mut requests, "/api/people?").await;
        let current = status(&db, &progress);
        assert_eq!(current["preparation"]["stage"], "people");
        assert_eq!(current["preparation"]["accountIndex"], account_index);
        assert_eq!(current["preparation"]["accountCount"], 2);
        assert_eq!(current["processedAssets"], 0);
        people
            .respond
            .send(r#"{"people":[],"hasNextPage":false}"#.into())
            .unwrap();

        let albums = next_request(&mut requests, "/api/albums ").await;
        assert_eq!(status(&db, &progress)["preparation"]["stage"], "albums");
        assert!(status(&db, &progress)["preparation"]["totalAlbums"].is_null());
        albums.respond.send(r#"[{"id":"album-a","albumName":"A","ownerId":"fixture"},{"id":"album-b","albumName":"B","ownerId":"fixture"}]"#.into()).unwrap();
        next_request(&mut requests, "/api/albums?shared=true")
            .await
            .respond
            .send("[]".into())
            .unwrap();

        let album = next_request(&mut requests, "/api/albums/album-a?").await;
        assert_eq!(status(&db, &progress)["preparation"]["totalAlbums"], 2);
        album.respond.send(r#"{"assets":[{"id":"photo-a","type":"IMAGE","originalFileName":"a.jpg"},{"id":"photo-b","type":"IMAGE","originalFileName":"b.jpg"}]}"#.into()).unwrap();
        let first = next_request(&mut requests, "/api/assets/photo-").await;
        let second = next_request(&mut requests, "/api/assets/photo-").await;
        assert_eq!(status(&db, &progress)["preparation"]["totalAlbumAssets"], 2);
        first.respond.send("{}".into()).unwrap();
        timeout(
            Duration::from_secs(5),
            changes.wait_for(|value| {
                value
                    .as_ref()
                    .is_some_and(|value| value.processed_album_assets == 1)
            }),
        )
        .await
        .unwrap()
        .unwrap();
        let current = status(&db, &progress);
        assert_eq!(current["preparation"]["processedAlbumAssets"], 1);
        assert_eq!(
            current["processedAssets"], 0,
            "preparation must not advance the resume cursor"
        );
        second.respond.send("{}".into()).unwrap();

        let empty_album = next_request(&mut requests, "/api/albums/album-b?").await;
        let current = status(&db, &progress);
        assert_eq!(current["preparation"]["completedAlbums"], 1);
        assert_eq!(current["preparation"]["processedAlbumAssets"], 0);
        assert!(current["preparation"]["totalAlbumAssets"].is_null());
        empty_album.respond.send(r#"{"assets":[]}"#.into()).unwrap();

        let scan = next_request(&mut requests, "/api/search/metadata").await;
        assert!(status(&db, &progress)["preparation"].is_null());
        assert_eq!(
            serde_json::from_str::<Value>(&scan.body).unwrap()["page"],
            1
        );
        scan.respond
            .send(r#"{"assets":{"items":[],"nextPage":null}}"#.into())
            .unwrap();
    }

    timeout(Duration::from_secs(5), sync)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!db.get_sync_state().unwrap().is_syncing);
    assert!(progress.preparation.borrow().is_none());
    server.abort();
    let _ = server.await;
    drop(db);
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn full_sync_progress_resume_skips_preparation_and_preserves_page_cursor() {
    let (client, mut requests, server) = mock_server().await;
    let (db, folder) = test_db();
    db.update_sync_progress(200).unwrap();
    let progress = Arc::new(SyncProgress::default());
    let run = progress.try_start().unwrap();
    let sync_db = db.clone();
    let preparation = progress.preparation.clone();
    let sync = tokio::spawn(async move {
        let _run = run;
        sync_all_assets_background(
            vec![("first".into(), client)],
            sync_db,
            2,
            200,
            true,
            Arc::new(AtomicBool::new(false)),
            preparation,
        )
        .await
    });
    let scan = next_request(&mut requests, "/api/search/metadata").await;
    assert_eq!(
        serde_json::from_str::<Value>(&scan.body).unwrap()["page"],
        3
    );
    let current = status(&db, &progress);
    assert!(current["preparation"].is_null());
    assert_eq!(current["processedAssets"], 200);
    scan.respond
        .send(r#"{"assets":{"items":[],"nextPage":null}}"#.into())
        .unwrap();
    timeout(Duration::from_secs(5), sync)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(db.get_sync_state().unwrap().processed_assets, 200);
    assert!(progress.try_start().is_some());
    server.abort();
    let _ = server.await;
    drop(db);
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn full_sync_progress_cancellation_stops_preparation_without_marking_complete() {
    let (client, mut requests, server) = mock_server().await;
    let (db, folder) = test_db();
    let progress = Arc::new(SyncProgress::default());
    let run = progress.try_start().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let sync_cancel = cancel.clone();
    let sync_db = db.clone();
    let preparation = progress.preparation.clone();
    let sync = tokio::spawn(async move {
        let _run = run;
        sync_all_assets_background(
            vec![("first".into(), client)],
            sync_db,
            0,
            0,
            true,
            sync_cancel,
            preparation,
        )
        .await
    });

    let people = next_request(&mut requests, "/api/people?").await;
    cancel.store(true, Ordering::SeqCst);
    db.cancel_sync().unwrap();
    assert!(status(&db, &progress)["preparation"].is_null());
    people
        .respond
        .send(r#"{"people":[],"hasNextPage":false}"#.into())
        .unwrap();
    timeout(Duration::from_secs(5), sync)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        requests.try_recv().is_err(),
        "cancelled sync must not start refreshing albums"
    );
    let state = db.get_sync_state().unwrap();
    assert!(!state.is_syncing);
    assert!(state.last_sync_completed_at.is_none());
    assert_eq!(state.processed_assets, 0);
    assert!(progress.preparation.borrow().is_none());
    assert!(progress.try_start().is_some());
    server.abort();
    let _ = server.await;
    drop(db);
    std::fs::remove_dir_all(folder).unwrap();
}
