//! Persistent JSON-lines storage for the activity log, with size-based rotation.
//!
//! Entries are handed to a dedicated writer thread through a bounded channel so logging never blocks
//! on disk I/O. Each line is the entry JSON plus a trailing `"session"` field (the session start
//! time) so history can skip the live session and tell launches apart.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::entry::{ActivityEntry, ActivityLevel, ActivitySource};

pub const FILE_NAME: &str = "activity-log.jsonl";
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const ROTATED_FILES: usize = 3;
pub const HISTORY_LIMIT: usize = 5000;
const CHANNEL_CAPACITY: usize = 8192;
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const FLUSH_THRESHOLD_BYTES: usize = 64 * 1024;
/// After a failed rotation, keep appending this much more before trying again.
const ROTATION_RETRY_BACKOFF_BYTES: u64 = 256 * 1024;
const SESSION_KEY: &str = "\"session\":";

fn base_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn rotated_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("{FILE_NAME}.{index}"))
}

pub fn encode_line(entry: &ActivityEntry, session: i64) -> Option<String> {
    let mut json = serde_json::to_string(entry).ok()?;
    if !json.ends_with('}') {
        return None;
    }
    json.pop();
    json.push_str(&format!(",{SESSION_KEY}{session}}}\n"));
    Some(json)
}

/// Reads the trailing session field without parsing the whole line. Message text is JSON-escaped, so
/// an unescaped `"session":` can only be the real field, and `rfind` picks the last one anyway.
fn line_session(line: &str) -> Option<i64> {
    let body = line.trim_end().strip_suffix('}')?;
    let at = body.rfind(SESSION_KEY)?;
    body[at + SESSION_KEY.len()..].parse().ok()
}

pub fn decode_line(line: &str) -> Option<(ActivityEntry, i64)> {
    let session = line_session(line)?;
    let entry = serde_json::from_str::<ActivityEntry>(line.trim()).ok()?;
    Some((entry, session))
}

struct Writer {
    dir: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    size: u64,
    rotate_at: u64,
    pending: Vec<u8>,
    reported_open_failure: bool,
}

impl Writer {
    fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            dir,
            max_bytes,
            file: None,
            size: 0,
            rotate_at: max_bytes,
            pending: Vec::new(),
            reported_open_failure: false,
        }
    }

    fn append(&mut self, line: &str) {
        self.pending.extend_from_slice(line.as_bytes());
        if self.pending.len() >= FLUSH_THRESHOLD_BYTES {
            self.flush();
        }
    }

    fn open(&mut self) -> bool {
        if self.file.is_some() {
            return true;
        }
        let opened = fs::create_dir_all(&self.dir).and_then(|()| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(base_path(&self.dir))
        });
        match opened {
            Ok(file) => {
                self.size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                self.file = Some(file);
                self.reported_open_failure = false;
                true
            }
            Err(err) => {
                if !self.reported_open_failure {
                    eprintln!(
                        "[activity_log] cannot open {}: {err}",
                        base_path(&self.dir).display()
                    );
                    self.reported_open_failure = true;
                }
                false
            }
        }
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        if !self.open() {
            // Better to lose lines than to grow without bound while the disk is unusable.
            self.pending.clear();
            return;
        }
        let Some(file) = self.file.as_mut() else {
            self.pending.clear();
            return;
        };
        match file.write_all(&self.pending).and_then(|()| file.flush()) {
            Ok(()) => self.size += self.pending.len() as u64,
            Err(err) => {
                eprintln!("[activity_log] write failed: {err}");
                self.file = None;
            }
        }
        self.pending.clear();
        if self.file.is_some() && self.size >= self.rotate_at {
            self.rotate();
        }
    }

    /// `base → .1 → .2 → .3`, dropping the oldest. The handle is closed first because Windows cannot
    /// rename an open file; a failed rename keeps appending and retries after some more growth.
    fn rotate(&mut self) {
        self.file = None;
        let _ = fs::remove_file(rotated_path(&self.dir, ROTATED_FILES));
        for index in (1..ROTATED_FILES).rev() {
            let from = rotated_path(&self.dir, index);
            if from.exists() {
                if let Err(err) = fs::rename(&from, rotated_path(&self.dir, index + 1)) {
                    eprintln!("[activity_log] rotate {} failed: {err}", from.display());
                }
            }
        }
        match fs::rename(base_path(&self.dir), rotated_path(&self.dir, 1)) {
            Ok(()) => {
                self.size = 0;
                self.rotate_at = self.max_bytes;
            }
            Err(err) => {
                eprintln!("[activity_log] rotate base file failed: {err}");
                self.rotate_at = self.size + ROTATION_RETRY_BACKOFF_BYTES;
            }
        }
    }

    fn clear(&mut self) {
        self.pending.clear();
        self.file = None;
        for index in 1..=ROTATED_FILES {
            let _ = fs::remove_file(rotated_path(&self.dir, index));
        }
        if let Err(err) = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(base_path(&self.dir))
        {
            eprintln!("[activity_log] clear failed: {err}");
        }
        self.size = 0;
        self.rotate_at = self.max_bytes;
    }
}

