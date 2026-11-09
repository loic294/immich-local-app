//! Logged HTTP: every request the app sends to an Immich server is recorded in the activity log
//! with its method, path, status, duration and size.
//!
//! `LoggedClient` and `LoggedRequest` mirror the part of `reqwest` the app uses, so call sites keep
//! their builder chains and every `send()` is logged without each one having to remember. Only the
//! path is logged: queries and headers can carry credentials, and bodies are never read. The time
//! measured is the time until the response headers arrive; callers that stream a body report the
//! transfer themselves.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{IntoUrl, Method};
use serde::Serialize;
use tauri::http::Error as HttpError;

use super::activity_log::span::{format_bytes, format_ms, SLOW_HTTP_MS};
use super::activity_log::{self, ActivityLevel};

pub(crate) const HTTP_CATEGORY: &str = "http";

/// Uploads and downloads legitimately take a while, so they are only flagged when very slow.
pub(crate) const SLOW_TRANSFER_MS: u64 = 5_000;
/// Warnings and errors from chatty endpoints: how many are listed per window before summarising.
const FAILURES_PER_WINDOW: u32 = 3;
const FAILURE_WINDOW: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EndpointKind {
    /// Connectivity probe; `ImmichClient::ping` reports its own failures.
    Ping,
    /// Thumbnails and avatars: dozens per screen.
    Thumbnail,
    /// Original files and video playback: large bodies the caller reports per file.
    Download,
    /// `POST /api/assets`.
    Upload,
    /// `GET /api/assets/{id}` and `GET /api/stacks/{id}`: one per asset while a sync enriches a page.
    Detail,
    Api,
}

impl EndpointKind {
    fn name(self) -> &'static str {
        match self {
            Self::Ping => "ping",
            Self::Thumbnail => "thumbnail",
            Self::Download => "download",
            Self::Upload => "upload",
            Self::Detail => "detail",
            Self::Api => "api",
        }
    }

    /// Chatty endpoints log successes as debug and rate-limit their warnings and errors.
    fn is_chatty(self) -> bool {
        matches!(
            self,
            Self::Ping | Self::Thumbnail | Self::Download | Self::Detail
        )
    }

    fn slow_after_ms(self) -> u64 {
        match self {
            Self::Download | Self::Upload => SLOW_TRANSFER_MS,
            _ => SLOW_HTTP_MS,
        }
    }
}

