use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::services::immich_client::AssetSummary;
use crate::commands::settings::Settings;

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
pub struct AssetSummaryExtended {
    pub id: String,
    pub original_file_name: String,
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
            let _ = conn.execute(
                "ALTER TABLE sync_state ADD COLUMN last_checked_at TEXT",
                [],
            );
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
        let mut stmt = conn.prepare("PRAGMA table_info(assets)")
            .map_err(|err| err.to_string())?;
        let mut columns = Vec::new();
        stmt.query_map([], |row| {
            let col_name: String = row.get(1)?;
            columns.push(col_name);
            Ok(())
        }).map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        
        drop(stmt);
        
        // List of columns that might be missing
        let required_columns = vec![
            ("asset_type", "TEXT"),
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

    pub fn get_auth_credentials(&self) -> Result<Option<(String, String)>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = ?1")
            .map_err(|err| err.to_string())?;

        let server_url = stmt
            .query_row(params!["server_url"], |row| row.get::<_, String>(0))
            .ok();
        let api_key = stmt
            .query_row(params!["api_key"], |row| row.get::<_, String>(0))
            .ok();

        match (server_url, api_key) {
            (Some(url), Some(key)) if !url.is_empty() && !key.is_empty() => Ok(Some((url, key))),
            _ => Ok(None),
        }
    }

    pub fn clear_auth_credentials(&self) -> Result<(), String> {
        let conn = self.open()?;
        conn.execute("DELETE FROM settings WHERE key IN ('server_url', 'api_key')", [])
            .map_err(|err| err.to_string())?;
        Ok(())
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
                    id, original_file_name, original_path, file_created_at, checksum, updated_at,
                    asset_type, duration, is_favorite, is_archived, visibility, rating,
                    width, height, thumbhash, camera, lens, file_size_bytes, file_extension, people, tags, exif_info_json
                )
                VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s', 'now'), ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
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

    pub fn get_assets(
        &self,
        page: u32,
        page_size: u32,
        search: Option<&str>,
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);

        let limit = i64::from(page_size) + 1;
        let search_pattern = search_pattern(search);

