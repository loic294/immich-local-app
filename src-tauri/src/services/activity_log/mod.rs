//! Activity log: a redacted, local-only record of what the app did, shown in the Activity Log window
//! and persisted (with rotation) so it survives a crash.
//!
//! Sources feed it through `record*`/`info`/`warn`/`error`, `span`/`watch`, the `log::` formatter
//! hook (`ingest_log_record`) and the webview (`ingest_frontend`). Everything is redacted and
//! size-capped here, so callers never need to worry about secrets in a message.
//!
//! Never use the `log::` macros inside this module: the logger's formatter feeds every record back
//! into `ingest_log_record`, so doing so would recurse. Use `eprintln!` for diagnostics instead.

pub mod buffer;
pub mod category;
pub mod entry;
pub mod redact;
pub mod span;
pub mod store;

use std::any::Any;
use std::cell::Cell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use buffer::{Buffer, Since};
pub use entry::{ActivityEntry, ActivityLevel, ActivitySource};
pub use span::{begin, span, track, Phases};
use store::Store;

/// Entries in this category are session dividers; only the app itself may create them.
pub const SESSION_CATEGORY: &str = "session";
pub const DEFAULT_ENTRIES_LIMIT: usize = 2000;
pub const MAX_ENTRIES_LIMIT: usize = 10_000;
const MAX_FRONTEND_BATCH: usize = 500;
const FRONTEND_PAST_TOLERANCE_MS: i64 = 24 * 60 * 60 * 1000;
const FRONTEND_FUTURE_TOLERANCE_MS: i64 = 60 * 1000;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1500);
const PANIC_FLUSH_TIMEOUT: Duration = Duration::from_millis(300);
const CLEAR_TIMEOUT: Duration = Duration::from_secs(2);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Where the activity log (and the regular app log) is written; shared with the log plugin setup.
pub fn log_dir() -> PathBuf {
    crate::cache_logs_dir().unwrap_or_else(|| std::env::temp_dir().join("immich-local-app-logs"))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

thread_local! {
    static IN_SUBMIT: Cell<bool> = const { Cell::new(false) };
}

/// Marks the current thread as inside `Log::submit` so a nested record (a panic hook firing inside
/// the logger, say) is dropped instead of deadlocking on the buffer lock or recursing.
struct ReentryGuard;

impl ReentryGuard {
    fn enter() -> Option<Self> {
        IN_SUBMIT
            .try_with(|flag| {
                if flag.get() {
                    None
                } else {
                    flag.set(true);
                    Some(Self)
                }
            })
            .ok()
            .flatten()
    }
}

impl Drop for ReentryGuard {
    fn drop(&mut self) {
        let _ = IN_SUBMIT.try_with(|flag| flag.set(false));
    }
}

struct Item<'a> {
    level: ActivityLevel,
    source: ActivitySource,
    category: &'a str,
    message: &'a str,
    timestamp_ms: i64,
    duration_ms: Option<u64>,
    slow: bool,
}

impl<'a> Item<'a> {
    fn rust(level: ActivityLevel, category: &'a str, message: &'a str) -> Self {
        Self {
            level,
            source: ActivitySource::Rust,
            category,
            message,
            timestamp_ms: now_ms(),
            duration_ms: None,
            slow: false,
        }
    }
}

struct Meta {
    app_version: String,
    os: &'static str,
    arch: &'static str,
    log_dir: PathBuf,
    session_started_ms: i64,
    pid: u32,
}

impl Meta {
    fn detect(app_version: &str) -> Self {
        Self {
            app_version: app_version.to_string(),
            os: os_label(),
            arch: std::env::consts::ARCH,
            log_dir: log_dir(),
            session_started_ms: now_ms(),
            pid: std::process::id(),
        }
    }
}

fn os_label() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

/// Facts about this run for the Activity Log window's copy header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub log_dir: String,
    pub session_started_ms: i64,
    pub pid: u32,
    pub verbose: bool,
}

