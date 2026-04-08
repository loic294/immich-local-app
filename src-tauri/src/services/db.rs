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
    pub file_created_at: Option<String>,
    pub checksum: Option<String>,
    pub r#type: Option<String>,
    pub duration: Option<String>,
    pub is_favorite: bool,
    pub is_archived: bool,
    pub visibility: Option<String>,
    pub rating: Option<i32>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub file_size_bytes: Option<i64>,
    pub file_extension: Option<String>,
    pub people: Option<String>,
    pub tags: Option<String>,
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
                file_created_at TEXT,
                checksum TEXT,
                updated_at INTEGER NOT NULL,
                asset_type TEXT,
                duration TEXT,
                is_favorite BOOLEAN DEFAULT 0,
                is_archived BOOLEAN DEFAULT 0,
                visibility TEXT,
                rating INTEGER,
                camera TEXT,
                lens TEXT,
                file_size_bytes INTEGER,
                file_extension TEXT,
                people TEXT,
                tags TEXT
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
            ("camera", "TEXT"),
            ("lens", "TEXT"),
            ("file_size_bytes", "INTEGER"),
            ("file_extension", "TEXT"),
            ("people", "TEXT"),
            ("tags", "TEXT"),
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
                    id, original_file_name, file_created_at, checksum, updated_at,
                    asset_type, duration, is_favorite, is_archived, visibility, rating
                )
                VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'), ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(id) DO UPDATE SET
                    original_file_name = excluded.original_file_name,
                    file_created_at = excluded.file_created_at,
                    checksum = excluded.checksum,
                    updated_at = excluded.updated_at,
                    asset_type = excluded.asset_type,
                    duration = excluded.duration,
                    is_favorite = excluded.is_favorite,
                    is_archived = excluded.is_archived,
                    visibility = excluded.visibility,
                    rating = excluded.rating
                ",
                params![
                    asset.id,
                    asset.original_file_name,
                    asset.file_created_at,
                    asset.checksum,
                    asset.r#type,
                    asset.duration,
                    asset.is_favorite as i32,
                    asset.is_archived as i32,
                    asset.visibility,
                    asset.rating
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
                    id, original_file_name, file_created_at, checksum, updated_at,
                    asset_type, duration, is_favorite, is_archived, visibility, rating,
                    camera, lens, file_size_bytes, file_extension, people, tags
                )
                VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(id) DO UPDATE SET
                    original_file_name = excluded.original_file_name,
                    file_created_at = excluded.file_created_at,
                    checksum = excluded.checksum,
                    updated_at = excluded.updated_at,
                    asset_type = excluded.asset_type,
                    duration = excluded.duration,
                    is_favorite = excluded.is_favorite,
                    is_archived = excluded.is_archived,
                    visibility = excluded.visibility,
                    rating = excluded.rating,
                    camera = excluded.camera,
                    lens = excluded.lens,
                    file_size_bytes = excluded.file_size_bytes,
                    file_extension = excluded.file_extension,
                    people = excluded.people,
                    tags = excluded.tags
                ",
                params![
                    asset.id,
                    asset.original_file_name,
                    asset.file_created_at,
                    asset.checksum,
                    asset.r#type,
                    asset.duration,
                    asset.is_favorite as i32,
                    asset.is_archived as i32,
                    asset.visibility,
                    asset.rating,
                    asset.camera,
                    asset.lens,
                    asset.file_size_bytes,
                    asset.file_extension,
                    asset.people,
                    asset.tags
                ],
            )
            .map_err(|err| err.to_string())?;
        }

        tx.commit().map_err(|err| err.to_string())
    }

    pub fn get_assets(&self, page: u32, page_size: u32) -> Result<Vec<AssetSummary>, String> {
        let conn = self.open()?;
        let offset = i64::from(page) * i64::from(page_size);

        let mut stmt = conn
            .prepare(
                "
                SELECT id, original_file_name, file_created_at, checksum
                FROM assets
                ORDER BY file_created_at DESC NULLS LAST, updated_at DESC
                LIMIT ?1 OFFSET ?2
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![i64::from(page_size), offset], |row| {
                Ok(AssetSummary {
                    id: row.get(0)?,
                    original_file_name: row.get(1)?,
                    file_created_at: row.get(2)?,
                    checksum: row.get(3)?,
                    r#type: None,
                    duration: None,
                    live_photo_video_id: None,
                    is_favorite: false,
                    is_archived: false,
                    visibility: Some("timeline".to_string()),
                    rating: None,
                })
            })
            .map_err(|err| err.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|err| err.to_string())?);
        }

        Ok(items)
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
