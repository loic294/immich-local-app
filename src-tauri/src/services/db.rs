use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use crate::services::immich_client::AssetSummary;
use crate::commands::settings::Settings;

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
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )
        .map_err(|err| err.to_string())?;
        
        // Initialize default settings if not exist
        let conn = self.open()?;
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('live_photo_autoplay', 'true')",
            [],
        )
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
                INSERT INTO assets (id, original_file_name, file_created_at, checksum, updated_at)
                VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
                ON CONFLICT(id) DO UPDATE SET
                    original_file_name = excluded.original_file_name,
                    file_created_at = excluded.file_created_at,
                    checksum = excluded.checksum,
                    updated_at = excluded.updated_at
                ",
                params![
                    asset.id,
                    asset.original_file_name,
                    asset.file_created_at,
                    asset.checksum
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
}

fn dirs_home() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        return Some(Path::new(&home).to_path_buf());
    }
    None
}