/// One entry reported by the webview. Everything is optional-ish and re-validated before storing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendInput {
    #[serde(default)]
    pub timestamp_ms: Option<i64>,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub slow: bool,
}

struct Log {
    buffer: Mutex<Buffer>,
    verbose: AtomicBool,
    store: OnceLock<Store>,
    meta: OnceLock<Meta>,
    shut_down: AtomicBool,
    started: Instant,
}

impl Log {
    fn new() -> Self {
        Self {
            buffer: Mutex::new(Buffer::default()),
            verbose: AtomicBool::new(false),
            store: OnceLock::new(),
            meta: OnceLock::new(),
            shut_down: AtomicBool::new(false),
            started: Instant::now(),
        }
    }

    fn is_verbose(&self) -> bool {
        self.verbose.load(Ordering::Relaxed)
    }

    fn monotonic_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn start(&self, app_version: &str) {
        if self.meta.set(Meta::detect(app_version)).is_err() {
            return;
        }
        let Some(meta) = self.meta.get() else {
            return;
        };
        match Store::start(meta.log_dir.clone(), meta.session_started_ms) {
            Some(store) => {
                let _ = self.store.set(store);
            }
            None => {
                eprintln!("[activity_log] writer thread failed to start; entries stay in memory")
            }
        }
        let message = format!(
            "session started · app v{} · {} {} · pid {}",
            meta.app_version, meta.os, meta.arch, meta.pid
        );
        self.submit(Item::rust(ActivityLevel::Info, SESSION_CATEGORY, &message));
    }

    fn submit(&self, item: Item<'_>) {
        if item.level == ActivityLevel::Debug && !self.is_verbose() {
            return;
        }
        let Some(_guard) = ReentryGuard::enter() else {
            return;
        };
        let mut draft = ActivityEntry::draft(
            item.timestamp_ms,
            item.level,
            item.source,
            category::sanitize(item.category),
            redact::sanitize_message(item.message),
        );
        draft.duration_ms = item.duration_ms;
        draft.slow = item.slow;

        let now = self.monotonic_ms();
        let mut buffer = lock(&self.buffer);
        let pushed = buffer.push(draft, now);
        // Handing entries to the writer while the lock is held keeps disk order equal to id order.
        if let Some(store) = self.store.get() {
            for entry in pushed.summary.iter().chain(pushed.entry.iter()) {
                store.submit(entry);
            }
        }
    }

    fn ingest_record(&self, record: &log::Record) {
        if is_frontend_log_target(record.target()) {
            return;
        }
        let level = ActivityLevel::from_log(record.level());
        if level == ActivityLevel::Debug && !self.is_verbose() {
            return;
        }
        let message = record.args().to_string();
        let category = external_category(&category::from_log_record(record.target(), &message));
        self.submit(Item {
            level,
            source: ActivitySource::Rust,
            category: &category,
            message: &message,
            timestamp_ms: now_ms(),
            duration_ms: None,
            slow: false,
        });
    }

    fn ingest_frontend(&self, inputs: Vec<FrontendInput>) {
        let now = now_ms();
        for input in inputs.into_iter().take(MAX_FRONTEND_BATCH) {
            let category = external_category(&input.category);
            self.submit(Item {
                level: ActivityLevel::parse(&input.level),
                source: ActivitySource::Frontend,
                category: &category,
                message: &input.message,
                timestamp_ms: accept_timestamp(input.timestamp_ms, now),
                duration_ms: input.duration_ms,
                slow: input.slow,
            });
        }
    }

    fn since(&self, since_id: u64, limit: usize) -> Since {
        lock(&self.buffer).since(since_id, limit.clamp(1, MAX_ENTRIES_LIMIT))
    }

    fn clear(&self) {
        lock(&self.buffer).clear();
        if let Some(store) = self.store.get() {
            if !store.clear(CLEAR_TIMEOUT) {
                eprintln!("[activity_log] clearing the log file timed out");
            }
        }
    }