        let mut items = if let Some(pattern) = search_pattern.as_deref() {
            let mut stmt = conn
                .prepare(
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
                        original_file_name LIKE ?3 COLLATE NOCASE
                        OR COALESCE(camera, '') LIKE ?3 COLLATE NOCASE
                        OR COALESCE(lens, '') LIKE ?3 COLLATE NOCASE
                        OR COALESCE(file_extension, '') LIKE ?3 COLLATE NOCASE
                        OR COALESCE(people, '') LIKE ?3 COLLATE NOCASE
                        OR COALESCE(tags, '') LIKE ?3 COLLATE NOCASE
                    ORDER BY file_created_at DESC NULLS LAST, updated_at DESC
                    LIMIT ?1 OFFSET ?2
                    ",
                )
                .map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map(params![limit, offset, pattern], map_asset_summary)
                .map_err(|err| err.to_string())?;

            let mut branch_items = Vec::new();
            for row in rows {
                branch_items.push(row.map_err(|err| err.to_string())?);
            }

            branch_items
        } else {
            let mut stmt = conn
                .prepare(
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
                    ORDER BY file_created_at DESC NULLS LAST, updated_at DESC
                    LIMIT ?1 OFFSET ?2
                    ",
                )
                .map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map(params![limit, offset], map_asset_summary)
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

    pub fn get_all_assets(&self, search: Option<&str>) -> Result<Vec<AssetSummary>, String> {
        let conn = self.open()?;
        let search_pattern = search_pattern(search);

        let items = if let Some(pattern) = search_pattern.as_deref() {
            let mut stmt = conn
                .prepare(
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
                        original_file_name LIKE ?1 COLLATE NOCASE
                        OR COALESCE(camera, '') LIKE ?1 COLLATE NOCASE
                        OR COALESCE(lens, '') LIKE ?1 COLLATE NOCASE
                        OR COALESCE(file_extension, '') LIKE ?1 COLLATE NOCASE
                        OR COALESCE(people, '') LIKE ?1 COLLATE NOCASE
                        OR COALESCE(tags, '') LIKE ?1 COLLATE NOCASE
                    ORDER BY file_created_at DESC NULLS LAST, updated_at DESC
                    ",
                )
                .map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map(params![pattern], map_asset_summary)
                .map_err(|err| err.to_string())?;

            let mut branch_items = Vec::new();
            for row in rows {
                branch_items.push(row.map_err(|err| err.to_string())?);
            }

            branch_items
        } else {
            let mut stmt = conn
                .prepare(
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
                    ORDER BY file_created_at DESC NULLS LAST, updated_at DESC
                    ",
                )
                .map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map([], map_asset_summary)
                .map_err(|err| err.to_string())?;

            let mut branch_items = Vec::new();
            for row in rows {
                branch_items.push(row.map_err(|err| err.to_string())?);
            }

            branch_items
        };

        Ok(items)
    }

    pub fn get_asset_days(&self, search: Option<&str>) -> Result<Vec<String>, String> {
        let conn = self.open()?;
        let search_pattern = search_pattern(search);

        let days = if let Some(pattern) = search_pattern.as_deref() {
            let mut stmt = conn
                .prepare(
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
                    ORDER BY day_key DESC
                    ",
                )
                .map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map(params![pattern], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;

            let mut branch_days = Vec::new();
            for row in rows {
                branch_days.push(row.map_err(|err| err.to_string())?);
            }

            branch_days
        } else {
            let mut stmt = conn
                .prepare(
                    "
                    SELECT DISTINCT substr(file_created_at, 1, 10) AS day_key
                    FROM assets
                    WHERE file_created_at IS NOT NULL
                      AND length(file_created_at) >= 10
                    ORDER BY day_key DESC
                    ",
                )
                .map_err(|err| err.to_string())?;

            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;

            let mut branch_days = Vec::new();
            for row in rows {
                branch_days.push(row.map_err(|err| err.to_string())?);
            }

            branch_days
        };

        Ok(days)
    }

    pub fn get_asset_details(&self, asset_id: &str) -> Result<Option<AssetSummaryExtended>, String> {
        let conn = self.open()?;
        let mut stmt = conn
            .prepare(
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
            Some(result) => result.map(Some).map_err(|err| err.to_string()),
            None => Ok(None),
        }
    }

    pub fn get_asset_jump_target_page(
        &self,
        date_key: &str,
        page_size: u32,
        search: Option<&str>,
    ) -> Result<Option<u32>, String> {
        let conn = self.open()?;
        let search_pattern = search_pattern(search);

        let exists = if let Some(pattern) = search_pattern.as_deref() {
            conn.query_row(
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
                )
                ",
                params![date_key, pattern],
                |row| row.get::<_, i32>(0),
            )
        } else {
            conn.query_row(
                "
                SELECT EXISTS(
                    SELECT 1
                    FROM assets
                    WHERE file_created_at IS NOT NULL
                      AND substr(file_created_at, 1, 10) = ?1
                )
                ",
                params![date_key],
                |row| row.get::<_, i32>(0),
            )
        }
        .map_err(|err| err.to_string())?;

        if exists == 0 {
            return Ok(None);
        }

        let newer_count = if let Some(pattern) = search_pattern.as_deref() {
            conn.query_row(
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
                ",
                params![date_key, pattern],
                |row| row.get::<_, i64>(0),
            )
        } else {
            conn.query_row(
                "
                SELECT COUNT(*)
                FROM assets
                WHERE file_created_at IS NOT NULL
                  AND substr(file_created_at, 1, 10) > ?1
                ",
                params![date_key],
                |row| row.get::<_, i64>(0),
            )
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

        tx.execute("DELETE FROM album_assets WHERE album_id = ?1", params![album_id])
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
            tx.execute("DELETE FROM asset_people WHERE asset_id = ?1", params![asset_id])
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
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);
        let limit = i64::from(page_size) + 1;
        let mut stmt = conn
            .prepare(
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
                WHERE aa.album_id = ?1
                ORDER BY a.file_created_at DESC NULLS LAST, a.updated_at DESC
                LIMIT ?2 OFFSET ?3
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![album_id, limit, offset], map_asset_summary)
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

        let mut paths = Vec::new();
        for row in rows {
            paths.push(row.map_err(|err| err.to_string())?);
        }

        Ok(paths)
    }

    pub fn get_folder_assets(
        &self,
        path: &str,
        page: u32,
        page_size: u32,
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);
        let limit = i64::from(page_size) + 1;
        let mut stmt = conn
            .prepare(
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
                WHERE original_path = ?1
                ORDER BY file_created_at DESC NULLS LAST, updated_at DESC
                LIMIT ?2 OFFSET ?3
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![path, limit, offset], map_asset_summary)
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

    pub fn get_calendar_assets(
        &self,
        year: i32,
        month: u32,
        page: u32,
        page_size: u32,
    ) -> Result<(Vec<AssetSummary>, bool), String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);
        let limit = i64::from(page_size) + 1;
        let month_key = format!("{:04}-{:02}", year, month);
        let mut stmt = conn
            .prepare(
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
                WHERE file_created_at IS NOT NULL AND substr(file_created_at, 1, 7) = ?1
                ORDER BY file_created_at DESC NULLS LAST, updated_at DESC
                LIMIT ?2 OFFSET ?3
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![month_key, limit, offset], map_asset_summary)
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

