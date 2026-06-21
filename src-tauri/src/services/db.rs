use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::commands::settings::{MyPhotosRule, Settings};
use crate::services::immich_client::AssetSummary;

/// Boxed SQL parameters used when a query is assembled dynamically (e.g. the
/// optional [`AssetFilterCriteria`] fragment). Binding order matches the
/// positional `?N` placeholders in the assembled SQL.
type DynParams = Vec<Box<dyn rusqlite::ToSql>>;

/// Structured, combinable filter criteria applied on top of the base
/// search/filter for every photo-grid view (All Photos, albums, folders,
/// calendar months). All fields are optional and combine with AND. Filtering is
/// performed in SQL so the server-computed canvas layout stays consistent with
/// the windowed/paged results.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFilterCriteria {
    /// Star rating 1-5 to compare against, combined with [`Self::rating_mode`].
    pub rating: Option<i64>,
    /// Comparison mode for [`Self::rating`]: "eq" (default), "gte" or "lte".
    pub rating_mode: Option<String>,
    /// When true, only favorite assets are included.
    pub favorite_only: Option<bool>,
    /// When true, only assets matching My Photos rules are included.
    pub my_photos_only: Option<bool>,
    /// Media type: "photo" (non-RAW images), "raw", "photo_raw" (all images) or
    /// "video".
    pub media_type: Option<String>,
    /// Exact camera (EXIF model) to match.
    pub camera: Option<String>,
    /// Person id to match via the `asset_people` junction table.
    pub person_id: Option<String>,
}

impl AssetFilterCriteria {
    /// True when no field would constrain the result set, allowing callers to
    /// skip assembling the extra SQL fragment entirely.
    fn is_empty(&self) -> bool {
        self.rating.is_none()
            && self.favorite_only != Some(true)
            && self.my_photos_only != Some(true)
            && self.media_type.as_deref().map(str::trim).unwrap_or("").is_empty()
            && self.camera.as_deref().map(str::trim).unwrap_or("").is_empty()
            && self.person_id.as_deref().map(str::trim).unwrap_or("").is_empty()
    }
}

/// Sort parameters controlling the order in which assets are returned.
/// The default (date_captured + desc) matches the pre-existing behaviour.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortParams {
    /// "date_captured" (default) or "filename".
    pub field: Option<String>,
    /// "asc" or "desc" (default).
    pub direction: Option<String>,
}

impl SortParams {
    /// Returns the SQL ORDER BY clause (without the `ORDER BY` keyword) for
    /// asset queries based on this sort configuration.
    pub fn order_by_clause(&self) -> String {
        let dir = self.sql_direction();
        match self.field.as_deref().unwrap_or("date_captured") {
            "filename" => format!("original_file_name COLLATE NOCASE {}", dir),
            _ => format!("file_created_at {} NULLS LAST, updated_at {}", dir, dir),
        }
    }

    /// Returns the SQL ORDER BY clause for a prefixed table alias (e.g. `a.`).
    pub fn order_by_clause_prefixed(&self, alias: &str) -> String {
        let dir = self.sql_direction();
        match self.field.as_deref().unwrap_or("date_captured") {
            "filename" => {
                format!("{alias}original_file_name COLLATE NOCASE {}", dir)
            }
            _ => format!(
                "{alias}file_created_at {} NULLS LAST, {alias}updated_at {}",
                dir, dir
            ),
        }
    }

    /// "ASC" or "DESC"
    pub fn sql_direction(&self) -> &str {
        match self.direction.as_deref().unwrap_or("desc") {
            "asc" => "ASC",
            _ => "DESC",
        }
    }

    /// For `get_asset_days` the day-key ordering follows the sort direction.
    pub fn day_key_order(&self) -> &str {
        match self.direction.as_deref().unwrap_or("desc") {
            "asc" => "ASC",
            _ => "DESC",
        }
    }

    /// True when the sort field is "filename" (vs date-based).
    pub fn is_filename_sort(&self) -> bool {
        self.field.as_deref() == Some("filename")
    }
}

/// Identifies the browsable view a filter dropdown should be scoped to, so the
/// Camera and People option lists only show values present in the assets the
/// user is currently looking at (All Photos, a single album, a folder or a
/// calendar month).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewScope {
    /// One of: "all", "album", "folder", "month".
    pub kind: String,
    /// Base filter ("all" | "favorites" | "archived"), used when `kind` == "all".
    pub filter: Option<String>,
    /// Album id, used when `kind` == "album".
    pub album_id: Option<String>,
    /// Folder path, used when `kind` == "folder".
    pub path: Option<String>,
    /// Year, used when `kind` == "month".
    pub year: Option<i32>,
    /// Month (1-12), used when `kind` == "month".
    pub month: Option<u32>,
}

/// Build a subquery selecting `asset_id` for every asset in the given view
/// scope, plus its bind params. Used to scope the Camera/People dropdown options
/// to the assets currently on screen.
fn scope_asset_ids_query(scope: &ViewScope) -> (String, DynParams) {
    let mut params: DynParams = Vec::new();
    let sql = match scope.kind.as_str() {
        "album" => {
            params.push(Box::new(scope.album_id.clone().unwrap_or_default()));
            "SELECT aa.asset_id AS asset_id FROM album_assets aa WHERE aa.album_id = ?".to_string()
        }
        "folder" => {
            let path = scope.path.clone().unwrap_or_else(|| "/".to_string());
            if path == "/" {
                "SELECT id AS asset_id FROM assets WHERE original_path LIKE '/%' AND original_path NOT LIKE '/%/%'".to_string()
            } else {
                let path_prefix = format!("{}/", path);
                let like_pattern = format!("{}%", path_prefix);
                let remaining_start = (path_prefix.len() + 1) as i64;
                params.push(Box::new(like_pattern));
                params.push(Box::new(remaining_start));
                "SELECT id AS asset_id FROM assets WHERE original_path LIKE ? AND instr(substr(original_path, ?), '/') = 0".to_string()
            }
        }
        "month" => {
            let month_key = format!(
                "{:04}-{:02}",
                scope.year.unwrap_or(0),
                scope.month.unwrap_or(0)
            );
            params.push(Box::new(month_key));
            "SELECT id AS asset_id FROM assets WHERE file_created_at IS NOT NULL AND substr(file_created_at, 1, 7) = ?".to_string()
        }
        _ => {
            let filter_clause = asset_filter_where_clause(scope.filter.as_deref());
            format!("SELECT id AS asset_id FROM assets WHERE ({})", filter_clause)
        }
    };
    (sql, params)
}

/// Lowercased RAW file extensions used to distinguish RAW photos from regular
/// images. Hardcoded constants (no user input) so they are safe to inline.
const RAW_EXTENSIONS_SQL: &str = "'cr2','cr3','nef','nrw','arw','sr2','srf','raf','orf','rw2','raw','dng','pef','rwl','iiq','3fr','fff','dcr','kdc','mrw','mef','mos','x3f','erf','gpr','braw'";

/// Lowercased video file extensions, used together with `asset_type = 'VIDEO'`
/// to detect videos. Hardcoded constants (no user input).
const VIDEO_EXTENSIONS_SQL: &str = "'mp4','mov','webm','mkv','avi','m4v','3gp','3g2','mts','m2ts','ts','wmv','flv','mpg','mpeg','ogv'";

fn raw_predicate() -> String {
    format!(
        "LOWER(COALESCE(file_extension, '')) IN ({})",
        RAW_EXTENSIONS_SQL
    )
}

fn video_predicate() -> String {
    format!(
        "(UPPER(COALESCE(asset_type, '')) = 'VIDEO' OR LOWER(COALESCE(file_extension, '')) IN ({}))",
        VIDEO_EXTENSIONS_SQL
    )
}

