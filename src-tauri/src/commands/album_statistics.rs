use std::collections::BTreeMap;
use std::time::Instant;

use serde::Serialize;

use crate::services::db::{timeline_visibility_filter, Database};
use crate::AppState;

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAlbumStatistics {
    pub account_id: String,
    pub album_count: u64,
    pub shared_album_count: u64,
    /// Albums the server reports as non-empty whose memberships are not cached
    /// yet, which makes the in/not-in album counts incomplete.
    pub unsynced_album_count: u64,
    pub assets_in_albums: u64,
    pub assets_not_in_albums: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumStatistics {
    pub album_count: u64,
    pub shared_album_count: u64,
    pub unsynced_album_count: u64,
    pub assets_in_albums: u64,
    pub assets_not_in_albums: u64,
    pub accounts: Vec<AccountAlbumStatistics>,
}

fn to_count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

impl Database {
    /// Album coverage of the cached library. Assets follow the All Photos
    /// visibility rules and are counted once even when in several albums, so
    /// the totals match the "In an album" / "Not in an album" filters.
    pub fn album_statistics(&self) -> Result<AlbumStatistics, String> {
        let conn = self.open()?;
        let mut accounts: BTreeMap<String, AccountAlbumStatistics> = BTreeMap::new();

        let mut album_stmt = conn
            .prepare(
                "SELECT account_id,
                        COUNT(*),
                        COALESCE(SUM(CASE WHEN COALESCE(shared, 0) <> 0 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN COALESCE(asset_count, 0) > 0
                            AND NOT EXISTS (SELECT 1 FROM album_assets aa WHERE aa.album_id = albums.id)
                            THEN 1 ELSE 0 END), 0)
                 FROM albums
                 GROUP BY account_id",
            )
            .map_err(|err| err.to_string())?;
        let album_rows = album_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        for row in album_rows {
            let (account_id, albums, shared, unsynced) = row.map_err(|err| err.to_string())?;
            let entry = accounts.entry(account_id.clone()).or_default();
            entry.account_id = account_id;
            entry.album_count = to_count(albums);
            entry.shared_album_count = to_count(shared);
            entry.unsynced_album_count = to_count(unsynced);
        }

        let asset_sql = format!(
            "SELECT account_id,
                    COALESCE(SUM(CASE WHEN id IN (SELECT asset_id FROM album_assets) THEN 1 ELSE 0 END), 0),
                    COUNT(*)
             FROM assets
             WHERE {}
             GROUP BY account_id",
            timeline_visibility_filter()
        );
        let mut asset_stmt = conn.prepare(&asset_sql).map_err(|err| err.to_string())?;
        let asset_rows = asset_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        for row in asset_rows {
            let (account_id, in_albums, total) = row.map_err(|err| err.to_string())?;
            let entry = accounts.entry(account_id.clone()).or_default();
            entry.account_id = account_id;
            entry.assets_in_albums = to_count(in_albums);
            entry.assets_not_in_albums = to_count(total).saturating_sub(entry.assets_in_albums);
        }

        let accounts: Vec<AccountAlbumStatistics> = accounts.into_values().collect();
        let mut totals = AlbumStatistics::default();
        for account in &accounts {
            totals.album_count += account.album_count;
            totals.shared_album_count += account.shared_album_count;
            totals.unsynced_album_count += account.unsynced_album_count;
            totals.assets_in_albums += account.assets_in_albums;
            totals.assets_not_in_albums += account.assets_not_in_albums;
        }
        totals.accounts = accounts;
        Ok(totals)
    }
}

#[tauri::command]
pub async fn get_album_statistics(
    state: tauri::State<'_, AppState>,
) -> Result<AlbumStatistics, String> {
    let started = Instant::now();
    log::info!("[album-stats] computing from local cache");
    match state.db.album_statistics() {
        Ok(stats) => {
            log::info!(
                "[album-stats] done albums={} shared={} unsynced_albums={} in_albums={} not_in_albums={} accounts={} elapsed_ms={}",
                stats.album_count,
                stats.shared_album_count,
                stats.unsynced_album_count,
                stats.assets_in_albums,
                stats.assets_not_in_albums,
                stats.accounts.len(),
                started.elapsed().as_millis()
            );
            Ok(stats)
        }
        Err(err) => {
            log::error!("[album-stats] failed error={err}");
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db(name: &str) -> (Database, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "immich-album-stats-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = Database::test_database(root.join("test.sqlite")).unwrap();
        (db, root)
    }

    #[test]
    fn empty_cache_reports_zero_counts() {
        let (db, root) = test_db("empty");
        assert_eq!(db.album_statistics().unwrap(), AlbumStatistics::default());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn counts_visible_assets_once_and_breaks_down_per_account() {
        let (db, root) = test_db("breakdown");
        let conn = db.open().unwrap();
        conn.execute_batch(
            "INSERT INTO albums(id,account_id,album_name,owner_id,shared,asset_count) VALUES
                ('trip','a','Trip','ua',1,2),
                ('family','a','Family','ua',0,1),
                ('pending','a','Pending','ua',0,5),
                ('empty','a','Empty','ua',0,0),
                ('work','b','Work','ub',0,1);
             INSERT INTO assets(id,account_id,original_file_name,updated_at,asset_type) VALUES
                ('a-in-two','a','1.jpg',0,'IMAGE'),
                ('a-in-one','a','2.jpg',0,'IMAGE'),
                ('a-loose','a','3.jpg',0,'IMAGE'),
                ('a-trashed','a','4.jpg',0,'IMAGE'),
                ('a-stacked','a','5.jpg',0,'IMAGE'),
                ('b-in','b','6.jpg',0,'IMAGE'),
                ('b-loose','b','7.jpg',0,'IMAGE'),
                ('b-loose-2','b','8.jpg',0,'IMAGE');
             UPDATE assets SET is_stack_secondary=1 WHERE id='a-stacked';
             INSERT INTO trashed_assets(asset_id,account_id) VALUES('a-trashed','a');
             INSERT INTO album_assets(album_id,asset_id,account_id) VALUES
                ('trip','a-in-two','a'),('family','a-in-two','a'),('trip','a-in-one','a'),
                ('trip','a-trashed','a'),('work','b-in','b');",
        )
        .unwrap();
        drop(conn);

        let stats = db.album_statistics().unwrap();
        assert_eq!(
            (
                stats.album_count,
                stats.shared_album_count,
                stats.unsynced_album_count
            ),
            (5, 1, 1)
        );
        assert_eq!((stats.assets_in_albums, stats.assets_not_in_albums), (3, 3));
        assert_eq!(
            stats.accounts,
            vec![
                AccountAlbumStatistics {
                    account_id: "a".into(),
                    album_count: 4,
                    shared_album_count: 1,
                    unsynced_album_count: 1,
                    assets_in_albums: 2,
                    assets_not_in_albums: 1,
                },
                AccountAlbumStatistics {
                    account_id: "b".into(),
                    album_count: 1,
                    shared_album_count: 0,
                    unsynced_album_count: 0,
                    assets_in_albums: 1,
                    assets_not_in_albums: 2,
                },
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hides_live_photo_motion_halves_like_the_timeline() {
        let (db, root) = test_db("live");
        let conn = db.open().unwrap();
        conn.execute_batch(
            "INSERT INTO assets(id,account_id,original_file_name,updated_at,asset_type,live_photo_video_id) VALUES
                ('still','a','live.heic',0,'IMAGE','motion'),
                ('motion','a','live.mov',0,'VIDEO',NULL),
                ('clip','a','clip.mov',0,'VIDEO',NULL);",
        )
        .unwrap();
        drop(conn);

        let stats = db.album_statistics().unwrap();
        assert_eq!((stats.assets_in_albums, stats.assets_not_in_albums), (0, 2));
        assert_eq!(stats.accounts.len(), 1);
        assert_eq!(stats.accounts[0].album_count, 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