    fn flush(&self, timeout: Duration) {
        if let Some(store) = self.store.get() {
            store.flush(timeout);
        }
    }

    fn shutdown(&self) {
        if self.shut_down.swap(true, Ordering::SeqCst) {
            return;
        }
        self.submit(Item::rust(
            ActivityLevel::Info,
            SESSION_CATEGORY,
            "session ended (clean exit)",
        ));
        if let Some(store) = self.store.get() {
            if !store.shutdown(SHUTDOWN_TIMEOUT) {
                eprintln!(
                    "[activity_log] writer did not stop in time; the last entries may be lost"
                );
            }
        }
    }

    fn session_info(&self) -> SessionInfo {
        let detected;
        let meta = match self.meta.get() {
            Some(meta) => meta,
            None => {
                detected = Meta::detect("unknown");
                &detected
            }
        };
        SessionInfo {
            app_version: meta.app_version.clone(),
            os: meta.os.to_string(),
            arch: meta.arch.to_string(),
            log_dir: meta.log_dir.to_string_lossy().into_owned(),
            session_started_ms: meta.session_started_ms,
            pid: meta.pid,
            verbose: self.is_verbose(),
        }
    }
}

/// The webview's own console output reaches the log plugin with a `webview…` target; the frontend
/// capture already records it, so counting it again here would duplicate every line.
fn is_frontend_log_target(target: &str) -> bool {
    target.starts_with("webview")
}

/// Categories from untrusted sources (log tags, the webview) must not forge session dividers.
fn external_category(raw: &str) -> String {
    let category = category::sanitize(raw);
    if category == SESSION_CATEGORY {
        "app".to_string()
    } else {
        category
    }
}

/// A webview-supplied timestamp is kept only when it is plausible; otherwise the receive time wins.
fn accept_timestamp(candidate: Option<i64>, now: i64) -> i64 {
    match candidate {
        Some(ts)
            if ts >= now - FRONTEND_PAST_TOLERANCE_MS
                && ts <= now + FRONTEND_FUTURE_TOLERANCE_MS =>
        {
            ts
        }
        _ => now,
    }
}

fn describe_panic(
    location: Option<(&str, u32)>,
    thread: &str,
    payload: &(dyn Any + Send),
) -> String {
    let text = payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_string());
    match location {
        Some((file, line)) => format!("panic at {file}:{line} in thread '{thread}': {text}"),
        None => format!("panic in thread '{thread}': {text}"),
    }
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let message = describe_panic(
            info.location()
                .map(|location| (location.file(), location.line())),
            thread.name().unwrap_or("unnamed"),
            info.payload(),
        );
        let log = global();
        log.submit(Item::rust(ActivityLevel::Error, "panic", &message));
        log.flush(PANIC_FLUSH_TIMEOUT);
        previous(info);
    }));
}

static LOG: OnceLock<Log> = OnceLock::new();

fn global() -> &'static Log {
    LOG.get_or_init(Log::new)
}

/// Starts the session: opens the on-disk log, hooks panics and writes the session divider.
/// Call once, first thing in `main`. Safe to call again (it does nothing).
pub fn init(app_version: &str) {
    let log = global();
    log.start(app_version);
    if log.store.get().is_some() {
        install_panic_hook();
    }
}

/// Writes the closing session divider and waits (briefly) for the writer to finish.
pub fn shutdown() {
    global().shutdown();
}

pub fn record(level: ActivityLevel, category: &str, message: &str) {
    global().submit(Item::rust(level, category, message));
}

pub fn record_timed(
    level: ActivityLevel,
    category: &str,
    message: &str,
    duration_ms: u64,
    slow: bool,
) {
    global().submit(Item {
        duration_ms: Some(duration_ms),
        slow,
        ..Item::rust(level, category, message)
    });
}

pub fn info(category: &str, message: &str) {
    record(ActivityLevel::Info, category, message);
}

pub fn warn(category: &str, message: &str) {
    record(ActivityLevel::Warn, category, message);
}

