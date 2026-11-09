//! Reports slow SQLite statements to the activity log.
//!
//! Every connection to the local cache comes from `Database::open`, so the profiler is installed
//! there once instead of around individual queries. SQLite hands the profiler the statement text
//! as it was written (`?1` placeholders), never the values it ran with, so nothing the user typed
//! or stored ends up in the log.

use std::time::Duration;

use rusqlite::Connection;

use super::activity_log::redact::truncate_chars;
use super::activity_log::span::{format_ms, SLOW_SQL_MS};
use super::activity_log::{self, ActivityLevel};

pub(crate) const DB_CATEGORY: &str = "db";

/// Enough of a statement to tell the operation and table, without filling the log.
const MAX_STATEMENT_CHARS: usize = 160;

/// Reports every statement on this connection that takes at least `SLOW_SQL_MS`.
///
/// The time is wall-clock from the statement's first step to its end, so it includes waiting on
/// another connection's lock and any work done between reading rows. It does not include parsing
/// the statement, and it is reported for failed statements too: whoever ran the statement logs
/// the failure itself.
pub(crate) fn install(conn: &mut Connection) {
    conn.profile(Some(report_statement));
}

fn report_statement(sql: &str, elapsed: Duration) {
    report(sql, elapsed, SLOW_SQL_MS);
}

fn report(sql: &str, elapsed: Duration, slow_after_ms: u64) {
    let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    if elapsed_ms < slow_after_ms {
        return;
    }
    let message = format!(
        "statement took {}: {}",
        format_ms(elapsed_ms),
        summarize_statement(sql)
    );
    activity_log::record_timed(ActivityLevel::Warn, DB_CATEGORY, &message, elapsed_ms, true);
}