    pub fn get_timeline_months(&self) -> Result<(Option<String>, Option<String>, Vec<String>), String> {
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
        
        let home = std::env::var("HOME")
            .ok()
            .and_then(|h| {
                let path = Path::new(&h).to_path_buf();
                if path.exists() { Some(path) } else { None }
            })
            .ok_or_else(|| "Could not determine home directory".to_string())?;
        
        let thumbnail_cache_path = home.join(".config/immich-local-app/thumbnails");
        let video_cache_path = home.join(".config/immich-local-app/videos");
        
        let live_photo_autoplay = stmt
            .query_row(params!["live_photo_autoplay"], |row| row.get::<_, String>(0))
            .map(|v| v == "true")
            .unwrap_or(true);
        
        Ok(Settings {
            live_photo_autoplay,
            thumbnail_cache_path: thumbnail_cache_path.to_string_lossy().to_string(),
            video_cache_path: video_cache_path.to_string_lossy().to_string(),
        })
    }

    pub fn update_settings(&self, settings: &Settings) -> Result<Settings, String> {
        let conn = self.open()?;
        
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('live_photo_autoplay', ?1)",
            params![settings.live_photo_autoplay.to_string()],
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

    pub fn update_sync_progress(
        &self,
        processed_assets: i32,
    ) -> Result<SyncState, String> {
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
    if let Ok(home) = std::env::var("HOME") {
        return Some(Path::new(&home).to_path_buf());
    }
    None
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
        original_path: row.get(2)?,
        file_created_at: row.get(3)?,
        checksum: row.get(4)?,
        r#type: row.get(5)?,
        duration: row.get(6)?,
        is_favorite: row.get::<_, Option<i32>>(7)?.unwrap_or(0) != 0,
        is_archived: row.get::<_, Option<i32>>(8)?.unwrap_or(0) != 0,
        visibility: row.get(9)?,
        rating: row.get(10)?,
        width: row.get(11)?,
        height: row.get(12)?,
        thumbhash: row.get(13)?,
        camera: row.get(14)?,
        lens: row.get(15)?,
        file_size_bytes: row.get(16)?,
        file_extension: row.get(17)?,
        people: row.get(18)?,
        tags: row.get(19)?,
        exif_info_json: row.get(20)?,
    })
}

fn search_pattern(search: Option<&str>) -> Option<String> {
    let term = search?.trim();
    if term.is_empty() {
        return None;
    }

    Some(format!("%{}%", term))
}
