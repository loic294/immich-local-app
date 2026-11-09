//! Derives a short, filterable category for each entry.
//!
//! Rust code already tags its messages with a bracketed prefix (`[sync]`, `[media:upload]`,
//! `[albums.create]`), so the first segment of that tag is the category. Records without a tag
//! fall back to the module that logged them.

const FALLBACK_CATEGORY: &str = "app";
const MAX_CATEGORY_CHARS: usize = 24;
const MAX_TAG_CHARS: usize = 48;
const CRATE_TARGET: &str = "immich_local_app";

/// Lowercases and restricts a category to `[a-z0-9_-]` so it is safe to filter and to print.
pub fn sanitize(raw: &str) -> String {
    let mapped: String = raw
        .trim()
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped.trim_matches(|c| c == '-' || c == '_');
    let capped: String = trimmed.chars().take(MAX_CATEGORY_CHARS).collect();
    let capped = capped.trim_end_matches(|c| c == '-' || c == '_');
    if capped.is_empty() {
        FALLBACK_CATEGORY.to_string()
    } else {
        capped.to_string()
    }
}

fn is_tag(candidate: &str) -> bool {
    let mut chars = candidate.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    candidate.len() <= MAX_TAG_CHARS
        && first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

/// `[media:upload] started` → `media`; `[albums.create] ok` → `albums`.
pub fn from_tag(message: &str) -> Option<String> {
    let inner = message.strip_prefix('[')?;
    let tag = &inner[..inner.find(']')?];
    if !is_tag(tag) {
        return None;
    }
    let first = tag.split([':', '.']).next()?;
    Some(sanitize(first))
}

/// Module path of the logging call site, e.g. `immich_local_app::commands::sync` → `sync`.
fn from_target(target: &str) -> String {
    let mut segments = target.split("::");
    match segments.next() {
        Some(CRATE_TARGET) => segments
            .last()
            .map(sanitize)
            .unwrap_or_else(|| FALLBACK_CATEGORY.to_string()),
        Some(first) if !first.is_empty() => sanitize(first),
        _ => FALLBACK_CATEGORY.to_string(),
    }
}

pub fn from_log_record(target: &str, message: &str) -> String {
    from_tag(message).unwrap_or_else(|| from_target(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_segment_of_the_message_tag() {
        assert_eq!(from_tag("[sync] page 3 saved").as_deref(), Some("sync"));
        assert_eq!(from_tag("[media:upload] started").as_deref(), Some("media"));
        assert_eq!(from_tag("[albums.create] ok").as_deref(), Some("albums"));
        assert_eq!(
            from_tag("[oauth:deep-link:rust] received").as_deref(),
            Some("oauth")
        );
        assert_eq!(
            from_tag("[Window-State] saved").as_deref(),
            Some("window-state")
        );
    }

    #[test]
    fn ignores_brackets_that_are_not_tags() {
        assert_eq!(from_tag("no tag here"), None);
        assert_eq!(from_tag("[2024-01-01] dated"), None);
        assert_eq!(from_tag("[unterminated tag"), None);
        assert_eq!(from_tag("[] empty"), None);
        assert_eq!(from_tag("[has space] x"), None);
        assert_eq!(from_tag(&format!("[{}] too long", "a".repeat(60))), None);
    }

    #[test]
    fn falls_back_to_the_module_that_logged() {
        assert_eq!(
            from_log_record("immich_local_app::commands::sync", "page 3 saved"),
            "sync"
        );
        assert_eq!(from_log_record("immich_local_app", "hello"), "app");
        assert_eq!(from_log_record("reqwest::connect", "dns"), "reqwest");
        assert_eq!(from_log_record("", "x"), "app");
    }

    #[test]
    fn a_tag_wins_over_the_module() {
        assert_eq!(
            from_log_record("immich_local_app::commands::sync", "[albums] refreshed"),
            "albums"
        );
    }

    #[test]
    fn sanitize_normalizes_and_bounds_categories() {
        assert_eq!(sanitize("Window State!"), "window-state");
        assert_eq!(sanitize("  http  "), "http");
        assert_eq!(sanitize("--__--"), "app");
        assert_eq!(sanitize(""), "app");
        assert_eq!(sanitize("activity_log"), "activity_log");
        assert_eq!(
            sanitize(&"x".repeat(40)).chars().count(),
            MAX_CATEGORY_CHARS
        );
        assert_eq!(sanitize("日本語"), "app");
    }
}
