//! Lightweight timing spans: measure an operation and record one entry when it ends.
//!
//! The decision of *what* to write is a pure function (`describe_completion`) so thresholds and
//! wording are unit-tested without touching the global log.

use std::fmt::Display;
use std::future::Future;
use std::time::Instant;

use super::entry::ActivityLevel;

/// Rust functions that take at least this long are flagged slow.
pub const SLOW_FUNCTION_MS: u64 = 250;
/// HTTP requests that take at least this long are flagged slow.
pub const SLOW_HTTP_MS: u64 = 1000;
/// SQLite statements that take at least this long are flagged slow.
pub const SLOW_SQL_MS: u64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome<'a> {
    Done(Option<&'a str>),
    Failed(&'a str),
    /// Stopped on request, so it is neither a success nor a failure.
    Cancelled,
    /// The span was dropped without `finish`/`fail`: an early return or a cancelled future.
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub level: ActivityLevel,
    pub message: String,
    pub slow: bool,
}

/// `1480` → `"1,480ms"`. Always milliseconds so durations are easy to compare and grep.
pub fn format_ms(ms: u64) -> String {
    let digits = ms.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 + 2);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    grouped.push_str("ms");
    grouped
}

/// `1536` → `"1.5 KB"`; binary units, one decimal.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// `"12.3 MB, 2.9 MB/s"`: what a streamed body adds to a request line that stops at the headers.
pub fn describe_transfer(bytes: u64, elapsed_ms: u64) -> String {
    if elapsed_ms == 0 {
        return format_bytes(bytes);
    }
    let per_second = u128::from(bytes) * 1000 / u128::from(elapsed_ms);
    let per_second = u64::try_from(per_second).unwrap_or(u64::MAX);
    format!("{}, {}/s", format_bytes(bytes), format_bytes(per_second))
}

pub fn describe_completion(
    label: &str,
    elapsed_ms: u64,
    slow_after_ms: u64,
    only_when_slow: bool,
    outcome: Outcome<'_>,
) -> Option<Completion> {
    let slow = elapsed_ms >= slow_after_ms;
    let took = format_ms(elapsed_ms);
    match outcome {
        Outcome::Done(detail) => {
            if only_when_slow && !slow {
                return None;
            }
            let message = match detail.filter(|d| !d.is_empty()) {
                Some(detail) => format!("{label} done in {took} ({detail})"),
                None => format!("{label} done in {took}"),
            };
            Some(Completion {
                level: if slow {
                    ActivityLevel::Warn
                } else {
                    ActivityLevel::Info
                },
                message,
                slow,
            })
        }
        Outcome::Failed(error) => Some(Completion {
            level: ActivityLevel::Error,
            message: format!("{label} failed after {took}: {error}"),
            slow,
        }),
        Outcome::Cancelled => {
            if only_when_slow && !slow {
                return None;
            }
            Some(Completion {
                level: ActivityLevel::Info,
                message: format!("{label} cancelled after {took}"),
                slow: false,
            })
        }
        Outcome::Abandoned => {
            if only_when_slow && !slow {
                return None;
            }
            Some(Completion {
                level: ActivityLevel::Warn,
                message: format!("{label} ended without a result after {took}"),
                slow,
            })
        }
    }
}

pub struct Span {
    category: &'static str,
    label: String,
    started: Instant,
    slow_after_ms: u64,
    done: bool,
}

impl Span {
    fn new(category: &'static str, label: impl Into<String>) -> Self {
        Self {
            category,
            label: label.into(),
            started: Instant::now(),
            slow_after_ms: SLOW_FUNCTION_MS,
            done: false,
        }
    }

    /// Overrides the slow threshold for this span.
    pub fn slow_after(mut self, ms: u64) -> Self {
        self.slow_after_ms = ms;
        self
    }

    pub fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    pub fn finish(self) {
        self.complete(Outcome::Done(None));
    }

    pub fn finish_with(self, detail: &str) {
        self.complete(Outcome::Done(Some(detail)));
    }

    /// Finishes a streamed download or upload, adding its size and throughput.
    pub fn finish_transfer(self, bytes: u64) {
        let detail = describe_transfer(bytes, self.elapsed_ms());
        self.finish_with(&detail);
    }

    pub fn fail(self, error: impl Display) {
        let error = error.to_string();
        self.complete(Outcome::Failed(&error));
    }

    pub fn cancel(self) {
        self.complete(Outcome::Cancelled);
    }

    pub fn finish_result<T, E: Display>(self, result: &Result<T, E>) {
        match result {
            Ok(_) => self.finish(),
            Err(error) => self.fail(error),
        }
    }

    fn complete(mut self, outcome: Outcome<'_>) {
        self.done = true;
        self.emit(outcome);
    }

    fn emit(&self, outcome: Outcome<'_>) {
        let elapsed = self.elapsed_ms();
        if let Some(completion) =
            describe_completion(&self.label, elapsed, self.slow_after_ms, false, outcome)
        {
            super::record_timed(
                completion.level,
                self.category,
                &completion.message,
                elapsed,
                completion.slow,
            );
        }
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        if !self.done {
            self.emit(Outcome::Abandoned);
        }
    }
}