fn normalize_date_only(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.len() != 10 {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if bytes
        .iter()
        .enumerate()
        .any(|(idx, b)| idx != 4 && idx != 7 && !b.is_ascii_digit())
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn normalized_asset_day(input: Option<&str>) -> Option<String> {
    let value = input?;
    if value.len() < 10 {
        return None;
    }
    normalize_date_only(&value[0..10])
}

fn load_my_photos_rules(conn: &Connection) -> Vec<MyPhotosRule> {
    let mut stmt = match conn.prepare("SELECT value FROM settings WHERE key = ?1") {
        Ok(stmt) => stmt,
        Err(err) => {
            log::warn!("[my-photos.rules] failed to prepare settings query: {}", err);
            return Vec::new();
        }
    };

    let raw = stmt
        .query_row(params!["my_photos_rules"], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| "[]".to_string());

    match serde_json::from_str::<Vec<MyPhotosRule>>(&raw) {
        Ok(rules) => rules,
        Err(err) => {
            log::warn!("[my-photos.rules] failed to parse settings value: {}", err);
            Vec::new()
        }
    }
}

fn rule_matches_asset(rule: &MyPhotosRule, camera: &str, day: &str, today: &str) -> bool {
    let rule_camera = rule.camera.trim();
    if rule_camera.is_empty() || rule_camera != camera {
        return false;
    }

    let Some(start_day) = normalize_date_only(&rule.start_date) else {
        return false;
    };

    if day < start_day.as_str() {
        return false;
    }

    if rule.end_date_current {
        return day <= today;
    }

    let Some(end_day) = rule
        .end_date
        .as_deref()
        .and_then(normalize_date_only)
    else {
        return false;
    };

    if end_day < start_day {
        return false;
    }

    day <= end_day.as_str()
}

/// Build the optional `AND <id_column> IN (SELECT id FROM assets WHERE ...)`
/// fragment plus its bind parameters for the given criteria. The fragment is
/// self-contained (always selects from the `assets` table) so it can be appended
/// to any query regardless of its FROM/JOIN structure. `id_column` is the asset
/// id column reference in the outer query (e.g. "id" or "a.id").
///
/// `start_index` is the number of the first `?N` placeholder this fragment may
/// use; it MUST equal one past the highest positional placeholder already in the
/// outer query (e.g. a query ending in `LIMIT ?2 OFFSET ?3` passes
/// `start_index = 4`). Explicit numbering is required because the fragment is
/// spliced into the middle of the query (before any trailing `LIMIT`/`OFFSET`):
/// bare `?` placeholders would be numbered by text position and collide with the
/// trailing `?N`. The returned params MUST be bound after the outer query's
/// positional params so binding order matches the assigned numbers.
fn criteria_filter(
    conn: &Connection,
    criteria: Option<&AssetFilterCriteria>,
    id_column: &str,
    start_index: usize,
) -> (String, DynParams) {
    let mut params: DynParams = Vec::new();
    let Some(criteria) = criteria.filter(|c| !c.is_empty()) else {
        return (String::new(), params);
    };

    let mut conditions: Vec<String> = Vec::new();
    let mut next_index = start_index;

    if let Some(rating) = criteria.rating {
        if (1..=5).contains(&rating) {
            let op = match criteria.rating_mode.as_deref() {
                Some("gte") => ">=",
                Some("lte") => "<=",
                _ => "=",
            };
            conditions.push(format!("COALESCE(rating, 0) {} ?{}", op, next_index));
            params.push(Box::new(rating));
            next_index += 1;
        }
    }

    if criteria.favorite_only == Some(true) {
        conditions.push("is_favorite = 1".to_string());
    }

    if criteria.my_photos_only == Some(true) {
        let rules = load_my_photos_rules(conn);
        let mut rule_conditions: Vec<String> = Vec::new();
        let mut valid_rule_count = 0usize;

        for rule in rules {
            let camera = rule.camera.trim();
            let Some(start_day) = normalize_date_only(&rule.start_date) else {
                continue;
            };
            if camera.is_empty() {
                continue;
            }

            let end_day = if rule.end_date_current {
                None
            } else {
                let Some(end_day) = rule.end_date.as_deref().and_then(normalize_date_only) else {
                    continue;
                };
                if end_day < start_day {
                    continue;
                }
                Some(end_day)
            };

            let mut clause = format!(
                "(camera = ?{} AND file_created_at IS NOT NULL AND substr(file_created_at, 1, 10) >= ?{}",
                next_index,
                next_index + 1
            );
            params.push(Box::new(camera.to_string()));
            params.push(Box::new(start_day.clone()));
            next_index += 2;

            if rule.end_date_current {
                clause.push_str(" AND substr(file_created_at, 1, 10) <= date('now', 'localtime'))");
            } else if let Some(end_day) = end_day {
                clause.push_str(&format!(" AND substr(file_created_at, 1, 10) <= ?{})", next_index));
                params.push(Box::new(end_day));
                next_index += 1;
            }

            valid_rule_count += 1;
            rule_conditions.push(clause);
        }

        if rule_conditions.is_empty() {
            log::warn!(
                "[my-photos.filter] active but no valid rules found; forcing empty result"
            );
            conditions.push("0=1".to_string());
        } else {
            log::warn!(
                "[my-photos.filter] active with {} valid rules",
                valid_rule_count
            );
            conditions.push(format!("({})", rule_conditions.join(" OR ")));
        }
    }

    match criteria.media_type.as_deref().map(str::trim) {
        Some("video") => conditions.push(video_predicate()),
        Some("raw") => {
            conditions.push(format!("(NOT {} AND {})", video_predicate(), raw_predicate()))
        }
        Some("photo") => conditions.push(format!(
            "(NOT {} AND NOT {})",
            video_predicate(),
            raw_predicate()
        )),
        Some("photo_raw") => conditions.push(format!("NOT {}", video_predicate())),
        _ => {}
    }

    if let Some(camera) = criteria.camera.as_deref().map(str::trim) {
        if !camera.is_empty() {
            conditions.push(format!("camera = ?{}", next_index));
            params.push(Box::new(camera.to_string()));
            next_index += 1;
        }
    }

    if let Some(person_id) = criteria.person_id.as_deref().map(str::trim) {
        if !person_id.is_empty() {
            conditions.push(format!(
                "id IN (SELECT asset_id FROM asset_people WHERE person_id = ?{})",
                next_index
            ));
            params.push(Box::new(person_id.to_string()));
            next_index += 1;
        }
    }

    let _ = next_index;

    if conditions.is_empty() {
        return (String::new(), Vec::new());
    }

    let fragment = format!(
        " AND {} IN (SELECT id FROM assets WHERE {})",
        id_column,
        conditions.join(" AND ")
    );
    (fragment, params)
}

/// Default ordered list of navigation menu items that can be toggled in the
/// sidebar. `settings` is intentionally excluded because it must always remain
/// reachable. Keep these keys in sync with the frontend `AppPage` values.
pub fn default_menu_items() -> Vec<String> {
    [
        "photos", "albums", "calendar", "folders", "favorites", "deleted",
    ]
    .iter()
    .map(|item| item.to_string())
    .collect()
}

fn default_menu_items_json() -> String {
    serde_json::to_string(&default_menu_items()).unwrap_or_else(|_| "[]".to_string())
}

fn normalize_locale(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "en-CA".to_string();
    }

    let normalized = trimmed.replace('_', "-").to_ascii_lowercase();
    if normalized.starts_with("fr") {
        "fr-CA".to_string()
    } else {
        "en-CA".to_string()
    }
}

fn detect_system_locale() -> String {
    let locale_hint = std::env::var("LC_ALL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("LC_MESSAGES")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("LANG")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "en-CA".to_string());

    normalize_locale(&locale_hint)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncState {
    pub id: String,
    pub total_assets: i32,
    pub processed_assets: i32,
    pub is_syncing: bool,
    pub last_sync_completed_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub check_status: String, // idle, checking, error
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingMutation {
    pub id: i64,
    pub asset_id: String,
    pub kind: String,
    pub payload_json: String,
    pub created_at: String,
}#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSummaryExtended {
    pub id: String,
    pub original_file_name: String,
    pub description: Option<String>,
    pub original_path: Option<String>,
    pub file_created_at: Option<String>,
    pub checksum: Option<String>,
    pub r#type: Option<String>,
    pub duration: Option<String>,
    pub is_favorite: bool,
    pub is_archived: bool,
    pub visibility: Option<String>,
    pub rating: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub thumbhash: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub file_size_bytes: Option<i64>,
    pub file_extension: Option<String>,
    pub people: Option<String>,
    pub tags: Option<String>,
    pub exif_info_json: Option<String>,
    pub is_my_photo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedAlbumSummary {
    pub id: String,
    pub album_name: String,
    pub album_thumbnail_asset_id: Option<String>,
    pub owner_id: String,
    pub shared: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub asset_count: Option<u32>,
    pub owner_name: Option<String>,
    pub owner_email: Option<String>,
    pub description: Option<String>,
}

pub struct Database {
    db_path: PathBuf,
}

impl Database {
    pub fn new() -> Result<Self, String> {
        let mut app_dir = dirs_home().ok_or_else(|| "cannot resolve home directory".to_string())?;
        app_dir.push(".config");
        app_dir.push("immich-local-app");
        fs::create_dir_all(&app_dir).map_err(|err| err.to_string())?;

        let db_path = app_dir.join("db.sqlite");
        let db = Self { db_path };
        db.init()?;
        Ok(db)
    }

    fn init(&self) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                original_file_name TEXT NOT NULL,
                description TEXT,
                original_path TEXT,
                file_created_at TEXT,
                checksum TEXT,
                updated_at INTEGER NOT NULL,
                asset_type TEXT,
                duration TEXT,
                is_favorite BOOLEAN DEFAULT 0,
                is_archived BOOLEAN DEFAULT 0,
                visibility TEXT,
                rating INTEGER,
                width INTEGER,
                height INTEGER,
                thumbhash TEXT,
                camera TEXT,
                lens TEXT,
                file_size_bytes INTEGER,
                file_extension TEXT,
                people TEXT,
                tags TEXT,
                exif_info_json TEXT
            );
            CREATE TABLE IF NOT EXISTS albums (
                id TEXT PRIMARY KEY,
                album_name TEXT NOT NULL,
                album_thumbnail_asset_id TEXT,
                owner_id TEXT NOT NULL,
                shared BOOLEAN DEFAULT 0,
                created_at TEXT,
                updated_at TEXT,
                start_date TEXT,
                end_date TEXT,
                asset_count INTEGER,
                owner_name TEXT,
                owner_email TEXT,
                description TEXT
            );
            CREATE TABLE IF NOT EXISTS album_assets (
                album_id TEXT NOT NULL,
                asset_id TEXT NOT NULL,
                PRIMARY KEY (album_id, asset_id)
            );
            CREATE TABLE IF NOT EXISTS people (
                id TEXT PRIMARY KEY,
                name TEXT,
                is_hidden BOOLEAN DEFAULT 0,
                thumbnail_path TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS asset_people (
                asset_id TEXT NOT NULL,
                person_id TEXT NOT NULL,
                PRIMARY KEY (asset_id, person_id)
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                id TEXT PRIMARY KEY,
                total_assets INTEGER NOT NULL,
                processed_assets INTEGER NOT NULL DEFAULT 0,
                is_syncing BOOLEAN DEFAULT 0,
                last_sync_completed_at TEXT,
                last_checked_at TEXT,
                check_status TEXT DEFAULT 'idle',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending_mutations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            ",
        )
        .map_err(|err| err.to_string())?;

        // Add missing columns to sync_state if they don't exist (migration)
        let conn = self.open()?;

        // Check if last_checked_at column exists
        let has_last_checked = conn
            .prepare("PRAGMA table_info(sync_state)")
            .ok()
            .and_then(|mut stmt| {
                let mut has_col = false;
                let _ = stmt.query_map([], |row| {
                    let col_name: String = row.get(1)?;
                    if col_name == "last_checked_at" {
                        has_col = true;
                    }
                    Ok(())
                });
                Some(has_col)
            })
            .unwrap_or(false);

        if !has_last_checked {
            let _ = conn.execute("ALTER TABLE sync_state ADD COLUMN last_checked_at TEXT", []);
        }

        // Check if check_status column exists
        let has_check_status = conn
            .prepare("PRAGMA table_info(sync_state)")
            .ok()
            .and_then(|mut stmt| {
                let mut has_col = false;
                let _ = stmt.query_map([], |row| {
                    let col_name: String = row.get(1)?;
                    if col_name == "check_status" {
                        has_col = true;
                    }
                    Ok(())
                });
                Some(has_col)
            })
            .unwrap_or(false);

        if !has_check_status {
            let _ = conn.execute(
                "ALTER TABLE sync_state ADD COLUMN check_status TEXT DEFAULT 'idle'",
                [],
            );
        }

        // Add missing columns to assets table if they don't exist (migration)
        let conn = self.open()?;
        let mut stmt = conn
            .prepare("PRAGMA table_info(assets)")
            .map_err(|err| err.to_string())?;
        let mut columns = Vec::new();
        stmt.query_map([], |row| {
            let col_name: String = row.get(1)?;
            columns.push(col_name);
            Ok(())
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

        drop(stmt);

        // List of columns that might be missing
        let required_columns = vec![
            ("asset_type", "TEXT"),
            ("description", "TEXT"),
            ("original_path", "TEXT"),
            ("camera", "TEXT"),
            ("lens", "TEXT"),
            ("file_size_bytes", "INTEGER"),
            ("file_extension", "TEXT"),
            ("people", "TEXT"),
            ("tags", "TEXT"),
            ("width", "INTEGER"),
            ("height", "INTEGER"),
            ("thumbhash", "TEXT"),
            ("exif_info_json", "TEXT"),
        ];

        for (col_name, col_type) in required_columns {
            if !columns.contains(&col_name.to_string()) {
                let alter_sql = format!("ALTER TABLE assets ADD COLUMN {} {}", col_name, col_type);
                let _ = conn.execute(&alter_sql, []);
            }
        }

        // Initialize default settings if not exist
        let conn = self.open()?;
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('live_photo_autoplay', 'true')",
            [],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('user_local_folder_path', '')",
            [],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('menu_items', ?1)",
            params![default_menu_items_json()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('my_photos_rules', '[]')",
            [],
        )
        .map_err(|err| err.to_string())?;
        let default_locale = detect_system_locale();
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('locale', ?1)",
            params![default_locale],
        )
        .map_err(|err| err.to_string())?;

        Ok(())
    }

    pub fn save_auth_credentials(&self, server_url: &str, api_key: &str) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('server_url', ?1)",
            params![server_url],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key', ?1)",
            params![api_key],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Returns the persisted auth credentials as `(server_url, token, is_oauth)`.
    /// `is_oauth` is `true` when the stored token is an Immich OAuth session
    /// token (key `oauth_token`) and `false` when it is an API key (key
    /// `api_key`). The caller must use this flag to pick the correct
    /// authentication mechanism: OAuth session tokens authenticate via the
    /// session cookie, API keys via the `x-api-key` header.
    pub fn get_auth_credentials(&self) -> Result<Option<(String, String, bool)>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = ?1")
            .map_err(|err| err.to_string())?;

        let server_url = stmt
            .query_row(params!["server_url"], |row| row.get::<_, String>(0))
            .ok();

        // Prefer an OAuth session token; fall back to an API key.
        let oauth_token = stmt
            .query_row(params!["oauth_token"], |row| row.get::<_, String>(0))
            .ok()
            .filter(|value| !value.is_empty());

        let (token, is_oauth) = match oauth_token {
            Some(token) => (Some(token), true),
            None => (
                stmt.query_row(params!["api_key"], |row| row.get::<_, String>(0))
                    .ok()
                    .filter(|value| !value.is_empty()),
                false,
            ),
        };

        match (server_url, token) {
            (Some(url), Some(key)) if !url.is_empty() && !key.is_empty() => {
                Ok(Some((url, key, is_oauth)))
            }
            _ => Ok(None),
        }
    }

    pub fn clear_auth_credentials(&self) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "DELETE FROM settings WHERE key IN ('server_url', 'api_key', 'oauth_token')",
            [],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Clear all locally cached library data for sign-out while preserving
    /// user preferences/settings. This removes cached assets, albums, people,
    /// sync state, pending offline mutations, and auth/user identity keys.
    pub fn clear_local_library_cache(&self) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;

        tx.execute("DELETE FROM asset_people", [])
            .map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM album_assets", [])
            .map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM pending_mutations", [])
            .map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM people", [])
            .map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM albums", [])
            .map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM assets", [])
            .map_err(|err| err.to_string())?;
        tx.execute("DELETE FROM sync_state", [])
            .map_err(|err| err.to_string())?;
        tx.execute(
            "DELETE FROM settings WHERE key IN ('server_url', 'api_key', 'oauth_token', 'user_id', 'user_name')",
            [],
        )
        .map_err(|err| err.to_string())?;

        // Reset AUTOINCREMENT for pending mutation ids.
        tx.execute("DELETE FROM sqlite_sequence WHERE name = 'pending_mutations'", [])
            .map_err(|err| err.to_string())?;

        tx.commit().map_err(|err| err.to_string())
    }

    pub fn save_oauth_token(&self, server_url: &str, access_token: &str) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('server_url', ?1)",
            params![server_url],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('oauth_token', ?1)",
            params![access_token],
        )
        .map_err(|err| err.to_string())?;

        // Clear any old API key
        conn.execute("DELETE FROM settings WHERE key = 'api_key'", [])
            .map_err(|err| err.to_string())?;

        Ok(())
    }

    /// Persist the authenticated user's identity so the app can restore a
    /// session and render the UI while offline (without contacting the server).
    pub fn save_user_info(&self, user_id: &str, user_name: Option<&str>) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('user_id', ?1)",
            params![user_id],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('user_name', ?1)",
            params![user_name.unwrap_or("")],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Returns the cached `(user_id, user_name)` for offline session restore, or
    /// `None` when no user identity has been persisted yet.
    pub fn get_user_info(&self) -> Result<Option<(String, Option<String>)>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = ?1")
            .map_err(|err| err.to_string())?;

        let user_id = stmt
            .query_row(params!["user_id"], |row| row.get::<_, String>(0))
            .ok()
            .filter(|value| !value.is_empty());

        let user_name = stmt
            .query_row(params!["user_name"], |row| row.get::<_, String>(0))
            .ok()
            .filter(|value| !value.is_empty());

        Ok(user_id.map(|id| (id, user_name)))
    }

    /// Enqueue an asset mutation that could not be sent to the server (because
    /// it was offline) so it can be replayed once connectivity is restored.
    pub fn enqueue_mutation(
        &self,
        asset_id: &str,
        kind: &str,
        payload_json: &str,
    ) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO pending_mutations (asset_id, kind, payload_json, created_at)
             VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
            params![asset_id, kind, payload_json],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// List queued mutations in the order they were created (oldest first).
    pub fn list_pending_mutations(&self) -> Result<Vec<PendingMutation>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, asset_id, kind, payload_json, created_at
                 FROM pending_mutations ORDER BY id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PendingMutation {
                    id: row.get(0)?,
                    asset_id: row.get(1)?,
                    kind: row.get(2)?,
                    payload_json: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

    /// Remove a queued mutation after it has been successfully replayed.
    pub fn delete_pending_mutation(&self, id: i64) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute("DELETE FROM pending_mutations WHERE id = ?1", params![id])
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Count of queued mutations awaiting replay.
    pub fn count_pending_mutations(&self) -> Result<i64, String> {
        let conn = self.open()?;
        conn.query_row("SELECT COUNT(*) FROM pending_mutations", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|err| err.to_string())
    }

    fn open(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err(|err| err.to_string())
    }

    pub fn upsert_assets(&self, assets: &[AssetSummary]) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;

        for asset in assets {
            tx.execute(
                "
                INSERT INTO assets (
                    id, original_file_name, original_path, file_created_at, checksum, updated_at,
                    asset_type, duration, is_favorite, is_archived, visibility, rating, width, height, thumbhash
                )
                VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s', 'now'), ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(id) DO UPDATE SET
                    original_file_name = excluded.original_file_name,
                    original_path = excluded.original_path,
                    file_created_at = excluded.file_created_at,
                    checksum = excluded.checksum,
                    updated_at = excluded.updated_at,
                    asset_type = excluded.asset_type,
                    duration = excluded.duration,
                    is_favorite = excluded.is_favorite,
                    is_archived = excluded.is_archived,
                    visibility = excluded.visibility,
                    rating = excluded.rating,
                    width = excluded.width,
                    height = excluded.height,
                    thumbhash = excluded.thumbhash
                ",
                params![
                    asset.id,
                    asset.original_file_name,
                    asset.original_path,
                    asset.file_created_at,
                    asset.checksum,
                    asset.r#type,
                    asset.duration,
                    asset.is_favorite as i32,
                    asset.is_archived as i32,
                    asset.visibility,
                    asset.rating,
                    asset.width,
                    asset.height,
                    asset.thumbhash
                ],
            )
            .map_err(|err| err.to_string())?;
        }

        tx.commit().map_err(|err| err.to_string())
    }

    /// Count how many of the given asset ids are NOT yet present in the local
    /// cache. Used by quick sync to detect when a newest-first page has reached
    /// already-known assets so it can stop paging early instead of re-scanning
    /// the entire library.
    pub fn count_new_asset_ids(&self, ids: &[String]) -> Result<usize, String> {
        if ids.is_empty() {
            return Ok(0);
        }

        let conn = self.open()?;
        let mut existing = 0usize;

        for id in ids {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(1) FROM assets WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;

            if count > 0 {
                existing += 1;
            }
        }

        Ok(ids.len() - existing)
    }

    /// Return the subset of the given asset ids that already exist in the local
    /// cache. Quick sync uses this to skip the expensive per-asset metadata
    /// fetch + re-write for already-cached assets that fall outside the recent
    /// overlap window, so pressing "Check for New Photos" returns quickly when
    /// there is nothing new.
    pub fn get_existing_asset_ids(&self, ids: &[String]) -> Result<HashSet<String>, String> {
        if ids.is_empty() {
            return Ok(HashSet::new());
        }

        let conn = self.open()?;
        let mut existing = HashSet::with_capacity(ids.len());

        for id in ids {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(1) FROM assets WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;

            if found > 0 {
                existing.insert(id.clone());
            }
        }

        Ok(existing)
    }

    pub fn get_asset_ids_in_created_at_window(
        &self,
        window_start: &str,
        window_end: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "
                SELECT id
                FROM assets
                WHERE file_created_at IS NOT NULL
                  AND julianday(file_created_at) >= julianday(?1)
                  AND julianday(file_created_at) <= julianday(?2)
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![window_start, window_end], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;

        let mut ids = Vec::new();
        for row in rows {
            ids.push(row.map_err(|err| err.to_string())?);
        }

        Ok(ids)
    }

    pub fn delete_assets_and_links_by_ids(&self, ids: &[String]) -> Result<usize, String> {
        if ids.is_empty() {
            return Ok(0);
        }

        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let placeholders = (1..=ids.len())
            .map(|index| format!("?{}", index))
            .collect::<Vec<_>>()
            .join(",");

        let delete_asset_people_sql =
            format!("DELETE FROM asset_people WHERE asset_id IN ({})", placeholders);
        tx.execute(&delete_asset_people_sql, params_from_iter(ids.iter()))
            .map_err(|err| err.to_string())?;

        let delete_album_assets_sql =
            format!("DELETE FROM album_assets WHERE asset_id IN ({})", placeholders);
        tx.execute(&delete_album_assets_sql, params_from_iter(ids.iter()))
            .map_err(|err| err.to_string())?;

        let delete_pending_mutations_sql =
            format!("DELETE FROM pending_mutations WHERE asset_id IN ({})", placeholders);
        tx.execute(&delete_pending_mutations_sql, params_from_iter(ids.iter()))
            .map_err(|err| err.to_string())?;

        let delete_assets_sql = format!("DELETE FROM assets WHERE id IN ({})", placeholders);
        let deleted = tx
            .execute(&delete_assets_sql, params_from_iter(ids.iter()))
            .map_err(|err| err.to_string())?;

        tx.commit().map_err(|err| err.to_string())?;
        Ok(deleted)
    }

    pub fn upsert_assets_with_metadata(
        &self,
        assets: &[AssetSummaryExtended],
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;

        for asset in assets {
            tx.execute(
                "
                INSERT INTO assets (
                    id, original_file_name, description, original_path, file_created_at, checksum, updated_at,
                    asset_type, duration, is_favorite, is_archived, visibility, rating,
                    width, height, thumbhash, camera, lens, file_size_bytes, file_extension, people, tags, exif_info_json
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s', 'now'), ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                ON CONFLICT(id) DO UPDATE SET
                    original_file_name = excluded.original_file_name,
                    description = excluded.description,
                    original_path = excluded.original_path,
                    file_created_at = excluded.file_created_at,
                    checksum = excluded.checksum,
                    updated_at = excluded.updated_at,
                    asset_type = excluded.asset_type,
                    duration = excluded.duration,
                    is_favorite = excluded.is_favorite,
                    is_archived = excluded.is_archived,
                    visibility = excluded.visibility,
                    rating = excluded.rating,
                    width = excluded.width,
                    height = excluded.height,
                    thumbhash = excluded.thumbhash,
                    camera = excluded.camera,
                    lens = excluded.lens,
                    file_size_bytes = excluded.file_size_bytes,
                    file_extension = excluded.file_extension,
                    people = excluded.people,
                    tags = excluded.tags,
                    exif_info_json = excluded.exif_info_json
                ",
                params![
                    asset.id,
                    asset.original_file_name,
                    asset.description,
                    asset.original_path,
                    asset.file_created_at,
                    asset.checksum,
                    asset.r#type,
                    asset.duration,
                    asset.is_favorite as i32,
                    asset.is_archived as i32,
                    asset.visibility,
                    asset.rating,
                    asset.width,
                    asset.height,
                    asset.thumbhash,
                    asset.camera,
                    asset.lens,
                    asset.file_size_bytes,
                    asset.file_extension,
                    asset.people,
                    asset.tags,
                    asset.exif_info_json
                ],
            )
            .map_err(|err| err.to_string())?;
        }

        tx.commit().map_err(|err| err.to_string())
    }

    pub fn update_asset_description(
        &self,
        asset_id: &str,
        description: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE assets SET description = ?2, updated_at = strftime('%s', 'now') WHERE id = ?1",
            params![asset_id, description],
        )
        .map_err(|err| err.to_string())?;

        Ok(())
    }

    pub fn update_asset_favorite(
        &self,
        asset_id: &str,
        is_favorite: bool,
    ) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE assets SET is_favorite = ?2, updated_at = strftime('%s', 'now') WHERE id = ?1",
            params![asset_id, is_favorite],
        )
        .map_err(|err| err.to_string())?;

        Ok(())
    }

    pub fn update_asset_visibility(
        &self,
        asset_id: &str,
        visibility: &str,
    ) -> Result<(), String> {
        let is_archived = visibility.eq_ignore_ascii_case("archive");
        let conn = self.open()?;
        conn.execute(
            "UPDATE assets SET visibility = ?2, is_archived = ?3, updated_at = strftime('%s', 'now') WHERE id = ?1",
            params![asset_id, visibility, is_archived],
        )
        .map_err(|err| err.to_string())?;

        Ok(())
    }

    pub fn update_asset_rating(&self, asset_id: &str, rating: Option<i32>) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute(
            "UPDATE assets SET rating = ?2, updated_at = strftime('%s', 'now') WHERE id = ?1",
            params![asset_id, rating],
        )
        .map_err(|err| err.to_string())?;

        Ok(())
    }

    pub fn get_assets(
        &self,
        page: u32,
        page_size: u32,
        search: Option<&str>,
        filter: Option<&str>,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);

        let limit = i64::from(page_size) + 1;
        let search_pattern = search_pattern(search);
        let filter_clause = asset_filter_where_clause(filter);
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause();

        let mut items = if let Some(pattern) = search_pattern.as_deref() {
            // Criteria placeholders start after ?1=limit, ?2=offset, ?3=pattern.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 4);
            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE
                        (
                            original_file_name LIKE ?3 COLLATE NOCASE
                            OR COALESCE(camera, '') LIKE ?3 COLLATE NOCASE
                            OR COALESCE(lens, '') LIKE ?3 COLLATE NOCASE
                            OR COALESCE(file_extension, '') LIKE ?3 COLLATE NOCASE
                            OR COALESCE(people, '') LIKE ?3 COLLATE NOCASE
                            OR COALESCE(tags, '') LIKE ?3 COLLATE NOCASE
                        )
                        AND ({}){}
                    ORDER BY {}
                    LIMIT ?1 OFFSET ?2
                    ",
                filter_clause, criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let mut bind: DynParams =
                vec![Box::new(limit), Box::new(offset), Box::new(pattern.to_string())];
            bind.extend(criteria_params);

            let rows = stmt
                .query_map(params_from_iter(bind.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;

            let mut branch_items = Vec::new();
            for row in rows {
                branch_items.push(row.map_err(|err| err.to_string())?);
            }

            branch_items
        } else {
            // Criteria placeholders start after ?1=limit, ?2=offset.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 3);
            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE ({}){}
                    ORDER BY {}
                    LIMIT ?1 OFFSET ?2
                    ",
                filter_clause, criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let mut bind: DynParams = vec![Box::new(limit), Box::new(offset)];
            bind.extend(criteria_params);

            let rows = stmt
                .query_map(params_from_iter(bind.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;

            let mut branch_items = Vec::new();
            for row in rows {
                branch_items.push(row.map_err(|err| err.to_string())?);
            }

            branch_items
        };

        let has_next_page = items.len() > page_size as usize;
        if has_next_page {
            items.truncate(page_size as usize);
        }

        Ok((items, has_next_page))
    }

    pub fn get_all_assets(
        &self,
        search: Option<&str>,
        filter: Option<&str>,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<Vec<AssetSummary>, String> {
        let conn = self.open()?;
        let search_pattern = search_pattern(search);
        let filter_clause = asset_filter_where_clause(filter);
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause();

        let items = if let Some(pattern) = search_pattern.as_deref() {
            // Criteria placeholders start after ?1=pattern.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 2);
            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE
                        (
                            original_file_name LIKE ?1 COLLATE NOCASE
                            OR COALESCE(camera, '') LIKE ?1 COLLATE NOCASE
                            OR COALESCE(lens, '') LIKE ?1 COLLATE NOCASE
                            OR COALESCE(file_extension, '') LIKE ?1 COLLATE NOCASE
                            OR COALESCE(people, '') LIKE ?1 COLLATE NOCASE
                            OR COALESCE(tags, '') LIKE ?1 COLLATE NOCASE
                        )
                        AND ({}){}
                    ORDER BY {}
                    ",
                filter_clause, criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let mut bind: DynParams = vec![Box::new(pattern.to_string())];
            bind.extend(criteria_params);

            let rows = stmt
                .query_map(params_from_iter(bind.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;

            let mut branch_items = Vec::new();
            for row in rows {
                branch_items.push(row.map_err(|err| err.to_string())?);
            }

            branch_items
        } else {
            // No positional params; criteria placeholders start at ?1.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 1);
            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE ({}){}
                    ORDER BY {}
                    ",
                filter_clause, criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map(params_from_iter(criteria_params.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;

            let mut branch_items = Vec::new();
            for row in rows {
                branch_items.push(row.map_err(|err| err.to_string())?);
            }

            branch_items
        };

        Ok(items)
    }

        pub fn get_asset_days(
                &self,
                search: Option<&str>,
                filter: Option<&str>,
                criteria: Option<&AssetFilterCriteria>,
                sort: Option<&SortParams>,
        ) -> Result<Vec<String>, String> {
        let conn = self.open()?;
        let search_pattern = search_pattern(search);
                let filter_clause = asset_filter_where_clause(filter);
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let day_order = sort.day_key_order();

        let days = if let Some(pattern) = search_pattern.as_deref() {
                        // Criteria placeholders start after ?1=pattern.
                        let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 2);
                        let query = format!(
                                "
                                        SELECT DISTINCT substr(file_created_at, 1, 10) AS day_key
                                        FROM assets
                                        WHERE file_created_at IS NOT NULL
                                            AND length(file_created_at) >= 10
                                            AND (
                                                original_file_name LIKE ?1 COLLATE NOCASE
                                                OR COALESCE(camera, '') LIKE ?1 COLLATE NOCASE
                                                OR COALESCE(lens, '') LIKE ?1 COLLATE NOCASE
                                                OR COALESCE(file_extension, '') LIKE ?1 COLLATE NOCASE
                                                OR COALESCE(people, '') LIKE ?1 COLLATE NOCASE
                                                OR COALESCE(tags, '') LIKE ?1 COLLATE NOCASE
                                            )
                                            AND ({}){}
                                        ORDER BY day_key {}
                                        ",
                                filter_clause, criteria_sql, day_order
                        );
            let mut stmt = conn
                                .prepare(&query)
                .map_err(|err| err.to_string())?;

            let mut bind: DynParams = vec![Box::new(pattern.to_string())];
            bind.extend(criteria_params);

            let rows = stmt
                .query_map(params_from_iter(bind.iter()), |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;

            let mut branch_days = Vec::new();
            for row in rows {
                branch_days.push(row.map_err(|err| err.to_string())?);
            }

            branch_days
        } else {
            // No positional params; criteria placeholders start at ?1.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 1);
            let query = format!(
                "
                    SELECT DISTINCT substr(file_created_at, 1, 10) AS day_key
                    FROM assets
                    WHERE file_created_at IS NOT NULL
                      AND length(file_created_at) >= 10
                      AND ({}){}
                    ORDER BY day_key {}
                    ",
                filter_clause, criteria_sql, day_order
            );
            let mut stmt = conn
                .prepare(&query)
                .map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map(params_from_iter(criteria_params.iter()), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|err| err.to_string())?;

            let mut branch_days = Vec::new();
            for row in rows {
                branch_days.push(row.map_err(|err| err.to_string())?);
            }

            branch_days
        };

        Ok(days)
    }

    pub fn get_asset_details(
        &self,
        asset_id: &str,
    ) -> Result<Option<AssetSummaryExtended>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "
                SELECT
                    id,
                    original_file_name,
                    description,
                    original_path,
                    file_created_at,
                    checksum,
                    asset_type,
                    duration,
                    is_favorite,
                    is_archived,
                    visibility,
                    rating,
                    width,
                    height,
                    thumbhash,
                    camera,
                    lens,
                    file_size_bytes,
                    file_extension,
                    people,
                    tags,
                    exif_info_json
                FROM assets
                WHERE id = ?1
                LIMIT 1
                ",
            )
            .map_err(|err| err.to_string())?;

        let mut rows = stmt
            .query_map(params![asset_id], map_asset_summary_extended)
            .map_err(|err| err.to_string())?;

        match rows.next() {
            Some(result) => {
                let mut asset = result.map_err(|err| err.to_string())?;
                let rules = load_my_photos_rules(&conn);
                let day = normalized_asset_day(asset.file_created_at.as_deref());
                let camera = asset.camera.as_deref().map(str::trim).unwrap_or("");
                let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                asset.is_my_photo = match day {
                    Some(day) if !camera.is_empty() => rules
                        .iter()
                        .any(|rule| rule_matches_asset(rule, camera, &day, &today)),
                    _ => false,
                };
                Ok(Some(asset))
            }
            None => Ok(None),
        }
    }

    /// Read a single cached asset as an [`AssetSummary`], used to build optimistic
    /// responses for mutations applied locally while offline.
    pub fn get_asset_summary(&self, asset_id: &str) -> Result<Option<AssetSummary>, String> {
        let details = self.get_asset_details(asset_id)?;
        Ok(details.map(|asset| AssetSummary {
            id: asset.id,
            original_file_name: asset.original_file_name,
            original_path: asset.original_path,
            file_created_at: asset.file_created_at,
            checksum: asset.checksum,
            r#type: asset.r#type,
            duration: asset.duration,
            live_photo_video_id: None,
            is_favorite: asset.is_favorite,
            is_archived: asset.is_archived,
            visibility: asset.visibility,
            rating: asset.rating,
            width: asset.width,
            height: asset.height,
            thumbhash: asset.thumbhash,
        }))
    }

    pub fn get_asset_jump_target_page(
        &self,
        date_key: &str,
        page_size: u32,
        search: Option<&str>,
        filter: Option<&str>,
        criteria: Option<&AssetFilterCriteria>,
    ) -> Result<Option<u32>, String> {
        let conn = self.open()?;
        let search_pattern = search_pattern(search);
        let filter_clause = asset_filter_where_clause(filter);

        let exists = if let Some(pattern) = search_pattern.as_deref() {
            // Criteria placeholders start after ?1=date_key, ?2=pattern.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 3);
            let query = format!(
                "
                SELECT EXISTS(
                    SELECT 1
                    FROM assets
                    WHERE file_created_at IS NOT NULL
                      AND substr(file_created_at, 1, 10) = ?1
                      AND (
                        original_file_name LIKE ?2 COLLATE NOCASE
                        OR COALESCE(camera, '') LIKE ?2 COLLATE NOCASE
                        OR COALESCE(lens, '') LIKE ?2 COLLATE NOCASE
                        OR COALESCE(file_extension, '') LIKE ?2 COLLATE NOCASE
                        OR COALESCE(people, '') LIKE ?2 COLLATE NOCASE
                        OR COALESCE(tags, '') LIKE ?2 COLLATE NOCASE
                      )
                      AND ({}){}
                )
                ",
                filter_clause, criteria_sql
            );
            let mut bind: DynParams =
                vec![Box::new(date_key.to_string()), Box::new(pattern.to_string())];
            bind.extend(criteria_params);
            conn.query_row(&query, params_from_iter(bind.iter()), |row| {
                row.get::<_, i32>(0)
            })
        } else {
            // Criteria placeholders start after ?1=date_key.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 2);
            let query = format!(
                "
                SELECT EXISTS(
                    SELECT 1
                    FROM assets
                    WHERE file_created_at IS NOT NULL
                      AND substr(file_created_at, 1, 10) = ?1
                      AND ({}){}
                )
                ",
                filter_clause, criteria_sql
            );
            let mut bind: DynParams = vec![Box::new(date_key.to_string())];
            bind.extend(criteria_params);
            conn.query_row(&query, params_from_iter(bind.iter()), |row| {
                row.get::<_, i32>(0)
            })
        }
        .map_err(|err| err.to_string())?;

        if exists == 0 {
            return Ok(None);
        }

        let newer_count = if let Some(pattern) = search_pattern.as_deref() {
            // Criteria placeholders start after ?1=date_key, ?2=pattern.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 3);
            let query = format!(
                "
                                SELECT COUNT(*)
                                FROM assets
                                WHERE file_created_at IS NOT NULL
                                    AND substr(file_created_at, 1, 10) > ?1
                                    AND (
                                        original_file_name LIKE ?2 COLLATE NOCASE
                                        OR COALESCE(camera, '') LIKE ?2 COLLATE NOCASE
                                        OR COALESCE(lens, '') LIKE ?2 COLLATE NOCASE
                                        OR COALESCE(file_extension, '') LIKE ?2 COLLATE NOCASE
                                        OR COALESCE(people, '') LIKE ?2 COLLATE NOCASE
                                        OR COALESCE(tags, '') LIKE ?2 COLLATE NOCASE
                                    )
                                    AND ({}){}
                                ",
                filter_clause, criteria_sql
            );
            let mut bind: DynParams =
                vec![Box::new(date_key.to_string()), Box::new(pattern.to_string())];
            bind.extend(criteria_params);
            conn.query_row(&query, params_from_iter(bind.iter()), |row| {
                row.get::<_, i64>(0)
            })
        } else {
            // Criteria placeholders start after ?1=date_key.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 2);
            let query = format!(
                "
                                SELECT COUNT(*)
                                FROM assets
                                WHERE file_created_at IS NOT NULL
                                    AND substr(file_created_at, 1, 10) > ?1
                                    AND ({}){}
                                ",
                filter_clause, criteria_sql
            );
            let mut bind: DynParams = vec![Box::new(date_key.to_string())];
            bind.extend(criteria_params);
            conn.query_row(&query, params_from_iter(bind.iter()), |row| {
                row.get::<_, i64>(0)
            })
        }
        .map_err(|err| err.to_string())?;

        Ok(Some((newer_count as u32) / page_size))
    }

    pub fn upsert_albums(
        &self,
        albums: &[crate::services::immich_client::AlbumSummary],
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;

        for album in albums {
            tx.execute(
                "
                INSERT INTO albums (
                    id, album_name, album_thumbnail_asset_id, owner_id, shared,
                    created_at, updated_at, start_date, end_date, asset_count,
                    owner_name, owner_email, description
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                ON CONFLICT(id) DO UPDATE SET
                    album_name = excluded.album_name,
                    album_thumbnail_asset_id = excluded.album_thumbnail_asset_id,
                    owner_id = excluded.owner_id,
                    shared = excluded.shared,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    start_date = excluded.start_date,
                    end_date = excluded.end_date,
                    asset_count = excluded.asset_count,
                    owner_name = excluded.owner_name,
                    owner_email = excluded.owner_email,
                    description = excluded.description
                ",
                params![
                    album.id,
                    album.album_name,
                    album.album_thumbnail_asset_id,
                    album.owner_id,
                    album.shared as i32,
                    album.created_at,
                    album.updated_at,
                    album.start_date,
                    album.end_date,
                    album.asset_count,
                    album.owner.as_ref().and_then(|owner| owner.name.clone()),
                    album.owner.as_ref().and_then(|owner| owner.email.clone()),
                    album.description,
                ],
            )
            .map_err(|err| err.to_string())?;
        }

        tx.commit().map_err(|err| err.to_string())
    }

    pub fn get_albums(&self) -> Result<Vec<CachedAlbumSummary>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "
                SELECT id, album_name, album_thumbnail_asset_id, owner_id, shared,
                       created_at, updated_at, start_date, end_date, asset_count,
                       owner_name, owner_email, description
                FROM albums
                ORDER BY COALESCE(start_date, created_at, updated_at) DESC
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(CachedAlbumSummary {
                    id: row.get(0)?,
                    album_name: row.get(1)?,
                    album_thumbnail_asset_id: row.get(2)?,
                    owner_id: row.get(3)?,
                    shared: row.get::<_, Option<i32>>(4)?.unwrap_or(0) != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    start_date: row.get(7)?,
                    end_date: row.get(8)?,
                    asset_count: row.get(9)?,
                    owner_name: row.get(10)?,
                    owner_email: row.get(11)?,
                    description: row.get(12)?,
                })
            })
            .map_err(|err| err.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|err| err.to_string())?);
        }

        Ok(items)
    }

    pub fn has_album(&self, album_id: &str) -> Result<bool, String> {
        let conn = self.open()?;
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                params![album_id],
                |row| row.get::<_, i32>(0),
            )
            .map_err(|err| err.to_string())?;

        Ok(exists != 0)
    }

    pub fn replace_album_assets(&self, album_id: &str, asset_ids: &[String]) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;

        tx.execute(
            "DELETE FROM album_assets WHERE album_id = ?1",
            params![album_id],
        )
        .map_err(|err| err.to_string())?;

        for asset_id in asset_ids {
            tx.execute(
                "INSERT INTO album_assets (album_id, asset_id) VALUES (?1, ?2)",
                params![album_id, asset_id],
            )
            .map_err(|err| err.to_string())?;
        }

        tx.commit().map_err(|err| err.to_string())
    }

    pub fn upsert_people(
        &self,
        people: &[crate::services::immich_client::PersonSummary],
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let now = chrono::Local::now().to_rfc3339();

        for person in people {
            tx.execute(
                "
                INSERT INTO people (id, name, is_hidden, thumbnail_path, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    is_hidden = excluded.is_hidden,
                    thumbnail_path = excluded.thumbnail_path,
                    updated_at = excluded.updated_at
                ",
                params![
                    person.id,
                    person.name,
                    person.is_hidden as i32,
                    person.thumbnail_path,
                    now,
                ],
            )
            .map_err(|err| err.to_string())?;
        }

        tx.commit().map_err(|err| err.to_string())
    }

    pub fn replace_asset_people(
        &self,
        asset_people: &[(String, Vec<String>)],
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|err| err.to_string())?;

        for (asset_id, person_ids) in asset_people {
            tx.execute(
                "DELETE FROM asset_people WHERE asset_id = ?1",
                params![asset_id],
            )
            .map_err(|err| err.to_string())?;

            for person_id in person_ids {
                tx.execute(
                    "INSERT OR IGNORE INTO asset_people (asset_id, person_id) VALUES (?1, ?2)",
                    params![asset_id, person_id],
                )
                .map_err(|err| err.to_string())?;
            }
        }

        tx.commit().map_err(|err| err.to_string())
    }

    pub fn get_album_assets(
        &self,
        album_id: &str,
        page: u32,
        page_size: u32,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);
        let limit = i64::from(page_size) + 1;
        // Criteria placeholders start after ?1=album_id, ?2=limit, ?3=offset.
        let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "a.id", 4);
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause_prefixed("a.");
        let query = format!(
            "
                SELECT
                    a.id,
                    a.original_file_name,
                    a.original_path,
                    a.file_created_at,
                    a.checksum,
                    a.asset_type,
                    a.duration,
                    a.is_favorite,
                    a.is_archived,
                    a.visibility,
                    a.rating,
                    a.width,
                    a.height,
                    a.thumbhash
                FROM album_assets aa
                JOIN assets a ON a.id = aa.asset_id
                WHERE aa.album_id = ?1{}
                ORDER BY {}
                LIMIT ?2 OFFSET ?3
                ",
            criteria_sql, order_by
        );
        let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

        let mut bind: DynParams = vec![
            Box::new(album_id.to_string()),
            Box::new(limit),
            Box::new(offset),
        ];
        bind.extend(criteria_params);

        let rows = stmt
            .query_map(params_from_iter(bind.iter()), map_asset_summary)
            .map_err(|err| err.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|err| err.to_string())?);
        }

        let has_next_page = items.len() > page_size as usize;
        if has_next_page {
            items.truncate(page_size as usize);
        }

        Ok((items, has_next_page))
    }

    pub fn get_all_album_assets(
        &self,
        album_id: &str,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<Vec<AssetSummary>, String> {
        let conn = self.open()?;
        // Criteria placeholders start after ?1=album_id.
        let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "a.id", 2);
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause_prefixed("a.");
        let query = format!(
            "
                SELECT
                    a.id,
                    a.original_file_name,
                    a.original_path,
                    a.file_created_at,
                    a.checksum,
                    a.asset_type,
                    a.duration,
                    a.is_favorite,
                    a.is_archived,
                    a.visibility,
                    a.rating,
                    a.width,
                    a.height,
                    a.thumbhash
                FROM album_assets aa
                JOIN assets a ON a.id = aa.asset_id
                WHERE aa.album_id = ?1{}
                ORDER BY {}
                ",
            criteria_sql, order_by
        );
        let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

        let mut bind: DynParams = vec![Box::new(album_id.to_string())];
        bind.extend(criteria_params);

        let rows = stmt
            .query_map(params_from_iter(bind.iter()), map_asset_summary)
            .map_err(|err| err.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|err| err.to_string())?);
        }

        Ok(items)
    }

    pub fn get_unique_original_paths(&self) -> Result<Vec<String>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "
                SELECT DISTINCT original_path
                FROM assets
                WHERE original_path IS NOT NULL AND original_path != ''
                ORDER BY original_path ASC
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;

        // original_path stores the full file path (e.g. /dir/file.jpg).
        // Extract the unique parent directories so the frontend can build the folder tree.
        let mut dir_set = std::collections::BTreeSet::new();
        for row in rows {
            let file_path = row.map_err(|err| err.to_string())?;
            if let Some(parent) = std::path::Path::new(&file_path).parent() {
                let parent_str = parent.to_string_lossy().into_owned();
                if !parent_str.is_empty() && parent_str != "." {
                    dir_set.insert(parent_str);
                }
            }
        }

        Ok(dir_set.into_iter().collect())
    }

    pub fn get_folder_assets(
        &self,
        path: &str,
        page: u32,
        page_size: u32,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);
        let limit = i64::from(page_size) + 1;
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause();

        // original_path stores the full file path (e.g. /dir/file.jpg).
        // Match assets whose parent directory equals `path` by checking:
        //   - the path starts with "{path}/" (direct child, not nested)
        //   - the remainder after "{path}/" contains no "/" (not a subdirectory)
        let mut items = Vec::new();

        if path == "/" {
            // Root: match paths with exactly one segment, e.g. /file.jpg
            // Criteria placeholders start after ?1=limit, ?2=offset.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 3);
            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE original_path LIKE '/%' AND original_path NOT LIKE '/%/%'{}
                    ORDER BY {}
                    LIMIT ?1 OFFSET ?2
                    ",
                criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let mut bind: DynParams = vec![Box::new(limit), Box::new(offset)];
            bind.extend(criteria_params);

            let rows = stmt
                .query_map(params_from_iter(bind.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;
            for row in rows {
                items.push(row.map_err(|err| err.to_string())?);
            }
        } else {
            // Non-root: match paths starting with "{path}/" where the rest has no "/"
            let path_prefix = format!("{}/", path);
            let like_pattern = format!("{}%", path_prefix);
            // 1-based position of the first character after the prefix (for substr)
            let remaining_start = (path_prefix.len() + 1) as i64;
            // Criteria placeholders start after ?1=like, ?2=remaining, ?3=limit, ?4=offset.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 5);

            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE original_path LIKE ?1
                      AND instr(substr(original_path, ?2), '/') = 0{}
                    ORDER BY {}
                    LIMIT ?3 OFFSET ?4
                    ",
                criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let mut bind: DynParams = vec![
                Box::new(like_pattern),
                Box::new(remaining_start),
                Box::new(limit),
                Box::new(offset),
            ];
            bind.extend(criteria_params);

            let rows = stmt
                .query_map(params_from_iter(bind.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;
            for row in rows {
                items.push(row.map_err(|err| err.to_string())?);
            }
        }

        let has_next_page = items.len() > page_size as usize;
        if has_next_page {
            items.truncate(page_size as usize);
        }

        Ok((items, has_next_page))
    }

    pub fn get_all_folder_assets(
        &self,
        path: &str,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<Vec<AssetSummary>, String> {
        let conn = self.open()?;
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause();

        let mut items = Vec::new();

        if path == "/" {
            // No positional params; criteria placeholders start at ?1.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 1);
            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE original_path LIKE '/%' AND original_path NOT LIKE '/%/%'{}
                    ORDER BY {}
                    ",
                criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map(params_from_iter(criteria_params.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;
            for row in rows {
                items.push(row.map_err(|err| err.to_string())?);
            }
        } else {
            let path_prefix = format!("{}/", path);
            let like_pattern = format!("{}%", path_prefix);
            let remaining_start = (path_prefix.len() + 1) as i64;
            // Criteria placeholders start after ?1=like, ?2=remaining.
            let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 3);

            let query = format!(
                "
                    SELECT
                        id,
                        original_file_name,
                        original_path,
                        file_created_at,
                        checksum,
                        asset_type,
                        duration,
                        is_favorite,
                        is_archived,
                        visibility,
                        rating,
                        width,
                        height,
                        thumbhash
                    FROM assets
                    WHERE original_path LIKE ?1
                      AND instr(substr(original_path, ?2), '/') = 0{}
                    ORDER BY {}
                    ",
                criteria_sql, order_by
            );
            let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

            let mut bind: DynParams =
                vec![Box::new(like_pattern), Box::new(remaining_start)];
            bind.extend(criteria_params);

            let rows = stmt
                .query_map(params_from_iter(bind.iter()), map_asset_summary)
                .map_err(|err| err.to_string())?;
            for row in rows {
                items.push(row.map_err(|err| err.to_string())?);
            }
        }

        Ok(items)
    }

    pub fn get_calendar_assets(
        &self,
        year: i32,
        month: u32,
        page: u32,
        page_size: u32,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);
        let limit = i64::from(page_size) + 1;
        let month_key = format!("{:04}-{:02}", year, month);
        // Criteria placeholders start after ?1=month_key, ?2=limit, ?3=offset.
        let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 4);
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause();
        let query = format!(
            "
                SELECT
                    id,
                    original_file_name,
                    original_path,
                    file_created_at,
                    checksum,
                    asset_type,
                    duration,
                    is_favorite,
                    is_archived,
                    visibility,
                    rating,
                    width,
                    height,
                    thumbhash
                FROM assets
                WHERE file_created_at IS NOT NULL AND substr(file_created_at, 1, 7) = ?1{}
                ORDER BY {}
                LIMIT ?2 OFFSET ?3
                ",
            criteria_sql, order_by
        );
        let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

        let mut bind: DynParams =
            vec![Box::new(month_key), Box::new(limit), Box::new(offset)];
        bind.extend(criteria_params);

        let rows = stmt
            .query_map(params_from_iter(bind.iter()), map_asset_summary)
            .map_err(|err| err.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|err| err.to_string())?);
        }

        let has_next_page = items.len() > page_size as usize;
        if has_next_page {
            items.truncate(page_size as usize);
        }

        Ok((items, has_next_page))
    }

    pub fn get_all_calendar_assets(
        &self,
        year: i32,
        month: u32,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<Vec<AssetSummary>, String> {
        let conn = self.open()?;
        let month_key = format!("{:04}-{:02}", year, month);
        // Criteria placeholders start after ?1=month_key.
        let (criteria_sql, criteria_params) = criteria_filter(&conn, criteria, "id", 2);
        let default_sort = SortParams::default();
        let sort = sort.unwrap_or(&default_sort);
        let order_by = sort.order_by_clause();
        let query = format!(
            "
                SELECT
                    id,
                    original_file_name,
                    original_path,\n                    file_created_at,
                    checksum,
                    asset_type,
                    duration,
                    is_favorite,
                    is_archived,
                    visibility,
                    rating,
                    width,
                    height,
                    thumbhash
                FROM assets
                WHERE file_created_at IS NOT NULL AND substr(file_created_at, 1, 7) = ?1{}
                ORDER BY {}
                ",
            criteria_sql, order_by
        );
        let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;

        let mut bind: DynParams = vec![Box::new(month_key)];
        bind.extend(criteria_params);

        let rows = stmt
            .query_map(params_from_iter(bind.iter()), map_asset_summary)
            .map_err(|err| err.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|err| err.to_string())?);
        }

        Ok(items)
    }

    /// Distinct, non-empty camera (EXIF model) names among the assets in the
    /// given view scope, sorted case-insensitively. Powers the Camera filter
    /// dropdown.
    pub fn get_cameras_in_scope(&self, scope: &ViewScope) -> Result<Vec<String>, String> {
        let conn = self.open()?;
        let (scope_sql, scope_params) = scope_asset_ids_query(scope);
        let query = format!(
            "
                SELECT DISTINCT a.camera
                FROM assets a
                WHERE a.id IN ({})
                  AND a.camera IS NOT NULL
                  AND TRIM(a.camera) != ''
                ORDER BY a.camera COLLATE NOCASE ASC
                ",
            scope_sql
        );
        let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(scope_params.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|err| err.to_string())?;

        let mut cameras = Vec::new();
        for row in rows {
            cameras.push(row.map_err(|err| err.to_string())?);
        }

        Ok(cameras)
    }

    /// Named, visible people that appear in at least one asset within the given
    /// view scope, sorted case-insensitively by name. Powers the People filter
    /// dropdown.
    pub fn get_people_in_scope(
        &self,
        scope: &ViewScope,
    ) -> Result<Vec<crate::services::immich_client::PersonSummary>, String> {
        let conn = self.open()?;
        let (scope_sql, scope_params) = scope_asset_ids_query(scope);
        let query = format!(
            "
                SELECT p.id, p.name, p.is_hidden, p.thumbnail_path
                FROM people p
                WHERE COALESCE(p.is_hidden, 0) = 0
                  AND p.name IS NOT NULL
                  AND TRIM(p.name) != ''
                  AND p.id IN (
                    SELECT ap.person_id
                    FROM asset_people ap
                    WHERE ap.asset_id IN ({})
                  )
                ORDER BY p.name COLLATE NOCASE ASC
                ",
            scope_sql
        );
        let mut stmt = conn.prepare(&query).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(scope_params.iter()), |row| {
                Ok(crate::services::immich_client::PersonSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    is_hidden: row.get::<_, Option<i32>>(2)?.unwrap_or(0) != 0,
                    thumbnail_path: row.get(3)?,
                })
            })
            .map_err(|err| err.to_string())?;

        let mut people = Vec::new();
        for row in rows {
            people.push(row.map_err(|err| err.to_string())?);
        }

        Ok(people)
    }

    pub fn get_timeline_months(
        &self,
    ) -> Result<(Option<String>, Option<String>, Vec<String>), String> {
        let conn = self.open()?;

        let mut stmt = conn
            .prepare(
                "
                SELECT DISTINCT substr(file_created_at, 1, 7) AS month_key
                FROM assets
                WHERE file_created_at IS NOT NULL
                  AND length(file_created_at) >= 7
                ORDER BY month_key DESC
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;

        let mut months = Vec::new();
        for row in rows {
            months.push(row.map_err(|err| err.to_string())?);
        }

        let newest_month = months.first().cloned();
        let oldest_month = months.last().cloned();

        Ok((newest_month, oldest_month, months))
    }

    pub fn get_settings(&self) -> Result<Settings, String> {
        let conn = self.open()?;

        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = ?1")
            .map_err(|err| err.to_string())?;

        let home = dirs_home()
            .filter(|path| path.exists())
            .ok_or_else(|| "Could not determine home directory".to_string())?;

        let thumbnail_cache_path = home.join(".config/immich-local-app/thumbnails");
        let video_cache_path = home.join(".config/immich-local-app/videos");

        let live_photo_autoplay = stmt
            .query_row(params!["live_photo_autoplay"], |row| {
                row.get::<_, String>(0)
            })
            .map(|v| v == "true")
            .unwrap_or(true);

        let locale = stmt
            .query_row(params!["locale"], |row| row.get::<_, String>(0))
            .map(|v| normalize_locale(&v))
            .unwrap_or_else(|_| {
                let detected = detect_system_locale();
                log::info!("[i18n.locale] locale setting missing, defaulting to {detected}");
                detected
            });

        let user_local_folder_path = stmt
            .query_row(params!["user_local_folder_path"], |row| {
                row.get::<_, String>(0)
            })
            .unwrap_or_default();

        let menu_items = stmt
            .query_row(params!["menu_items"], |row| row.get::<_, String>(0))
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_else(default_menu_items);

        let my_photos_rules = stmt
            .query_row(params!["my_photos_rules"], |row| row.get::<_, String>(0))
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<MyPhotosRule>>(&raw).ok())
            .unwrap_or_default();

        Ok(Settings {
            locale,
            live_photo_autoplay,
            thumbnail_cache_path: thumbnail_cache_path.to_string_lossy().to_string(),
            video_cache_path: video_cache_path.to_string_lossy().to_string(),
            user_local_folder_path,
            menu_items,
            my_photos_rules,
        })
    }

    pub fn update_settings(&self, settings: &Settings) -> Result<Settings, String> {
        let conn = self.open()?;
        let locale = normalize_locale(&settings.locale);
        log::info!("[i18n.locale] persisting locale={locale}");

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('locale', ?1)",
            params![locale],
        )
        .map_err(|err| err.to_string())?;

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('live_photo_autoplay', ?1)",
            params![settings.live_photo_autoplay.to_string()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('user_local_folder_path', ?1)",
            params![settings.user_local_folder_path],
        )
        .map_err(|err| err.to_string())?;
        let menu_items_json =
            serde_json::to_string(&settings.menu_items).map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('menu_items', ?1)",
            params![menu_items_json],
        )
        .map_err(|err| err.to_string())?;
        let my_photos_rules_json =
            serde_json::to_string(&settings.my_photos_rules).map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('my_photos_rules', ?1)",
            params![my_photos_rules_json],
        )
        .map_err(|err| err.to_string())?;

        self.get_settings()
    }

    pub fn init_sync_state(&self, total_assets: i32) -> Result<SyncState, String> {
        let conn = self.open()?;
        let now = chrono::Local::now().to_rfc3339();
        let sync_id = "default";

        conn.execute(
            "
            INSERT OR REPLACE INTO sync_state (
                id, total_assets, processed_assets, is_syncing, created_at, updated_at
            )
            VALUES (?1, ?2, 0, 1, ?3, ?3)
            ",
            params![sync_id, total_assets, now],
        )
        .map_err(|err| err.to_string())?;

        self.get_sync_state()
    }

    pub fn resume_sync_state(&self, total_assets: i32) -> Result<SyncState, String> {
        let conn = self.open()?;
        let now = chrono::Local::now().to_rfc3339();

        conn.execute(
            "
            UPDATE sync_state
            SET total_assets = ?1, is_syncing = 1, updated_at = ?2
            WHERE id = 'default'
            ",
            params![total_assets, now],
        )
        .map_err(|err| err.to_string())?;

        self.get_sync_state()
    }

    pub fn get_sync_state(&self) -> Result<SyncState, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
                "
                SELECT id, total_assets, processed_assets, is_syncing, 
                       last_sync_completed_at, last_checked_at, check_status, created_at, updated_at
                FROM sync_state WHERE id = 'default'
                ",
            )
            .map_err(|err| err.to_string())?;

        let sync_state = stmt
            .query_row([], |row| {
                Ok(SyncState {
                    id: row.get(0)?,
                    total_assets: row.get(1)?,
                    processed_assets: row.get(2)?,
                    is_syncing: row.get::<_, i32>(3)? != 0,
                    last_sync_completed_at: row.get(4)?,
                    last_checked_at: row.get(5)?,
                    check_status: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .or_else(|_: rusqlite::Error| {
                // Return a default sync state if none exists
                let now = chrono::Local::now().to_rfc3339();
                Ok::<SyncState, rusqlite::Error>(SyncState {
                    id: "default".to_string(),
                    total_assets: 0,
                    processed_assets: 0,
                    is_syncing: false,
                    last_sync_completed_at: None,
                    last_checked_at: None,
                    check_status: "idle".to_string(),
                    created_at: now.clone(),
                    updated_at: now,
                })
            })
            .map_err(|err| err.to_string())?;

        Ok(sync_state)
    }

    pub fn update_sync_progress(&self, processed_assets: i32) -> Result<SyncState, String> {
        let conn = self.open()?;
        let now = chrono::Local::now().to_rfc3339();

        conn.execute(
            "
            UPDATE sync_state 
            SET processed_assets = ?1, updated_at = ?2
            WHERE id = 'default'
            ",
            params![processed_assets, now],
        )
        .map_err(|err| err.to_string())?;

        self.get_sync_state()
    }

    pub fn complete_sync(&self) -> Result<SyncState, String> {
        let conn = self.open()?;
        let now = chrono::Local::now().to_rfc3339();

        conn.execute(
            "
            UPDATE sync_state 
            SET is_syncing = 0, last_sync_completed_at = ?1, updated_at = ?1
            WHERE id = 'default'
            ",
            params![now],
        )
        .map_err(|err| err.to_string())?;

        self.get_sync_state()
    }

    pub fn start_check(&self) -> Result<SyncState, String> {
        let conn = self.open()?;
        let now = chrono::Local::now().to_rfc3339();

        conn.execute(
            "
            UPDATE sync_state 
            SET check_status = 'checking', updated_at = ?1
            WHERE id = 'default'
            ",
            params![now],
        )
        .map_err(|err| err.to_string())?;

        self.get_sync_state()
    }

    pub fn complete_check(&self, new_total: i32) -> Result<SyncState, String> {
        let conn = self.open()?;
        let now = chrono::Local::now().to_rfc3339();

        conn.execute(
            "
            UPDATE sync_state 
            SET check_status = 'idle', last_checked_at = ?1, total_assets = ?2, updated_at = ?1
            WHERE id = 'default'
            ",
            params![now, new_total],
        )
        .map_err(|err| err.to_string())?;

        self.get_sync_state()
    }

    pub fn fail_check(&self) -> Result<SyncState, String> {
        let conn = self.open()?;
        let now = chrono::Local::now().to_rfc3339();

        conn.execute(
            "
            UPDATE sync_state 
            SET check_status = 'error', updated_at = ?1
            WHERE id = 'default'
            ",
            params![now],
        )
        .map_err(|err| err.to_string())?;

        self.get_sync_state()
    }
}

fn dirs_home() -> Option<PathBuf> {
    crate::util::home_dir()
}

fn map_asset_summary(row: &rusqlite::Row<'_>) -> Result<AssetSummary, rusqlite::Error> {
    Ok(AssetSummary {
        id: row.get(0)?,
        original_file_name: row.get(1)?,
        original_path: row.get(2)?,
        file_created_at: row.get(3)?,
        checksum: row.get(4)?,
        r#type: row.get(5)?,
        duration: row.get(6)?,
        live_photo_video_id: None,
        is_favorite: row.get::<_, Option<i32>>(7)?.unwrap_or(0) != 0,
        is_archived: row.get::<_, Option<i32>>(8)?.unwrap_or(0) != 0,
        visibility: row.get(9)?,
        rating: row.get(10)?,
        width: row.get(11)?,
        height: row.get(12)?,
        thumbhash: row.get(13)?,
    })
}

fn map_asset_summary_extended(
    row: &rusqlite::Row<'_>,
) -> Result<AssetSummaryExtended, rusqlite::Error> {
    Ok(AssetSummaryExtended {
        id: row.get(0)?,
        original_file_name: row.get(1)?,
        description: row.get(2)?,
        original_path: row.get(3)?,
        file_created_at: row.get(4)?,
        checksum: row.get(5)?,
        r#type: row.get(6)?,
        duration: row.get(7)?,
        is_favorite: row.get::<_, Option<i32>>(8)?.unwrap_or(0) != 0,
        is_archived: row.get::<_, Option<i32>>(9)?.unwrap_or(0) != 0,
        visibility: row.get(10)?,
        rating: row.get(11)?,
        width: row.get(12)?,
        height: row.get(13)?,
        thumbhash: row.get(14)?,
        camera: row.get(15)?,
        lens: row.get(16)?,
        file_size_bytes: row.get(17)?,
        file_extension: row.get(18)?,
        people: row.get(19)?,
        tags: row.get(20)?,
        exif_info_json: row.get(21)?,
        is_my_photo: false,
    })
}

fn search_pattern(search: Option<&str>) -> Option<String> {
    let term = search?.trim();
    if term.is_empty() {
        return None;
    }

    Some(format!("%{}%", term))
}

fn asset_filter_where_clause(filter: Option<&str>) -> &'static str {
    match filter
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("all")
        .to_ascii_lowercase()
        .as_str()
    {
        "favorites" => {
            "is_favorite = 1 AND COALESCE(is_archived, 0) = 0 AND LOWER(COALESCE(visibility, '')) != 'archive'"
        }
        "archived" => {
            "COALESCE(is_archived, 0) = 1 OR LOWER(COALESCE(visibility, '')) = 'archive'"
        }
        _ => "1=1",
    }
}
