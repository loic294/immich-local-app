use chrono::{DateTime, Datelike, Local, NaiveDate, Utc};

use crate::services::immich_client::MemorySummary;
use crate::AppState;

#[tauri::command]
pub async fn fetch_memories(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MemorySummary>, String> {
    let accounts = state.sync_accounts();
    if accounts.is_empty() {
        return Err("offline: no account available".to_string());
    }

    let mut all_memories: Vec<MemorySummary> = Vec::new();
    let mut any_online = false;
    let mut failures = Vec::new();
    let mut successful_accounts = 0;

    for (account_id, client) in accounts {
        // Local-first: skip accounts whose server is currently unreachable so a
        // single offline account doesn't fail the whole strip.
        let server_url = state
            .db
            .get_account(&account_id)
            .ok()
            .flatten()
            .map(|account| account.server_url);
        let online = match &server_url {
            Some(url) => client.ping(url).await,
            None => false,
        };
        if !online {
            log::warn!(
                "[memories.fetch_memories] account {} unreachable — skipping (offline)",
                account_id
            );
            continue;
        }
        any_online = true;

        match client.get_memories().await {
            Ok(memories) => {
                successful_accounts += 1;
                log::info!(
                    "[memories.fetch_memories] account {} returned {} memories",
                    account_id,
                    memories.len()
                );
                // Tag each memory with its owning account so the frontend can
                // route thumbnail loads to the correct server session.
                all_memories.extend(memories.into_iter().map(|mut memory| {
                    memory.account_id = account_id.clone();
                    memory
                }));
            }
            Err(err) => {
                log::warn!(
                    "[memories.fetch_memories] fetch failed for account {}: {}",
                    account_id, err
                );
                failures.push(format!("account {account_id}: {err}"));
            }
        }
    }

    if !any_online {
        return Err("offline: server unreachable".to_string());
    }
    if successful_accounts == 0 {
        return Err(format!("Memory fetch failed: {}", failures.join("; ")));
    }

    let today = Local::now().date_naive();
    let fetched = all_memories.len();
    let all_memories = select_recent_memories(all_memories, today);

    log::info!(
        "[memories.fetch_memories] showing {} of {} memories for {} and the day before",
        all_memories.len(),
        fetched,
        today
    );

    Ok(all_memories)
}

/// Keeps only memories for the user's local `today` and yesterday, today's
/// first and the most recent year first within a day.
fn select_recent_memories(memories: Vec<MemorySummary>, today: NaiveDate) -> Vec<MemorySummary> {
    let mut recent: Vec<(NaiveDate, MemorySummary)> = memories
        .into_iter()
        .filter_map(|memory| memory_display_day(&memory, today).map(|day| (day, memory)))
        .collect();
    recent.sort_by(|(a_day, a), (b_day, b)| {
        b_day.cmp(a_day).then_with(|| b.memory_at.cmp(&a.memory_at))
    });
    recent.into_iter().map(|(_, memory)| memory).collect()
}

/// Returns the most recent of `today`/yesterday on which the memory is shown.
/// Immich shows each memory for whole UTC calendar days (`showAt` 00:00Z to
/// `hideAt` 23:59:59.999Z) and also returns upcoming and past days, so the
/// window is compared by calendar date rather than as instants.
fn memory_display_day(memory: &MemorySummary, today: NaiveDate) -> Option<NaiveDate> {
    let days = [Some(today), today.pred_opt()];
    let mut days = days.into_iter().flatten();

    if let Some(show) = utc_calendar_day(memory.show_at.as_deref()) {
        let hide = utc_calendar_day(memory.hide_at.as_deref()).unwrap_or(show);
        return days.find(|day| show <= *day && *day <= hide);
    }

    // Servers without a show window: fall back to the "on this day" anniversary.
    let memory_day = utc_calendar_day(memory.memory_at.as_deref())?;
    days.find(|day| day.month() == memory_day.month() && day.day() == memory_day.day())
}

fn utc_calendar_day(value: Option<&str>) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|date| date.with_timezone(&Utc).date_naive())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(id: &str, memory_at: &str, window: Option<(&str, &str)>) -> MemorySummary {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "memoryAt": memory_at,
            "showAt": window.map(|(show, _)| show),
            "hideAt": window.map(|(_, hide)| hide),
        }))
        .unwrap()
    }

    fn on_day(id: &str, year: i32, day: &str) -> MemorySummary {
        memory(
            id,
            &format!("{year}-{day}T00:00:00.000Z"),
            Some((
                &format!("2026-{day}T00:00:00.000Z"),
                &format!("2026-{day}T23:59:59.999Z"),
            )),
        )
    }

    fn ids(memories: &[MemorySummary]) -> Vec<&str> {
        memories.iter().map(|memory| memory.id.as_str()).collect()
    }

    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn keeps_only_today_and_yesterday_with_today_first() {
        let memories = vec![
            on_day("older", 2024, "11-04"),
            on_day("yesterday-2020", 2020, "11-05"),
            on_day("today-2022", 2022, "11-06"),
            on_day("upcoming", 2024, "11-07"),
            on_day("yesterday-2025", 2025, "11-05"),
            on_day("today-2024", 2024, "11-06"),
            on_day("month-ago", 2021, "10-10"),
        ];

        let recent = select_recent_memories(memories, date("2026-11-06"));

        assert_eq!(
            ids(&recent),
            ["today-2024", "today-2022", "yesterday-2025", "yesterday-2020"]
        );
    }

    #[test]
    fn multi_day_windows_count_when_they_cover_today_or_yesterday() {
        let memories = vec![
            memory(
                "spanning",
                "2023-11-01T00:00:00.000Z",
                Some(("2026-11-01T00:00:00.000Z", "2026-11-05T23:59:59.999Z")),
            ),
            memory(
                "ended",
                "2023-11-01T00:00:00.000Z",
                Some(("2026-11-01T00:00:00.000Z", "2026-11-04T23:59:59.999Z")),
            ),
        ];

        assert_eq!(
            ids(&select_recent_memories(memories, date("2026-11-06"))),
            ["spanning"]
        );
    }

    #[test]
    fn falls_back_to_anniversary_without_a_show_window_across_year_boundaries() {
        let memories = vec![
            memory("new-years-eve", "2023-12-31T00:00:00.000Z", None),
            memory("new-years-day", "2022-01-01T00:00:00.000Z", None),
            memory("other-day", "2022-01-02T00:00:00.000Z", None),
            memory("undated", "not-a-date", None),
        ];

        assert_eq!(
            ids(&select_recent_memories(memories, date("2027-01-01"))),
            ["new-years-day", "new-years-eve"]
        );
    }
}