pub fn error(category: &str, message: &str) {
    record(ActivityLevel::Error, category, message);
}

/// Called from the log plugin's formatter for every `log::` record the app emits.
pub fn ingest_log_record(record: &log::Record) {
    global().ingest_record(record);
}

pub fn ingest_frontend(inputs: Vec<FrontendInput>) {
    global().ingest_frontend(inputs);
}

pub fn entries_since(since_id: u64, limit: usize) -> Since {
    global().since(since_id, limit)
}

/// The newest `limit` entries of earlier sessions, oldest first.
pub fn history(limit: usize) -> Vec<ActivityEntry> {
    let limit = limit.clamp(1, store::HISTORY_LIMIT);
    global()
        .store
        .get()
        .map(|store| store.history(limit))
        .unwrap_or_default()
}

/// Wipes the in-memory buffer and every file on disk.
pub fn clear() {
    global().clear();
}

pub fn is_verbose() -> bool {
    global().is_verbose()
}

/// Session-scoped (never persisted); returns the new value.
pub fn set_verbose(enabled: bool) -> bool {
    let log = global();
    let previous = log.verbose.swap(enabled, Ordering::Relaxed);
    if previous != enabled {
        info(
            "activity_log",
            if enabled {
                "verbose logging enabled"
            } else {
                "verbose logging disabled"
            },
        );
    }
    enabled
}