/// Records one entry when the operation ends, whatever its duration.
pub fn span(category: &'static str, label: impl Into<String>) -> Span {
    Span::new(category, label)
}

/// Records a "started" entry immediately (for long operations), then behaves like `span`.
pub fn begin(category: &'static str, label: impl Into<String>) -> Span {
    let label = label.into();
    super::info(category, &format!("{label} started"));
    Span::new(category, label)
}

/// Runs a fallible future under a `span`; a cancelled future is recorded as abandoned.
pub async fn track<T, E, F>(category: &'static str, label: &str, future: F) -> Result<T, E>
where
    E: Display,
    F: Future<Output = Result<T, E>>,
{
    let span = span(category, label);
    let result = future.await;
    span.finish_result(&result);
    result
}

/// `describe_completion` for an operation made of consecutive steps: the entry names each step's
/// time so a slow run shows where it went, e.g. `page 12 done in 3,689ms (100 assets; fetch 412ms,
/// enrich 3,204ms, save 73ms)`.
pub fn describe_phases(
    label: &str,
    total_ms: u64,
    slow_after_ms: u64,
    only_when_slow: bool,
    detail: &str,
    steps: &[(&str, u64)],
) -> Option<Completion> {
    let steps = steps
        .iter()
        .map(|(name, ms)| format!("{name} {}", format_ms(*ms)))
        .collect::<Vec<_>>()
        .join(", ");
    let detail = match (detail.is_empty(), steps.is_empty()) {
        (_, true) => detail.to_string(),
        (true, false) => steps,
        (false, false) => format!("{detail}; {steps}"),
    };
    describe_completion(
        label,
        total_ms,
        slow_after_ms,
        only_when_slow,
        Outcome::Done(Some(&detail)),
    )
}

/// Times the consecutive steps of one operation and records a single entry at the end. An
/// operation that fails is not finished: the error is logged where it happens.
pub struct Phases {
    started: Instant,
    last_mark: Instant,
    steps: Vec<(&'static str, u64)>,
    slow_after_ms: u64,
    only_when_slow: bool,
}

impl Phases {
    pub fn start() -> Self {
        let now = Instant::now();
        Self {
            started: now,
            last_mark: now,
            steps: Vec::new(),
            slow_after_ms: SLOW_FUNCTION_MS,
            only_when_slow: false,
        }
    }

    /// Overrides the slow threshold for the whole operation.
    pub fn slow_after(mut self, ms: u64) -> Self {
        self.slow_after_ms = ms;
        self
    }

    /// Stays silent unless the operation is slow; for hot paths.
    pub fn only_when_slow(mut self) -> Self {
        self.only_when_slow = true;
        self
    }

    /// Ends the step that began at the previous mark (or at `start`).
    pub fn mark(&mut self, step: &'static str) {
        let now = Instant::now();
        self.steps
            .push((step, millis(now.duration_since(self.last_mark))));
        self.last_mark = now;
    }

    /// `detail` is free text such as a count, shown before the step times.
    pub fn finish(self, category: &'static str, label: &str, detail: &str) {
        let total_ms = millis(self.started.elapsed());
        if let Some(completion) = describe_phases(
            label,
            total_ms,
            self.slow_after_ms,
            self.only_when_slow,
            detail,
            &self.steps,
        ) {
            super::record_timed(
                completion.level,
                category,
                &completion.message,
                total_ms,
                completion.slow,
            );
        }
    }
}

fn millis(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_durations_with_thousands_separators() {
        assert_eq!(format_ms(0), "0ms");
        assert_eq!(format_ms(7), "7ms");
        assert_eq!(format_ms(999), "999ms");
        assert_eq!(format_ms(1000), "1,000ms");
        assert_eq!(format_ms(1480), "1,480ms");
        assert_eq!(format_ms(12_345_678), "12,345,678ms");
    }

    #[test]
    fn formats_sizes_with_binary_units() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
        assert!(format_bytes(u64::MAX).ends_with(" GB"));
    }

    #[test]
    fn describes_a_transfer_with_its_throughput() {
        assert_eq!(
            describe_transfer(10 * 1024 * 1024, 2000),
            "10.0 MB, 5.0 MB/s"
        );
        assert_eq!(describe_transfer(512, 1000), "512 B, 512 B/s");
        assert_eq!(describe_transfer(2048, 0), "2.0 KB");
        assert!(describe_transfer(u64::MAX, 1).ends_with("/s"));
    }

    #[test]
    fn a_fast_success_is_info() {
        let completion =
            describe_completion("sync page 3", 40, 250, false, Outcome::Done(None)).unwrap();
        assert_eq!(completion.level, ActivityLevel::Info);
        assert!(!completion.slow);
        assert_eq!(completion.message, "sync page 3 done in 40ms");
    }

    #[test]
    fn a_slow_success_is_a_slow_warning() {
        let completion =
            describe_completion("sync page 3", 1480, 250, false, Outcome::Done(None)).unwrap();
        assert_eq!(completion.level, ActivityLevel::Warn);
        assert!(completion.slow);
        assert_eq!(completion.message, "sync page 3 done in 1,480ms");
    }

    #[test]
    fn the_threshold_itself_counts_as_slow() {
        assert!(
            describe_completion("x", 250, 250, false, Outcome::Done(None))
                .unwrap()
                .slow
        );
        assert!(
            !describe_completion("x", 249, 250, false, Outcome::Done(None))
                .unwrap()
                .slow
        );
    }

    #[test]
    fn details_are_appended_in_parentheses() {
        let completion =
            describe_completion("upsert", 5, 250, false, Outcome::Done(Some("500 assets")))
                .unwrap();
        assert_eq!(completion.message, "upsert done in 5ms (500 assets)");
        let empty = describe_completion("upsert", 5, 250, false, Outcome::Done(Some(""))).unwrap();
        assert_eq!(empty.message, "upsert done in 5ms");
    }

    #[test]
    fn failures_are_errors_and_always_recorded() {
        let completion = describe_completion(
            "refresh",
            12,
            250,
            true,
            Outcome::Failed("offline: unreachable"),
        )
        .unwrap();
        assert_eq!(completion.level, ActivityLevel::Error);
        assert_eq!(
            completion.message,
            "refresh failed after 12ms: offline: unreachable"
        );
        assert!(!completion.slow);
    }

    #[test]
    fn watch_spans_are_silent_unless_slow() {
        assert!(describe_completion("hot", 5, 250, true, Outcome::Done(None)).is_none());
        let slow = describe_completion("hot", 300, 250, true, Outcome::Done(None)).unwrap();
        assert!(slow.slow);
        assert_eq!(slow.level, ActivityLevel::Warn);
    }

    #[test]
    fn abandoned_spans_warn() {
        let completion = describe_completion("job", 20, 250, false, Outcome::Abandoned).unwrap();
        assert_eq!(completion.level, ActivityLevel::Warn);
        assert_eq!(completion.message, "job ended without a result after 20ms");
        assert!(describe_completion("job", 20, 250, true, Outcome::Abandoned).is_none());
    }

    #[test]
    fn cancellations_are_informational_and_not_slow() {
        let completion =
            describe_completion("sync", 90_000, 250, false, Outcome::Cancelled).unwrap();
        assert_eq!(completion.level, ActivityLevel::Info);
        assert!(!completion.slow);
        assert_eq!(completion.message, "sync cancelled after 90,000ms");
        assert!(describe_completion("sync", 5, 250, true, Outcome::Cancelled).is_none());
    }

    #[test]
    fn spans_report_elapsed_time_and_override_thresholds() {
        let span = span("test", "unit").slow_after(5);
        assert_eq!(span.slow_after_ms, 5);
        assert!(span.elapsed_ms() < 1000);
        span.finish();
    }

    #[test]
    fn phases_list_the_detail_then_each_step() {
        let steps = [("fetch", 412), ("enrich", 3204), ("save", 73)];
        let completion =
            describe_phases("page 12", 3689, 5000, false, "100 assets", &steps).unwrap();
        assert_eq!(
            completion.message,
            "page 12 done in 3,689ms (100 assets; fetch 412ms, enrich 3,204ms, save 73ms)"
        );
        assert_eq!(completion.level, ActivityLevel::Info);
        assert!(!completion.slow);
    }

    #[test]
    fn phases_without_a_detail_or_without_steps_stay_tidy() {
        let steps = [("copy", 9)];
        assert_eq!(
            describe_phases("file", 9, 250, false, "", &steps)
                .unwrap()
                .message,
            "file done in 9ms (copy 9ms)"
        );
        assert_eq!(
            describe_phases("file", 9, 250, false, "2 MB", &[])
                .unwrap()
                .message,
            "file done in 9ms (2 MB)"
        );
        assert_eq!(
            describe_phases("file", 9, 250, false, "", &[])
                .unwrap()
                .message,
            "file done in 9ms"
        );
    }

    #[test]
    fn phases_flag_slow_runs_and_can_stay_silent_otherwise() {
        let slow = describe_phases("page", 5000, 5000, true, "", &[("save", 4900)]).unwrap();
        assert!(slow.slow);
        assert_eq!(slow.level, ActivityLevel::Warn);
        assert!(describe_phases("page", 4999, 5000, true, "", &[("save", 10)]).is_none());
        assert!(describe_phases("page", 4999, 5000, false, "", &[("save", 10)]).is_some());
    }

    #[test]
    fn phase_timers_keep_marks_in_order() {
        let mut phases = Phases::start().slow_after(60_000).only_when_slow();
        phases.mark("first");
        phases.mark("second");
        let names: Vec<&str> = phases.steps.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["first", "second"]);
        assert_eq!(phases.slow_after_ms, 60_000);
        assert!(phases.only_when_slow);
        phases.finish("test", "phases", "");
    }
}
