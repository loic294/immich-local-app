use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike};

use crate::services::immich_client::AlbumSummary;

pub(super) fn preferred_album<'a>(
    albums: &'a [AlbumSummary],
    user_id: &str,
) -> Option<&'a AlbumSummary> {
    albums.iter().max_by(|a, b| {
        let date = |album: &AlbumSummary| {
            album.start_date.as_deref().and_then(|value| {
                DateTime::parse_from_rfc3339(value).ok().map(|date| date.timestamp())
            })
        };
        (a.owner_id == user_id)
            .cmp(&(b.owner_id == user_id))
            .then_with(|| date(a).cmp(&date(b)))
            .then_with(|| b.id.cmp(&a.id))
    })
}

pub(super) fn album_local_folder(
    name: &str,
    start_date: Option<&str>,
    saved_path: Option<&str>,
    base: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = saved_path.filter(|path| !path.trim().is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let year = start_date
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|date| date.year())
        .unwrap_or_else(|| chrono::Local::now().year());
    let name = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>();
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("Album name cannot be used as a local folder name".into());
    }
    Ok(base.join(year.to_string()).join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn album(id: &str, owner: &str, date: Option<&str>) -> AlbumSummary {
        serde_json::from_value(serde_json::json!({
            "id": id, "albumName": id, "ownerId": owner, "startDate": date
        })).unwrap()
    }

    #[test]
    fn ownership_precedes_recency_and_start_date_breaks_ties() {
        let albums = [
            album("shared", "other", Some("2026-10-12T00:00:00Z")),
            album("old-owned", "me", Some("2024-01-01T00:00:00Z")),
            album("new-owned", "me", Some("2025-01-01T00:00:00Z")),
        ];
        assert_eq!(preferred_album(&albums, "me").unwrap().id, "new-owned");
        assert_eq!(preferred_album(&albums, "someone-else").unwrap().id, "shared");
        assert!(preferred_album(&[], "me").is_none());
    }

    #[test]
    fn dates_are_compared_as_instants_and_missing_dates_sort_last() {
        let albums = [
            album("missing", "me", None),
            album("invalid", "me", Some("invalid")),
            album("older", "me", Some("2025-01-01T01:00:00+02:00")),
            album("newer", "me", Some("2025-01-01T00:00:00Z")),
        ];
        assert_eq!(preferred_album(&albums, "me").unwrap().id, "newer");
    }

    #[test]
    fn folder_reuses_saved_path_or_creates_normal_album_path() {
        let base = std::env::temp_dir().join("album-download-test");
        let saved = base.join("custom");
        assert_eq!(
            album_local_folder("renamed", None, saved.to_str(), &base).unwrap(),
            saved
        );
        assert_eq!(
            album_local_folder("Trip / beach", Some("2024-06-01T00:00:00Z"), None, &base).unwrap(),
            base.join("2024").join("Trip _ beach")
        );
        for name in ["", ".", ".."] {
            assert!(album_local_folder(name, None, None, &base).is_err());
        }
    }
}