/// One line: whitespace collapsed, cut after `MAX_STATEMENT_CHARS`.
fn summarize_statement(sql: &str) -> String {
    let collapsed = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, MAX_STATEMENT_CHARS)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Instant;

    use super::*;
    use crate::services::activity_log::test_support::TempDir;
    use crate::services::activity_log::ActivityEntry;
    use crate::services::db::Database;

    fn logged(token: &str) -> Vec<ActivityEntry> {
        activity_log::entries_since(0, activity_log::MAX_ENTRIES_LIMIT)
            .entries
            .into_iter()
            .filter(|entry| entry.message.contains(token))
            .collect()
    }

    fn token() -> String {
        format!("t{}", uuid::Uuid::new_v4().simple())
    }

    #[test]
    fn statements_are_collapsed_to_one_line_and_cut_when_long() {
        assert_eq!(
            summarize_statement(
                "\n   SELECT id,\n        name\n    FROM   assets\n  WHERE id = ?1\n"
            ),
            "SELECT id, name FROM assets WHERE id = ?1"
        );
        let long = format!("SELECT {}", "é, ".repeat(400));
        let summary = summarize_statement(&long);
        assert!(summary.starts_with("SELECT é, é,"));
        assert!(summary.ends_with("[truncated]"));
        assert!(summary.chars().count() < MAX_STATEMENT_CHARS + 20);
    }

    #[test]
    fn fast_statements_stay_out_of_the_log() {
        let token = token();
        report(
            &format!("SELECT '{token}'"),
            Duration::from_millis(5),
            SLOW_SQL_MS,
        );
        report(
            &format!("SELECT '{token}'"),
            Duration::from_millis(SLOW_SQL_MS - 1),
            SLOW_SQL_MS,
        );
        assert!(logged(&token).is_empty());
    }

    #[test]
    fn slow_statements_are_flagged_warnings_with_their_duration() {
        let token = token();
        report(
            &format!("SELECT a.id\n    FROM assets a\n    WHERE a.note = '{token}'"),
            Duration::from_millis(1480),
            SLOW_SQL_MS,
        );
        let entries = logged(&token);
        assert_eq!(entries.len(), 1, "{entries:?}");
        let entry = &entries[0];
        assert_eq!(entry.category, DB_CATEGORY);
        assert_eq!(entry.level, ActivityLevel::Warn);
        assert!(entry.slow);
        assert_eq!(entry.duration_ms, Some(1480));
        assert_eq!(
            entry.message,
            format!("statement took 1,480ms: SELECT a.id FROM assets a WHERE a.note = '{token}'")
        );
    }

    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn remember(sql: &str, _elapsed: Duration) {
        SEEN.lock().unwrap().push(sql.to_string());
    }

    #[test]
    fn sqlite_reports_the_statement_text_without_the_values_it_ran_with() {
        let secret = token();
        let table = token();
        let mut conn = Connection::open_in_memory().unwrap();
        conn.profile(Some(remember));
        conn.execute_batch(&format!("CREATE TABLE {table} (body TEXT)"))
            .unwrap();
        conn.execute(
            &format!("INSERT INTO {table} (body) VALUES (?1)"),
            [&secret],
        )
        .unwrap();

        let seen = SEEN.lock().unwrap();
        let insert = seen
            .iter()
            .find(|sql| sql.contains(&format!("INSERT INTO {table}")))
            .unwrap_or_else(|| panic!("the profiler never saw the insert: {seen:?}"));
        assert!(insert.contains("VALUES (?1)"), "{insert}");
        assert!(!insert.contains(&secret), "{insert}");
    }

    static BLOCKED_BY_LOCK: AtomicBool = AtomicBool::new(false);

    /// Runs when SQLite finds the database locked: flags it, then holds the statement past the
    /// slow threshold so the test never depends on scheduler timing.
    fn wait_out_the_lock(_attempt: i32) -> bool {
        BLOCKED_BY_LOCK.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(SLOW_SQL_MS + 50));
        true
    }

    #[test]
    fn database_connections_report_statements_stalled_by_another_connections_lock() {
        let dir = TempDir::new();
        let path = dir.path().join("cache.sqlite");
        let db = Database::test_database(path.clone()).unwrap();
        let table = token();
        let secret = token();

        let conn = db.open().unwrap();
        conn.execute_batch(&format!("CREATE TABLE {table} (body TEXT)"))
            .unwrap();
        // The schema is read while preparing a statement, which the profiler does not time. Load
        // it before the lock is taken so the stall happens while the statement runs.
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
        conn.busy_handler(Some(wait_out_the_lock)).unwrap();

        let (locked, wait_for_lock) = mpsc::channel();
        let blocker = std::thread::spawn(move || {
            let blocker = Connection::open(path).unwrap();
            blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();
            locked.send(()).unwrap();
            let give_up = Instant::now() + Duration::from_secs(10);
            while !BLOCKED_BY_LOCK.load(Ordering::SeqCst) && Instant::now() < give_up {
                std::thread::sleep(Duration::from_millis(5));
            }
            blocker.execute_batch("COMMIT").unwrap();
        });
        wait_for_lock.recv().unwrap();

        conn.execute(
            &format!("INSERT INTO {table} (body) VALUES (?1)"),
            [&secret],
        )
        .unwrap();
        blocker.join().unwrap();
        assert!(
            BLOCKED_BY_LOCK.load(Ordering::SeqCst),
            "the insert never met the lock"
        );

        let entries = logged(&format!("INSERT INTO {table}"));
        assert_eq!(entries.len(), 1, "{entries:?}");
        let entry = &entries[0];
        assert_eq!(entry.category, DB_CATEGORY);
        assert_eq!(entry.level, ActivityLevel::Warn);
        assert!(entry.slow);
        assert!(entry.duration_ms.unwrap() >= SLOW_SQL_MS, "{entry:?}");
        assert!(
            entry.message.starts_with("statement took "),
            "{}",
            entry.message
        );
        assert!(
            entry
                .message
                .ends_with(&format!("INSERT INTO {table} (body) VALUES (?1)")),
            "{}",
            entry.message
        );
        assert!(!entry.message.contains(&secret));
    }
}
