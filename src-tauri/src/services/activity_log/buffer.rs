//! In-memory ring buffer behind the Activity Log window.
//!
//! Pure data structure: no globals, no clock, no I/O. Callers pass a monotonic millisecond value so
//! the burst limiter is testable. Ids are assigned here, under the caller's lock, so buffer order and
//! id order always agree.

use std::collections::VecDeque;

use super::entry::{ActivityEntry, ActivityLevel, ActivitySource};

pub const CAPACITY: usize = 10_000;
/// Non-error entries accepted per one-second window before the rest are dropped and summarised.
pub const BURST_LIMIT: usize = 1000;
/// Errors bypass `BURST_LIMIT` but a runaway error loop must still be bounded.
const ERROR_BURST_FACTOR: usize = 5;
const BURST_WINDOW_MS: u64 = 1000;

/// What `push` stored; the caller forwards both to the disk writer in this order.
#[derive(Debug, Default)]
pub struct Pushed {
    /// "dropped N entries" note for the window that just ended.
    pub summary: Option<ActivityEntry>,
    pub entry: Option<ActivityEntry>,
}

#[derive(Debug)]
pub struct Since {
    pub entries: Vec<ActivityEntry>,
    pub last_id: u64,
}

pub struct Buffer {
    entries: VecDeque<ActivityEntry>,
    capacity: usize,
    burst_limit: usize,
    next_id: u64,
    window_started_ms: u64,
    window_accepted: usize,
    window_dropped: usize,
}

impl Default for Buffer {
    fn default() -> Self {
        Self::with_limits(CAPACITY, BURST_LIMIT)
    }
}

impl Buffer {
    pub fn with_limits(capacity: usize, burst_limit: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(capacity.min(1024)),
            capacity: capacity.max(1),
            burst_limit: burst_limit.max(1),
            next_id: 1,
            window_started_ms: 0,
            window_accepted: 0,
            window_dropped: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn last_id(&self) -> u64 {
        self.next_id - 1
    }

    pub fn push(&mut self, draft: ActivityEntry, now_ms: u64) -> Pushed {
        let mut pushed = Pushed::default();

        if now_ms.saturating_sub(self.window_started_ms) >= BURST_WINDOW_MS {
            if self.window_dropped > 0 {
                let summary = ActivityEntry::draft(
                    draft.timestamp_ms,
                    ActivityLevel::Warn,
                    ActivitySource::Rust,
                    "activity_log",
                    format!(
                        "activity log burst limit: dropped {} entries in the last second",
                        self.window_dropped
                    ),
                );
                pushed.summary = Some(self.store(summary));
            }
            self.window_started_ms = now_ms;
            self.window_accepted = 0;
            self.window_dropped = 0;
        }

        let limit = if draft.level == ActivityLevel::Error {
            self.burst_limit * ERROR_BURST_FACTOR
        } else {
            self.burst_limit
        };
        if self.window_accepted >= limit {
            self.window_dropped += 1;
            return pushed;
        }
        self.window_accepted += 1;
        pushed.entry = Some(self.store(draft));
        pushed
    }

    fn store(&mut self, mut entry: ActivityEntry) -> ActivityEntry {
        entry.id = self.next_id;
        self.next_id += 1;
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry.clone());
        entry
    }

    /// The newest `limit` entries with `id > since_id`, oldest first.
    pub fn since(&self, since_id: u64, limit: usize) -> Since {
        // A client holding an id from a previous session (or a future one) restarts from scratch.
        let since_id = if since_id > self.last_id() {
            0
        } else {
            since_id
        };
        let start = self.entries.partition_point(|entry| entry.id <= since_id);
        let available = self.entries.len() - start;
        let skip = available.saturating_sub(limit);
        let entries: Vec<ActivityEntry> = self.entries.iter().skip(start + skip).cloned().collect();
        let last_id = entries.last().map_or(since_id, |entry| entry.id);
        Since { entries, last_id }
    }

    /// Empties the buffer; ids keep increasing so a client's `sinceId` stays valid.
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(level: ActivityLevel, message: &str) -> ActivityEntry {
        ActivityEntry::draft(1_000, level, ActivitySource::Rust, "test", message)
    }

    fn info(message: &str) -> ActivityEntry {
        draft(ActivityLevel::Info, message)
    }