fn looks_like_uuid(segment: &str) -> bool {
    segment.len() == 36
        && segment.char_indices().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

/// `…/assets/<uuid>` or `…/stacks/<uuid>`; named routes such as `/assets/statistics` don't match.
fn is_item_detail_path(path: &str) -> bool {
    let mut segments = path.rsplit('/');
    match (segments.next(), segments.next()) {
        (Some(id), Some("assets" | "stacks")) => looks_like_uuid(id),
        _ => false,
    }
}

pub(crate) fn classify_endpoint(method: &str, path: &str) -> EndpointKind {
    let path = path.trim_end_matches('/');
    if path.ends_with("/server/ping") {
        EndpointKind::Ping
    } else if path.ends_with("/thumbnail")
        || path.ends_with("/profile-image")
        || path.contains("/asset/thumbnail/")
    {
        EndpointKind::Thumbnail
    } else if path.ends_with("/original")
        || path.ends_with("/video/playback")
        || path.ends_with("/download")
        || path.ends_with("/download-original")
        || path.contains("/asset/file/")
        || path.contains("/asset/download/")
    {
        EndpointKind::Download
    } else if method == "POST" && path.ends_with("/api/assets") {
        EndpointKind::Upload
    } else if method == "GET" && is_item_detail_path(path) {
        EndpointKind::Detail
    } else {
        EndpointKind::Api
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HttpResult {
    Status {
        code: u16,
        bytes: Option<u64>,
    },
    /// No response arrived: DNS, connection, TLS or timeout.
    Failed(String),
    /// The caller dropped the future before a response arrived.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HttpRecord {
    pub(crate) level: ActivityLevel,
    pub(crate) message: String,
    pub(crate) slow: bool,
    /// A dead server must not bury the log in identical thumbnail failures.
    pub(crate) rate_limited: bool,
}

pub(crate) fn describe_http(
    method: &str,
    path: &str,
    kind: EndpointKind,
    elapsed_ms: u64,
    result: &HttpResult,
) -> HttpRecord {
    let slow = elapsed_ms >= kind.slow_after_ms();
    let took = format_ms(elapsed_ms);
    let quiet = if kind.is_chatty() {
        ActivityLevel::Debug
    } else {
        ActivityLevel::Info
    };
    let (level, message) = match result {
        HttpResult::Status { code, bytes } => {
            let size = bytes
                .map(|bytes| format!(" ({})", format_bytes(bytes)))
                .unwrap_or_default();
            let level = match *code {
                500.. => ActivityLevel::Error,
                400..=499 => ActivityLevel::Warn,
                _ if slow => ActivityLevel::Warn,
                _ => quiet,
            };
            (level, format!("{method} {path} -> {code} in {took}{size}"))
        }
        HttpResult::Failed(error) => {
            let level = if kind == EndpointKind::Ping {
                ActivityLevel::Debug
            } else {
                ActivityLevel::Error
            };
            (
                level,
                format!("{method} {path} failed after {took}: {error}"),
            )
        }
        HttpResult::Cancelled => (quiet, format!("{method} {path} cancelled after {took}")),
    };
    HttpRecord {
        rate_limited: kind.is_chatty() && level >= ActivityLevel::Warn,
        level,
        message,
        slow,
    }
}

/// Explains why a request got no response. The error's own `Display` repeats the full URL (query
/// included), so only its kind flags and its causes are used.
pub(crate) fn describe_transport_error(error: &reqwest::Error, url: &str) -> String {
    let mut kinds: Vec<&str> = Vec::new();
    if error.is_timeout() {
        kinds.push("timeout");
    }
    if error.is_connect() {
        kinds.push("connect");
    }
    if error.is_redirect() {
        kinds.push("redirect");
    }
    if error.is_body() {
        kinds.push("body");
    }
    if error.is_decode() {
        kinds.push("decode");
    }
    if error.is_builder() {
        kinds.push("builder");
    }
    if kinds.is_empty() {
        kinds.push("request");
    }

    let mut detail = String::new();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        // Causes often restate each other ("tcp connect error: X" then "X").
        if !text.is_empty() && !detail.contains(&text) {
            if !detail.is_empty() {
                detail.push_str(": ");
            }
            detail.push_str(&text);
        }
        source = cause.source();
    }

    let mut description = kinds.join("/");
    if !detail.is_empty() {
        description.push_str(": ");
        description.push_str(&detail);
    }
    if url.is_empty() {
        description
    } else {
        description.replace(url, "<url>")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateDecision {
    Log,
    /// The first suppressed problem of a window: say once that the rest are not listed.
    Announce,
    Skip,
}

#[derive(Default)]
struct FailureGate {
    windows: HashMap<&'static str, (Instant, u32)>,
}

impl FailureGate {
    fn check(&mut self, key: &'static str, now: Instant) -> GateDecision {
        let window = self.windows.entry(key).or_insert((now, 0));
        if now.duration_since(window.0) >= FAILURE_WINDOW {
            *window = (now, 0);
        }
        window.1 = window.1.saturating_add(1);
        match window.1 {
            count if count <= FAILURES_PER_WINDOW => GateDecision::Log,
            count if count == FAILURES_PER_WINDOW + 1 => GateDecision::Announce,
            _ => GateDecision::Skip,
        }
    }
}

fn gate() -> &'static Mutex<FailureGate> {
    static GATE: OnceLock<Mutex<FailureGate>> = OnceLock::new();
    GATE.get_or_init(Mutex::default)
}

struct Target {
    method: String,
    path: String,
    url: String,
    kind: EndpointKind,
}

impl Target {
    fn of(request: &reqwest::Request) -> Self {
        let method = request.method().as_str().to_string();
        let path = request.url().path().to_string();
        let kind = classify_endpoint(&method, &path);
        Self {
            method,
            path,
            url: request.url().as_str().to_string(),
            kind,
        }
    }
}

fn emit(target: &Target, elapsed_ms: u64, result: &HttpResult) {
    let record = describe_http(
        &target.method,
        &target.path,
        target.kind,
        elapsed_ms,
        result,
    );
    if record.rate_limited {
        let decision = gate()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .check(target.kind.name(), Instant::now());
        match decision {
            GateDecision::Log => {}
            GateDecision::Announce => {
                activity_log::warn(
                    HTTP_CATEGORY,
                    &format!(
                        "further {} problems within {}s are not listed individually",
                        target.kind.name(),
                        FAILURE_WINDOW.as_secs()
                    ),
                );
                return;
            }
            GateDecision::Skip => return,
        }
    }
    activity_log::record_timed(
        record.level,
        HTTP_CATEGORY,
        &record.message,
        elapsed_ms,
        record.slow,
    );
}

/// Records the request when it ends, or as cancelled if the caller drops the future first.
struct InFlight {
    target: Target,
    started: Instant,
    finished: bool,
}

impl InFlight {
    fn start(target: Target) -> Self {
        Self {
            target,
            started: Instant::now(),
            finished: false,
        }
    }

    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn finish(mut self, result: &reqwest::Result<reqwest::Response>) {
        self.finished = true;
        let outcome = match result {
            Ok(response) => HttpResult::Status {
                code: response.status().as_u16(),
                bytes: response.content_length(),
            },
            Err(error) => HttpResult::Failed(describe_transport_error(error, &self.target.url)),
        };
        emit(&self.target, self.elapsed_ms(), &outcome);
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if !self.finished {
            emit(&self.target, self.elapsed_ms(), &HttpResult::Cancelled);
        }
    }
}

#[derive(Clone)]
pub(crate) struct LoggedClient {
    inner: reqwest::Client,
}

impl LoggedClient {
    pub(crate) fn new(inner: reqwest::Client) -> Self {
        Self { inner }
    }

    pub(crate) fn request<U: IntoUrl>(&self, method: Method, url: U) -> LoggedRequest {
        LoggedRequest {
            inner: self.inner.request(method, url),
        }
    }

    pub(crate) fn get<U: IntoUrl>(&self, url: U) -> LoggedRequest {
        self.request(Method::GET, url)
    }

    pub(crate) fn post<U: IntoUrl>(&self, url: U) -> LoggedRequest {
        self.request(Method::POST, url)
    }

    pub(crate) fn put<U: IntoUrl>(&self, url: U) -> LoggedRequest {
        self.request(Method::PUT, url)
    }

    pub(crate) fn patch<U: IntoUrl>(&self, url: U) -> LoggedRequest {
        self.request(Method::PATCH, url)
    }

    pub(crate) fn delete<U: IntoUrl>(&self, url: U) -> LoggedRequest {
        self.request(Method::DELETE, url)
    }
}

pub(crate) struct LoggedRequest {
    inner: reqwest::RequestBuilder,
}

impl LoggedRequest {
    pub(crate) fn header<K, V>(self, key: K, value: V) -> Self
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<HttpError>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<HttpError>,
    {
        Self {
            inner: self.inner.header(key, value),
        }
    }

    pub(crate) fn headers(self, headers: HeaderMap) -> Self {
        Self {
            inner: self.inner.headers(headers),
        }
    }

    pub(crate) fn json<T: Serialize + ?Sized>(self, json: &T) -> Self {
        Self {
            inner: self.inner.json(json),
        }
    }

    pub(crate) fn query<T: Serialize + ?Sized>(self, query: &T) -> Self {
        Self {
            inner: self.inner.query(query),
        }
    }

    pub(crate) fn timeout(self, timeout: Duration) -> Self {
        Self {
            inner: self.inner.timeout(timeout),
        }
    }

    pub(crate) fn multipart(self, form: reqwest::multipart::Form) -> Self {
        Self {
            inner: self.inner.multipart(form),
        }
    }

    pub(crate) async fn send(self) -> reqwest::Result<reqwest::Response> {
        let (client, request) = self.inner.build_split();
        let request = match request {
            Ok(request) => request,
            Err(error) => {
                activity_log::error(
                    HTTP_CATEGORY,
                    &format!(
                        "request could not be built: {}",
                        describe_transport_error(&error, "")
                    ),
                );
                return Err(error);
            }
        };
        let in_flight = InFlight::start(Target::of(&request));
        let result = client.execute(request).await;
        in_flight.finish(&result);
        result
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};

    use super::*;

    fn describe(kind: EndpointKind, elapsed_ms: u64, result: HttpResult) -> HttpRecord {
        describe_http("GET", "/api/x", kind, elapsed_ms, &result)
    }

    fn status(code: u16) -> HttpResult {
        HttpResult::Status { code, bytes: None }
    }

    #[test]
    fn classifies_endpoints_by_path() {
        const ID: &str = "6f1e3a52-9c4b-4d0e-8a77-2b5d1c9e0f13";
        let cases = [
            ("GET", "/api/server/ping".to_string(), EndpointKind::Ping),
            (
                "GET",
                format!("/api/assets/{ID}/thumbnail"),
                EndpointKind::Thumbnail,
            ),
            (
                "GET",
                format!("/api/people/{ID}/thumbnail"),
                EndpointKind::Thumbnail,
            ),
            (
                "GET",
                format!("/api/users/{ID}/profile-image"),
                EndpointKind::Thumbnail,
            ),
            (
                "GET",
                format!("/api/asset/thumbnail/{ID}"),
                EndpointKind::Thumbnail,
            ),
            (
                "GET",
                format!("/api/assets/{ID}/original"),
                EndpointKind::Download,
            ),
            (
                "GET",
                format!("/api/assets/{ID}/video/playback"),
                EndpointKind::Download,
            ),
            (
                "GET",
                format!("/api/assets/{ID}/download-original"),
                EndpointKind::Download,
            ),
            (
                "GET",
                format!("/api/asset/file/{ID}"),
                EndpointKind::Download,
            ),
            ("POST", "/api/assets".to_string(), EndpointKind::Upload),
            (
                "POST",
                "/immich/api/assets/".to_string(),
                EndpointKind::Upload,
            ),
            ("GET", format!("/api/assets/{ID}"), EndpointKind::Detail),
            ("GET", format!("/api/stacks/{ID}"), EndpointKind::Detail),
            ("PUT", format!("/api/assets/{ID}"), EndpointKind::Api),
            ("DELETE", format!("/api/stacks/{ID}"), EndpointKind::Api),
            (
                "GET",
                "/api/assets/statistics".to_string(),
                EndpointKind::Api,
            ),
            ("GET", "/api/assets".to_string(), EndpointKind::Api),
            ("GET", format!("/api/albums/{ID}"), EndpointKind::Api),
            ("PUT", format!("/api/albums/{ID}/assets"), EndpointKind::Api),
            (
                "POST",
                "/api/search/metadata".to_string(),
                EndpointKind::Api,
            ),
        ];
        for (method, path, expected) in cases {
            assert_eq!(
                classify_endpoint(method, &path),
                expected,
                "{method} {path}"
            );
        }
    }

    #[test]
    fn successful_api_calls_are_info_with_status_time_and_size() {
        let record = describe_http(
            "GET",
            "/api/albums",
            EndpointKind::Api,
            123,
            &HttpResult::Status {
                code: 200,
                bytes: Some(1536),
            },
        );
        assert_eq!(record.message, "GET /api/albums -> 200 in 123ms (1.5 KB)");
        assert_eq!(record.level, ActivityLevel::Info);
        assert!(!record.slow);
        assert!(!record.rate_limited);
    }

    #[test]
    fn slow_api_calls_are_flagged_and_warn() {
        let record = describe(EndpointKind::Api, 2500, status(200));
        assert_eq!(record.message, "GET /api/x -> 200 in 2,500ms");
        assert_eq!(record.level, ActivityLevel::Warn);
        assert!(record.slow);

        let just_under = describe(EndpointKind::Api, SLOW_HTTP_MS - 1, status(200));
        assert!(!just_under.slow);
        assert_eq!(just_under.level, ActivityLevel::Info);
    }

    #[test]
    fn client_and_server_errors_are_warn_and_error() {
        assert_eq!(
            describe(EndpointKind::Api, 10, status(404)).level,
            ActivityLevel::Warn
        );
        assert_eq!(
            describe(EndpointKind::Api, 10, status(401)).level,
            ActivityLevel::Warn
        );
        assert_eq!(
            describe(EndpointKind::Api, 10, status(500)).level,
            ActivityLevel::Error
        );
        assert_eq!(
            describe(EndpointKind::Api, 10, status(503)).level,
            ActivityLevel::Error
        );
        assert!(!describe(EndpointKind::Api, 10, status(500)).rate_limited);
    }

    #[test]
    fn chatty_successes_are_debug_but_slow_or_failed_ones_are_rate_limited() {
        for kind in [
            EndpointKind::Ping,
            EndpointKind::Thumbnail,
            EndpointKind::Download,
            EndpointKind::Detail,
        ] {
            let quick = describe(kind, 20, status(200));
            assert_eq!(quick.level, ActivityLevel::Debug, "{kind:?}");
            assert!(!quick.rate_limited, "{kind:?}");

            let broken = describe(kind, 20, status(500));
            assert_eq!(broken.level, ActivityLevel::Error, "{kind:?}");
            assert!(broken.rate_limited, "{kind:?}");
        }
        let slow_thumbnail = describe(EndpointKind::Thumbnail, 1500, status(200));
        assert_eq!(slow_thumbnail.level, ActivityLevel::Warn);
        assert!(slow_thumbnail.slow && slow_thumbnail.rate_limited);
    }

    #[test]
    fn transfers_need_five_seconds_to_count_as_slow() {
        assert!(!describe(EndpointKind::Download, 4_999, status(200)).slow);
        assert!(describe(EndpointKind::Download, 5_000, status(200)).slow);
        assert!(!describe(EndpointKind::Upload, 4_999, status(201)).slow);
        let upload = describe(EndpointKind::Upload, 8_000, status(201));
        assert_eq!(upload.level, ActivityLevel::Warn);
        assert!(!upload.rate_limited);
    }

    #[test]
    fn transport_failures_are_errors_except_for_ping() {
        let failed = describe(
            EndpointKind::Api,
            5001,
            HttpResult::Failed("timeout: operation timed out".into()),
        );
        assert_eq!(failed.level, ActivityLevel::Error);
        assert_eq!(
            failed.message,
            "GET /api/x failed after 5,001ms: timeout: operation timed out"
        );
        assert!(failed.slow);

        let ping = describe(
            EndpointKind::Ping,
            40,
            HttpResult::Failed("connect: refused".into()),
        );
        assert_eq!(ping.level, ActivityLevel::Debug);
    }

    #[test]
    fn cancelled_requests_are_recorded_quietly() {
        let record = describe(EndpointKind::Api, 120, HttpResult::Cancelled);
        assert_eq!(record.message, "GET /api/x cancelled after 120ms");
        assert_eq!(record.level, ActivityLevel::Info);
        assert_eq!(
            describe(EndpointKind::Thumbnail, 120, HttpResult::Cancelled).level,
            ActivityLevel::Debug
        );
    }

    #[test]
    fn failure_gate_lists_a_few_then_announces_once_then_skips() {
        let mut gate = FailureGate::default();
        let start = Instant::now();
        for _ in 0..FAILURES_PER_WINDOW {
            assert_eq!(gate.check("thumbnail", start), GateDecision::Log);
        }
        assert_eq!(gate.check("thumbnail", start), GateDecision::Announce);
        for _ in 0..50 {
            assert_eq!(gate.check("thumbnail", start), GateDecision::Skip);
        }
    }

    #[test]
    fn failure_gate_windows_are_per_kind_and_roll_over() {
        let mut gate = FailureGate::default();
        let start = Instant::now();
        for _ in 0..=FAILURES_PER_WINDOW + 5 {
            gate.check("thumbnail", start);
        }
        assert_eq!(gate.check("download", start), GateDecision::Log);

        let later = start + FAILURE_WINDOW;
        assert_eq!(gate.check("thumbnail", later), GateDecision::Log);
        let almost = start + FAILURE_WINDOW - Duration::from_millis(1);
        assert_eq!(gate.check("download", almost), GateDecision::Log);
    }

    /// A port that was just free, so connecting to it is refused straight away.
    fn closed_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    /// Answers one request with `response` after reading its headers, then closes.
    fn serve_once(response: &'static str, pause: Duration) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0u8; 512];
            while !seen.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => seen.extend_from_slice(&chunk[..read]),
                }
            }
            std::thread::sleep(pause);
            let _ = stream.write_all(response.as_bytes());
        });
        (port, handle)
    }

    fn logged(token: &str) -> Vec<activity_log::ActivityEntry> {
        activity_log::entries_since(0, activity_log::MAX_ENTRIES_LIMIT)
            .entries
            .into_iter()
            .filter(|entry| entry.message.contains(token))
            .collect()
    }

    fn client() -> LoggedClient {
        LoggedClient::new(reqwest::Client::new())
    }

    #[tokio::test]
    async fn refused_connections_are_described_without_the_url_or_query() {
        let url = format!(
            "http://127.0.0.1:{}/api/albums?key=topsecret",
            closed_port()
        );
        let error = reqwest::Client::new().get(&url).send().await.unwrap_err();
        let text = describe_transport_error(&error, &url);
        assert!(text.starts_with("connect"), "{text}");
        assert!(!text.contains("topsecret"), "{text}");
        assert!(!text.contains("127.0.0.1"), "{text}");
    }

    #[tokio::test]
    async fn timeouts_are_described_as_timeouts() {
        let (port, server) = serve_once("", Duration::from_millis(600));
        let url = format!("http://127.0.0.1:{port}/api/albums");
        let error = reqwest::Client::new()
            .get(&url)
            .timeout(Duration::from_millis(100))
            .send()
            .await
            .unwrap_err();
        let text = describe_transport_error(&error, &url);
        assert!(text.starts_with("timeout"), "{text}");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn send_returns_the_response_untouched_and_logs_path_status_and_size() {
        let token = uuid::Uuid::new_v4().to_string();
        let (port, server) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
            Duration::ZERO,
        );
        let response = client()
            .get(format!(
                "http://127.0.0.1:{port}/api/test-{token}/albums?key=topsecret"
            ))
            .header("x-api-key", "topsecret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(response.text().await.unwrap(), "hello");
        server.join().unwrap();

        let entries = logged(&token);
        assert_eq!(entries.len(), 1, "{entries:?}");
        let entry = &entries[0];
        assert_eq!(entry.category, HTTP_CATEGORY);
        assert_eq!(entry.level, ActivityLevel::Info);
        assert!(
            entry
                .message
                .starts_with(&format!("GET /api/test-{token}/albums -> 200 in ")),
            "{}",
            entry.message
        );
        assert!(entry.message.ends_with("(5 B)"), "{}", entry.message);
        assert!(!entry.message.contains("topsecret"));
        assert!(entry.duration_ms.is_some());
    }

    #[tokio::test]
    async fn send_logs_failures_without_leaking_the_query() {
        let token = uuid::Uuid::new_v4().to_string();
        let url = format!(
            "http://127.0.0.1:{}/api/test-{token}/albums?key=topsecret",
            closed_port()
        );
        let error = client().post(&url).json(&"body").send().await.unwrap_err();
        assert!(error.is_connect());

        let entries = logged(&token);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].level, ActivityLevel::Error);
        assert!(
            entries[0]
                .message
                .starts_with(&format!("POST /api/test-{token}/albums failed after ")),
            "{}",
            entries[0].message
        );
        assert!(entries[0].message.contains("connect"));
        assert!(!entries[0].message.contains("topsecret"));
    }

    #[tokio::test]
    async fn dropping_the_future_logs_a_cancellation() {
        let token = uuid::Uuid::new_v4().to_string();
        let (port, server) = serve_once("", Duration::from_millis(400));
        let request = client().get(format!("http://127.0.0.1:{port}/api/test-{token}/albums"));
        let outcome = tokio::time::timeout(Duration::from_millis(80), request.send()).await;
        assert!(
            outcome.is_err(),
            "the server never answers, so the timeout must win"
        );
        server.join().unwrap();

        let entries = logged(&token);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert!(
            entries[0].message.contains("cancelled after"),
            "{}",
            entries[0].message
        );
    }

    #[tokio::test]
    async fn unbuildable_requests_return_the_builder_error_and_are_logged() {
        let error = client().get("not a url").send().await.unwrap_err();
        assert!(error.is_builder());
        assert!(
            !logged("request could not be built: builder").is_empty(),
            "a request that never left the app still needs an activity entry"
        );
    }

    fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, found);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }

    #[test]
    fn raw_reqwest_clients_stay_inside_the_logging_wrapper() {
        // These build an unlogged client on purpose: the wrapper itself, `ImmichClient` (which wraps
        // the one it builds) and the analytics call (which logs its own outcome).
        const ALLOWED: [&str; 3] = [
            "services/http_log.rs",
            "services/immich_client.rs",
            "commands/media.rs",
        ];
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&root, &mut files);

        let offenders: Vec<String> = files
            .iter()
            .filter_map(|path| {
                let relative = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if ALLOWED.contains(&relative.as_str()) {
                    return None;
                }
                let source = std::fs::read_to_string(path).unwrap();
                ["reqwest::Client::new(", "reqwest::Client::builder("]
                    .iter()
                    .any(|needle| source.contains(needle))
                    .then_some(relative)
            })
            .collect();
        assert!(
            offenders.is_empty(),
            "build requests through `LoggedClient` so they reach the activity log: {offenders:?}"
        );
    }
}