enum Message {
    Entry(String),
    Flush(mpsc::Sender<()>),
    Clear(mpsc::Sender<()>),
    Shutdown(mpsc::Sender<()>),
}

fn report_dropped(writer: &mut Writer, dropped: &AtomicU64, session: i64) {
    let lost = dropped.swap(0, Ordering::Relaxed);
    if lost == 0 {
        return;
    }
    let note = ActivityEntry::draft(
        super::now_ms(),
        ActivityLevel::Warn,
        ActivitySource::Rust,
        "activity_log",
        format!("activity log writer fell behind: {lost} entries were not saved to disk"),
    );
    if let Some(line) = encode_line(&note, session) {
        writer.append(&line);
    }
}

fn run(receiver: Receiver<Message>, mut writer: Writer, dropped: Arc<AtomicU64>, session: i64) {
    let mut last_flush = Instant::now();
    loop {
        let wait = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
        match receiver.recv_timeout(wait) {
            Ok(Message::Entry(line)) => writer.append(&line),
            Ok(Message::Flush(ack)) => {
                report_dropped(&mut writer, &dropped, session);
                writer.flush();
                last_flush = Instant::now();
                let _ = ack.send(());
            }
            Ok(Message::Clear(ack)) => {
                writer.clear();
                let _ = ack.send(());
            }
            Ok(Message::Shutdown(ack)) => {
                report_dropped(&mut writer, &dropped, session);
                writer.flush();
                let _ = ack.send(());
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                writer.flush();
                return;
            }
        }
        if last_flush.elapsed() >= FLUSH_INTERVAL {
            report_dropped(&mut writer, &dropped, session);
            writer.flush();
            last_flush = Instant::now();
        }
    }
}

/// Handle to the writer thread. Submitting never blocks: when the channel is full the entry is not
/// saved to disk (it still lives in the in-memory buffer) and the loss is reported once drained.
pub struct Store {
    sender: SyncSender<Message>,
    dropped: Arc<AtomicU64>,
    dir: PathBuf,
    session: i64,
}

impl Store {
    pub fn start(dir: PathBuf, session: i64) -> Option<Self> {
        Self::start_with(dir, session, MAX_FILE_BYTES)
    }