pub fn session_info() -> SessionInfo {
    global().session_info()
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};

    /// A throwaway directory under the system temp dir, removed on drop.
    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("activity-log-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::TempDir;
    use super::*;

    fn messages(log: &Log) -> Vec<String> {
        log.since(0, MAX_ENTRIES_LIMIT)
            .entries
            .into_iter()
            .map(|entry| entry.message)
            .collect()
    }

    fn submit(log: &Log, level: ActivityLevel, category: &str, message: &str) {
        log.submit(Item::rust(level, category, message));
    }

    #[test]
    fn debug_entries_are_dropped_until_verbose_is_on() {
        let log = Log::new();
        submit(&log, ActivityLevel::Debug, "http", "chatty one");
        submit(&log, ActivityLevel::Info, "http", "kept one");
        log.verbose.store(true, Ordering::Relaxed);
        submit(&log, ActivityLevel::Debug, "http", "chatty two");
        log.verbose.store(false, Ordering::Relaxed);
        submit(&log, ActivityLevel::Debug, "http", "chatty three");
        assert_eq!(messages(&log), vec!["kept one", "chatty two"]);
    }

    #[test]
    fn messages_are_redacted_and_categories_sanitised_before_storing() {
        let log = Log::new();
        submit(
            &log,
            ActivityLevel::Warn,
            "HTTP Client!!",
            "login failed: password=hunter2hunter2",
        );
        let stored = log.since(0, 10).entries;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].category, "http-client");
        assert!(
            !stored[0].message.contains("hunter2"),
            "{}",
            stored[0].message
        );
        assert!(stored[0].message.contains(redact::REDACTED));
        assert_eq!(stored[0].source, ActivitySource::Rust);
    }

    #[test]
    fn ids_follow_submission_order_and_since_resumes() {
        let log = Log::new();
        for n in 1..=5 {
            submit(&log, ActivityLevel::Info, "sync", &format!("entry {n}"));
        }
        let all = log.since(0, 100);
        let ids: Vec<u64> = all.entries.iter().map(|entry| entry.id).collect();
        assert_eq!(ids, vec![1, 2, 3, 4, 5]);
        assert_eq!(all.last_id, 5);
        let rest = log.since(3, 100);
        assert_eq!(rest.entries.len(), 2);
        assert_eq!(rest.entries[0].message, "entry 4");
        assert_eq!(log.since(5, 100).entries.len(), 0);
    }

    #[test]
    fn durations_and_slow_flags_are_kept() {
        let log = Log::new();
        log.submit(Item {
            duration_ms: Some(1480),
            slow: true,
            ..Item::rust(
                ActivityLevel::Warn,
                "http",
                "GET /api/albums → 200 in 1,480ms",
            )
        });
        let stored = &log.since(0, 10).entries[0];
        assert_eq!(stored.duration_ms, Some(1480));
        assert!(stored.slow);
    }

    #[test]
    fn clear_empties_the_buffer_but_ids_keep_increasing() {
        let log = Log::new();
        submit(&log, ActivityLevel::Info, "sync", "before");
        log.clear();
        assert!(messages(&log).is_empty());
        submit(&log, ActivityLevel::Info, "sync", "after");
        let stored = log.since(0, 10).entries;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, 2);
    }

    #[test]
    fn nested_records_on_one_thread_are_dropped() {
        let outer = ReentryGuard::enter();
        assert!(outer.is_some());
        assert!(ReentryGuard::enter().is_none());
        let log = Log::new();
        submit(&log, ActivityLevel::Info, "sync", "swallowed");
        drop(outer);
        assert!(messages(&log).is_empty());
        submit(&log, ActivityLevel::Info, "sync", "recorded");
        assert_eq!(messages(&log), vec!["recorded"]);
    }

    #[test]
    fn log_records_get_a_tag_category_and_skip_webview_targets() {
        let log = Log::new();
        let record = |target: &str, level: log::Level, args: std::fmt::Arguments<'_>| {
            log.ingest_record(
                &log::Record::builder()
                    .args(args)
                    .level(level)
                    .target(target)
                    .build(),
            );
        };
        record(
            "immich_local_app::commands::sync",
            log::Level::Info,
            format_args!("[sync] page 3 fetched"),
        );
        record(
            "immich_local_app::services::db",
            log::Level::Warn,
            format_args!("slow lock"),
        );
        record(
            "webview:index.js:12:3",
            log::Level::Info,
            format_args!("[ui] duplicate of frontend capture"),
        );
        record(
            "immich_local_app::commands::sync",
            log::Level::Debug,
            format_args!("[sync] debug is gated"),
        );
        let stored = log.since(0, 10).entries;
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].category, "sync");
        assert_eq!(stored[0].level, ActivityLevel::Info);
        assert_eq!(stored[0].message, "[sync] page 3 fetched");
        assert_eq!(stored[1].category, "db");
        assert_eq!(stored[1].level, ActivityLevel::Warn);
    }

    #[test]
    fn untrusted_sources_cannot_forge_session_dividers() {
        let log = Log::new();
        log.ingest_frontend(vec![FrontendInput {
            level: "info".into(),
            category: "session".into(),
            message: "[session] restored from cache while offline".into(),
            ..FrontendInput::default()
        }]);
        log.ingest_record(
            &log::Record::builder()
                .args(format_args!("[session] hello"))
                .level(log::Level::Info)
                .target("immich_local_app")
                .build(),
        );
        let stored = log.since(0, 10).entries;
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().all(|entry| entry.category == "app"));
        assert_eq!(stored[0].source, ActivitySource::Frontend);
    }

    #[test]
    fn frontend_batches_are_validated_and_capped() {
        let log = Log::new();
        let now = now_ms();
        let mut batch = vec![
            FrontendInput {
                timestamp_ms: Some(now - 5_000),
                level: "WARNING".into(),
                category: "ui".into(),
                message: "click".into(),
                duration_ms: Some(700),
                slow: true,
            },
            FrontendInput {
                timestamp_ms: Some(now + 3_600_000),
                level: "nonsense".into(),
                category: "".into(),
                message: "future timestamp".into(),
                ..FrontendInput::default()
            },
        ];
        batch.extend((0..600).map(|n| FrontendInput {
            level: "info".into(),
            category: "ui".into(),
            message: format!("bulk {n}"),
            ..FrontendInput::default()
        }));
        log.ingest_frontend(batch);
        let stored = log.since(0, MAX_ENTRIES_LIMIT).entries;
        assert_eq!(stored.len(), MAX_FRONTEND_BATCH);
        assert_eq!(stored[0].level, ActivityLevel::Warn);
        assert_eq!(stored[0].timestamp_ms, now - 5_000);
        assert_eq!(stored[0].duration_ms, Some(700));
        assert!(stored[0].slow);
        assert_eq!(stored[0].source, ActivitySource::Frontend);
        assert_eq!(stored[1].level, ActivityLevel::Info);
        assert_eq!(stored[1].category, "app");
        assert!(
            stored[1].timestamp_ms <= now_ms() + 1000,
            "implausible timestamps fall back to now"
        );
    }

    #[test]
    fn timestamps_outside_the_tolerance_are_replaced() {
        let now = 1_700_000_000_000;
        assert_eq!(accept_timestamp(None, now), now);
        assert_eq!(accept_timestamp(Some(now - 1000), now), now - 1000);
        assert_eq!(accept_timestamp(Some(now + 30_000), now), now + 30_000);
        assert_eq!(accept_timestamp(Some(now + 120_000), now), now);
        assert_eq!(
            accept_timestamp(Some(now - 2 * FRONTEND_PAST_TOLERANCE_MS), now),
            now
        );
        assert_eq!(accept_timestamp(Some(0), now), now);
    }

    #[test]
    fn panic_messages_describe_location_thread_and_payload() {
        let str_payload: Box<dyn Any + Send> = Box::new("boom");
        let string_payload: Box<dyn Any + Send> = Box::new(String::from("formatted boom"));
        let other_payload: Box<dyn Any + Send> = Box::new(42_u32);
        assert_eq!(
            describe_panic(Some(("src/a.rs", 7)), "main", str_payload.as_ref()),
            "panic at src/a.rs:7 in thread 'main': boom"
        );
        assert_eq!(
            describe_panic(None, "worker", string_payload.as_ref()),
            "panic in thread 'worker': formatted boom"
        );
        assert!(
            describe_panic(None, "t", other_payload.as_ref()).ends_with("non-string panic payload")
        );
    }

    #[test]
    fn entries_reach_disk_in_id_order_even_with_concurrent_writers() {
        let temp = TempDir::new();
        let log = std::sync::Arc::new(Log::new());
        let store = Store::start(temp.path().to_path_buf(), 4242).unwrap();
        assert!(log.store.set(store).is_ok());

        let workers: Vec<_> = (0..4)
            .map(|worker| {
                let log = std::sync::Arc::clone(&log);
                std::thread::spawn(move || {
                    for n in 0..50 {
                        submit(
                            &log,
                            ActivityLevel::Info,
                            "sync",
                            &format!("worker {worker} entry {n}"),
                        );
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(log.store.get().unwrap().flush(Duration::from_secs(5)));

        let text = std::fs::read_to_string(temp.path().join(store::FILE_NAME)).unwrap();
        let ids: Vec<u64> = text
            .lines()
            .map(|line| store::decode_line(line).unwrap().0.id)
            .collect();
        assert_eq!(ids, (1..=200).collect::<Vec<u64>>());

        let history = store::read_history(temp.path(), 1, 10);
        assert_eq!(history.len(), 10, "another session's lines are history");
        assert!(
            store::read_history(temp.path(), 4242, 10).is_empty(),
            "the live session is not"
        );
    }

    #[test]
    fn session_info_reports_the_running_process() {
        let log = Log::new();
        log.verbose.store(true, Ordering::Relaxed);
        let info = log.session_info();
        assert_eq!(info.app_version, "unknown");
        assert_eq!(info.pid, std::process::id());
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert!(info.verbose);
        assert!(!info.log_dir.is_empty());
    }

    #[test]
    fn shutdown_is_recorded_once() {
        let log = Log::new();
        log.shutdown();
        log.shutdown();
        let stored = log.since(0, 10).entries;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].category, SESSION_CATEGORY);
        assert_eq!(stored[0].message, "session ended (clean exit)");
    }
}