    #[test]
    fn assigns_increasing_ids_starting_at_one() {
        let mut buffer = Buffer::default();
        let a = buffer.push(info("a"), 0).entry.unwrap();
        let b = buffer.push(info("b"), 0).entry.unwrap();
        assert_eq!((a.id, b.id), (1, 2));
        assert_eq!(buffer.last_id(), 2);
        assert_eq!(buffer.len(), 2);
    }

    #[test]
    fn evicts_the_oldest_entries_beyond_capacity() {
        let mut buffer = Buffer::with_limits(3, 100);
        for n in 0..5 {
            buffer.push(info(&format!("m{n}")), 0);
        }
        let all = buffer.since(0, 100);
        let ids: Vec<u64> = all.entries.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![3, 4, 5]);
        assert_eq!(all.last_id, 5);
    }

    #[test]
    fn since_returns_only_newer_entries_oldest_first() {
        let mut buffer = Buffer::default();
        for n in 1..=5 {
            buffer.push(info(&format!("m{n}")), 0);
        }
        let result = buffer.since(3, 100);
        let messages: Vec<&str> = result.entries.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(messages, vec!["m4", "m5"]);
        assert_eq!(result.last_id, 5);
    }

    #[test]
    fn since_returns_the_newest_entries_when_over_the_limit() {
        let mut buffer = Buffer::default();
        for n in 1..=10 {
            buffer.push(info(&format!("m{n}")), 0);
        }
        let result = buffer.since(0, 3);
        let ids: Vec<u64> = result.entries.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![8, 9, 10]);
        assert_eq!(result.last_id, 10);
    }

    #[test]
    fn since_with_nothing_new_keeps_the_callers_id() {
        let mut buffer = Buffer::default();
        buffer.push(info("a"), 0);
        let result = buffer.since(1, 100);
        assert!(result.entries.is_empty());
        assert_eq!(result.last_id, 1);
        assert!(buffer.since(1, 0).entries.is_empty());
    }

    #[test]
    fn a_stale_since_id_from_a_previous_session_restarts_from_zero() {
        let mut buffer = Buffer::default();
        buffer.push(info("a"), 0);
        buffer.push(info("b"), 0);
        let result = buffer.since(9_999, 100);
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.last_id, 2);
    }

    #[test]
    fn clear_keeps_ids_increasing_so_clients_stay_in_sync() {
        let mut buffer = Buffer::default();
        buffer.push(info("a"), 0);
        buffer.push(info("b"), 0);
        buffer.clear();
        assert_eq!(buffer.len(), 0);
        let next = buffer.push(info("c"), 0).entry.unwrap();
        assert_eq!(next.id, 3);
        let result = buffer.since(2, 100);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(buffer.since(0, 100).entries.len(), 1);
    }

    #[test]
    fn drops_non_error_entries_over_the_burst_limit_and_summarizes_them() {
        let mut buffer = Buffer::with_limits(100, 3);
        for n in 0..5 {
            let pushed = buffer.push(info(&format!("m{n}")), 10);
            assert_eq!(pushed.entry.is_some(), n < 3, "entry {n}");
        }
        assert_eq!(buffer.len(), 3);

        let pushed = buffer.push(info("next window"), 1_500);
        let summary = pushed.summary.expect("summary for the dropped entries");
        assert_eq!(summary.level, ActivityLevel::Warn);
        assert_eq!(summary.category, "activity_log");
        assert!(
            summary.message.contains("dropped 2 entries"),
            "{}",
            summary.message
        );
        assert!(pushed.entry.is_some());
        assert!(summary.id < pushed.entry.unwrap().id);
    }

    #[test]
    fn a_quiet_window_produces_no_summary() {
        let mut buffer = Buffer::with_limits(100, 3);
        buffer.push(info("a"), 0);
        let pushed = buffer.push(info("b"), 5_000);
        assert!(pushed.summary.is_none());
        assert!(pushed.entry.is_some());
    }

    #[test]
    fn errors_bypass_the_burst_limit_up_to_a_hard_cap() {
        let mut buffer = Buffer::with_limits(1000, 2);
        for n in 0..2 {
            assert!(buffer.push(info(&format!("i{n}")), 10).entry.is_some());
        }
        assert!(buffer.push(info("dropped"), 10).entry.is_none());
        let mut accepted = 0;
        for n in 0..20 {
            if buffer
                .push(draft(ActivityLevel::Error, &format!("e{n}")), 10)
                .entry
                .is_some()
            {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 2 * ERROR_BURST_FACTOR - 2);
    }
}