    fn start_with(dir: PathBuf, session: i64, max_bytes: u64) -> Option<Self> {
        let (sender, receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        let writer = Writer::new(dir.clone(), max_bytes);
        let thread_dropped = Arc::clone(&dropped);
        std::thread::Builder::new()
            .name("activity-log-writer".to_string())
            .spawn(move || run(receiver, writer, thread_dropped, session))
            .ok()?;
        Some(Self {
            sender,
            dropped,
            dir,
            session,
        })
    }

    pub fn submit(&self, entry: &ActivityEntry) {
        let Some(line) = encode_line(entry, self.session) else {
            return;
        };
        if self.sender.try_send(Message::Entry(line)).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Sends a control message and waits for the writer's acknowledgement, giving up after `timeout`.
    fn request(&self, build: impl FnOnce(mpsc::Sender<()>) -> Message, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let (ack_sender, ack_receiver) = mpsc::channel();
        let mut message = build(ack_sender);
        loop {
            match self.sender.try_send(message) {
                Ok(()) => break,
                Err(TrySendError::Full(returned)) => {
                    if Instant::now() >= deadline {
                        return false;
                    }
                    message = returned;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(TrySendError::Disconnected(_)) => return false,
            }
        }
        ack_receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_ok()
    }

    pub fn flush(&self, timeout: Duration) -> bool {
        self.request(Message::Flush, timeout)
    }

    pub fn clear(&self, timeout: Duration) -> bool {
        self.request(Message::Clear, timeout)
    }

    pub fn shutdown(&self, timeout: Duration) -> bool {
        self.request(Message::Shutdown, timeout)
    }

    pub fn history(&self, limit: usize) -> Vec<ActivityEntry> {
        read_history(&self.dir, self.session, limit)
    }
}

/// The newest `limit` entries from earlier sessions, oldest first. Malformed lines (a torn write
/// after a crash) and files that vanish mid-rotation are skipped.
pub fn read_history(dir: &Path, current_session: i64, limit: usize) -> Vec<ActivityEntry> {
    let mut newest_first: Vec<ActivityEntry> = Vec::new();
    let paths = std::iter::once(base_path(dir))
        .chain((1..=ROTATED_FILES).map(|index| rotated_path(dir, index)));
    'files: for path in paths {
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines().rev() {
            if newest_first.len() >= limit {
                break 'files;
            }
            match line_session(line) {
                Some(session) if session != current_session => {}
                _ => continue,
            }
            if let Ok(entry) = serde_json::from_str::<ActivityEntry>(line.trim()) {
                newest_first.push(entry);
            }
        }
    }
    newest_first.reverse();
    newest_first
}

#[cfg(test)]
mod tests {
    use super::super::test_support::TempDir;
    use super::*;

    fn entry(id: u64, message: &str) -> ActivityEntry {
        let mut entry = ActivityEntry::draft(
            1_700_000_000_000 + id as i64,
            ActivityLevel::Info,
            ActivitySource::Rust,
            "test",
            message,
        );
        entry.id = id;
        entry
    }

    fn lines_of(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .map(|text| text.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    #[test]
    fn lines_round_trip_with_their_session() {
        let original = entry(7, "GET /api/albums → 200 in 1,480ms").with_duration(1480, true);
        let line = encode_line(&original, 12345).unwrap();
        assert!(line.ends_with(",\"session\":12345}\n"), "{line}");
        assert_eq!(line.matches('\n').count(), 1);
        let (decoded, session) = decode_line(&line).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(session, 12345);
    }

    #[test]
    fn message_text_that_looks_like_a_session_field_cannot_confuse_the_reader() {
        let tricky = entry(1, r#"payload {"session":99} and "session":7}"#);
        let line = encode_line(&tricky, 42).unwrap();
        assert_eq!(line_session(&line), Some(42));
        assert_eq!(decode_line(&line).unwrap().0.message, tricky.message);
    }

    #[test]
    fn multiline_messages_stay_on_one_line() {
        let line = encode_line(&entry(1, "first\nsecond\n  third"), 1).unwrap();
        assert_eq!(line.matches('\n').count(), 1);
        assert_eq!(
            decode_line(&line).unwrap().0.message,
            "first\nsecond\n  third"
        );
    }

    #[test]
    fn rejects_lines_without_a_session() {
        assert!(decode_line("not json").is_none());
        assert!(decode_line(r#"{"id":1}"#).is_none());
        assert!(decode_line("").is_none());
    }

    #[test]
    fn writer_appends_flushes_and_resumes_the_file_size() {
        let temp = TempDir::new();
        let mut writer = Writer::new(temp.path().to_path_buf(), 10_000);
        writer.append("one\n");
        writer.append("two\n");
        assert!(
            lines_of(&base_path(temp.path())).is_empty(),
            "buffered until flush"
        );
        writer.flush();
        assert_eq!(lines_of(&base_path(temp.path())), vec!["one", "two"]);

        let mut reopened = Writer::new(temp.path().to_path_buf(), 10_000);
        reopened.append("three\n");
        reopened.flush();
        assert_eq!(reopened.size, 14);
        assert_eq!(
            lines_of(&base_path(temp.path())),
            vec!["one", "two", "three"]
        );
    }

    #[test]
    fn writer_rotates_past_the_size_limit_and_keeps_three_old_files() {
        let temp = TempDir::new();
        let mut writer = Writer::new(temp.path().to_path_buf(), 100);
        for round in 0..6 {
            writer.append(&format!("{round}{}\n", "x".repeat(59)));
            writer.flush();
            writer.append(&format!("{round}{}\n", "y".repeat(59)));
            writer.flush();
        }
        let dir = temp.path();
        assert!(
            !base_path(dir).exists(),
            "the base file is recreated lazily after a rotation"
        );
        assert!(rotated_path(dir, 1).exists());
        assert!(rotated_path(dir, 2).exists());
        assert!(rotated_path(dir, 3).exists());
        assert!(!rotated_path(dir, 4).exists());
        let newest = lines_of(&rotated_path(dir, 1));
        let oldest = lines_of(&rotated_path(dir, 3));
        assert!(
            newest[0].as_bytes()[0] > oldest[0].as_bytes()[0],
            "newer data rotates to .1"
        );
        writer.append("next\n");
        writer.flush();
        assert_eq!(lines_of(&base_path(dir)), vec!["next"]);
    }

    #[test]
    fn writer_clear_removes_everything_and_keeps_working() {
        let temp = TempDir::new();
        let mut writer = Writer::new(temp.path().to_path_buf(), 50);
        for n in 0..6 {
            writer.append(&format!("{n}{}\n", "z".repeat(60)));
            writer.flush();
        }
        writer.append("pending\n");
        writer.clear();
        assert!(lines_of(&base_path(temp.path())).is_empty());
        assert!(!rotated_path(temp.path(), 1).exists());
        writer.append("after\n");
        writer.flush();
        assert_eq!(lines_of(&base_path(temp.path())), vec!["after"]);
    }

    fn write_session_lines(path: &Path, session: i64, ids: std::ops::RangeInclusive<u64>) {
        let mut text = fs::read_to_string(path).unwrap_or_default();
        for id in ids {
            text.push_str(&encode_line(&entry(id, &format!("s{session} #{id}")), session).unwrap());
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn history_skips_the_live_session_and_reads_oldest_first_across_files() {
        let temp = TempDir::new();
        let dir = temp.path();
        write_session_lines(&rotated_path(dir, 1), 100, 1..=3);
        write_session_lines(&base_path(dir), 200, 1..=2);
        write_session_lines(&base_path(dir), 300, 1..=2);

        let history = read_history(dir, 300, 100);
        let messages: Vec<&str> = history.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(
            messages,
            vec!["s100 #1", "s100 #2", "s100 #3", "s200 #1", "s200 #2"]
        );
    }

    #[test]
    fn history_returns_the_newest_entries_when_over_the_limit() {
        let temp = TempDir::new();
        let dir = temp.path();
        write_session_lines(&rotated_path(dir, 1), 100, 1..=5);
        write_session_lines(&base_path(dir), 200, 1..=5);

        let history = read_history(dir, 999, 3);
        let messages: Vec<&str> = history.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(messages, vec!["s200 #3", "s200 #4", "s200 #5"]);
    }

    #[test]
    fn history_skips_malformed_lines_and_tolerates_missing_files() {
        let temp = TempDir::new();
        let dir = temp.path();
        assert!(read_history(dir, 1, 10).is_empty());
        write_session_lines(&base_path(dir), 100, 1..=1);
        let mut text = fs::read_to_string(base_path(dir)).unwrap();
        text.push_str("{\"id\":2,\"timestampMs\":1,\"lev");
        text.push('\n');
        text.push_str("garbage\n");
        fs::write(base_path(dir), text).unwrap();
        write_session_lines(&base_path(dir), 100, 3..=3);

        let history = read_history(dir, 1, 10);
        let ids: Vec<u64> = history.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![1, 3]);
    }

    #[test]
    fn store_thread_writes_flushes_clears_and_shuts_down() {
        let temp = TempDir::new();
        let store = Store::start_with(temp.path().to_path_buf(), 555, 1024 * 1024).unwrap();
        store.submit(&entry(1, "first"));
        store.submit(&entry(2, "second"));
        assert!(store.flush(Duration::from_secs(5)));

        let lines = lines_of(&base_path(temp.path()));
        assert_eq!(lines.len(), 2);
        assert_eq!(decode_line(&lines[1]).unwrap().0.message, "second");
        assert_eq!(decode_line(&lines[0]).unwrap().1, 555);

        assert!(store.clear(Duration::from_secs(5)));
        assert!(lines_of(&base_path(temp.path())).is_empty());

        store.submit(&entry(3, "third"));
        assert!(store.shutdown(Duration::from_secs(5)));
        assert_eq!(lines_of(&base_path(temp.path())).len(), 1);
        assert!(
            !store.flush(Duration::from_millis(100)),
            "writer has exited"
        );
    }
}
