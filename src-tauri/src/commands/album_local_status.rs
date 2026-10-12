use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::services::db::Database;
use crate::services::storage::{is_original_source_kind, VideoQuality};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumLocalStatus {
    pub total_count: u32,
    pub local_count: u32,
    pub missing_count: u32,
}

impl Database {
    pub fn album_local_status(&self, album_id: &str) -> Result<AlbumLocalStatus, String> {
        let conn = self.open()?;
        let (folder, advertised_count): (Option<String>, Option<u32>) = conn.query_row(
            "SELECT saved_local_folder_path, asset_count FROM albums WHERE id = ?1",
            [album_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|err| err.to_string())?;
        let quality = self.get_feature_preferences()?.offline_video_quality;
        let mut stmt = conn.prepare(
            "SELECT aa.asset_id, a.asset_type, l.local_path, l.source_kind
             FROM album_assets aa
             JOIN albums b ON b.id = aa.album_id AND b.account_id = aa.account_id
             JOIN assets a ON a.id = aa.asset_id AND a.account_id = aa.account_id
             LEFT JOIN local_saved_assets l ON l.asset_id = aa.asset_id
             WHERE aa.album_id = ?1",
        ).map_err(|err| err.to_string())?;
        let rows = stmt.query_map([album_id], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?,
        ))).map_err(|err| err.to_string())?;
        let mut assets = HashSet::new();
        let mut local = HashSet::new();
        for row in rows {
            let (id, asset_type, path, kind) = row.map_err(|err| err.to_string())?;
            assets.insert(id.clone());
            if let (Some(folder), Some(path), Some(kind)) = (&folder, path, kind) {
                let path = Path::new(&path);
                let transcoded = asset_type.as_deref() == Some("VIDEO") && quality == VideoQuality::Server;
                let correct_quality = if transcoded {
                    kind.ends_with(":transcoded")
                } else {
                    is_original_source_kind(&kind)
                };
                if correct_quality && path.is_file() && path.parent() == Some(Path::new(folder)) {
                    local.insert(id);
                }
            }
        }
        let total_count = (assets.len() as u32).max(advertised_count.unwrap_or(0));
        let local_count = local.len() as u32;
        Ok(AlbumLocalStatus { total_count, local_count, missing_count: total_count - local_count })
    }
}

#[tauri::command]
pub async fn get_album_local_status(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<AlbumLocalStatus, String> {
    state.db.album_local_status(&album_id).map_err(|err| {
        log::error!("[album-local-status] failed album_id={album_id} error={err}");
        err
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_real_files_in_album_folder_not_paths_previews_or_other_folders() {
        let root = std::env::temp_dir().join(format!("immich-album-status-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = Database::test_database(root.join("test.sqlite")).unwrap();
        let folder = root.join("album");
        std::fs::create_dir_all(&folder).unwrap();
        let conn = db.open().unwrap();
        conn.execute("INSERT INTO albums(id,account_id,album_name,owner_id,asset_count,saved_local_folder_path) VALUES('album','account','Album','me',4,?1)",
            [folder.to_string_lossy().as_ref()]).unwrap();
        for (id, dir, kind, exists) in [
            ("original", &folder, "explorer_copy", true),
            ("deleted", &folder, "album_save", false),
            ("preview", &folder, "album_save:cached", true),
            ("elsewhere", &root, "album_save", true),
        ] {
            conn.execute("INSERT INTO assets(id,account_id,original_file_name,updated_at) VALUES(?1,'account',?1,0)", [id]).unwrap();
            conn.execute("INSERT INTO album_assets(album_id,asset_id,account_id) VALUES('album',?1,'account')", [id]).unwrap();
            let path = dir.join(id);
            if exists { std::fs::write(&path, b"photo").unwrap(); }
            db.upsert_local_saved_asset(id, None, path.to_str().unwrap(), id, kind, None, None).unwrap();
        }
        let status = db.album_local_status("album").unwrap();
        assert_eq!((status.total_count, status.local_count, status.missing_count), (4, 1, 3));
        std::fs::remove_file(folder.join("original")).unwrap();
        assert_eq!(db.album_local_status("album").unwrap().missing_count, 4);
        drop(conn);
        std::fs::remove_file(folder.join("preview")).unwrap();
        std::fs::remove_file(root.join("elsewhere")).unwrap();
        std::fs::remove_file(root.join("test.sqlite")).unwrap();
        std::fs::remove_dir(folder).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
