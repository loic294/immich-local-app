use crate::commands::settings::DeleteBehavior;
use crate::services::db::Database;
use rusqlite::params;

impl Database {
    pub fn protected_original(&self, id: &str) -> Result<bool, String> {
        self.init_media()?;
        self.open()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM edit_versions WHERE original_asset_id=?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod deletion_tests {
    use super::*;
    use crate::services::immich_client::AssetSummary;

    struct Fixture {
        db: Database,
        path: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let path = std::env::current_dir()
                .unwrap()
                .join(format!(".deletion-test-{}.sqlite", uuid::Uuid::new_v4()));
            let db = Database::test_database(path.clone()).unwrap();
            for (account, id) in [("one", "a"), ("two", "b")] {
                let asset: AssetSummary = serde_json::from_value(serde_json::json!({
                    "id":id,"originalFileName":"image.jpg","fileCreatedAt":"2026-10-01T00:00:00Z",
                    "checksum":null,"visibility":"timeline","width":640,"height":480
                }))
                .unwrap();
                db.upsert_assets(account, &[asset]).unwrap();
            }
            Self { db, path }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            for suffix in ["-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.path.display()));
            }
        }
    }

    #[test]
    fn deletion_default_and_preference_survive_reopen() {
        let test = Fixture::new();
        let mut settings = test.db.get_settings().unwrap();
        assert_eq!(settings.delete_behavior, DeleteBehavior::Archive);
        settings.delete_behavior = DeleteBehavior::Trash;
        test.db.update_settings(&settings).unwrap();
        let reopened = Database::test_database(test.path.clone()).unwrap();
        assert_eq!(
            reopened.get_settings().unwrap().delete_behavior,
            DeleteBehavior::Trash
        );
        reopened
            .open()
            .unwrap()
            .execute("DELETE FROM settings WHERE key='delete_behavior'", [])
            .unwrap();
        assert_eq!(
            reopened.get_settings().unwrap().delete_behavior,
            DeleteBehavior::Archive
        );
    }

    #[test]
    fn cached_trash_summaries_and_views_match_asset_account_for_restore_controls() {
        let test = Fixture::new();
        test.db
            .apply_deleted_state("one", "a", DeleteBehavior::Trash, false, None)
            .unwrap();
        let conn = test.db.open().unwrap();
        conn.execute(
            "INSERT INTO trashed_assets(asset_id,account_id) VALUES('b','one')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE assets SET original_path='/photos/image.jpg',is_favorite=1",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO album_assets(album_id,asset_id,account_id) VALUES('album','a','one'),('album','b','two')",
            [],
        ).unwrap();
        drop(conn);

        let summary = test.db.get_asset_summary("a").unwrap().unwrap();
        assert!(summary.is_trashed);
        assert!(!summary.is_archived);
        assert_eq!(summary.visibility.as_deref(), Some("timeline"));
        let control_state = serde_json::to_value(&summary).unwrap();
        assert_eq!(control_state["isTrashed"], true);
        assert_eq!(control_state["isArchived"], false);
        assert!(!test.db.get_asset_summary("b").unwrap().unwrap().is_trashed);

        let trashed = test
            .db
            .get_assets(0, 100, None, Some("trashed"), None, None)
            .unwrap()
            .0;
        let full_trashed = test
            .db
            .get_all_assets(None, Some("trashed"), None, None)
            .unwrap();
        for items in [trashed, full_trashed] {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].id, "a");
            assert_eq!(serde_json::to_value(&items[0]).unwrap()["isTrashed"], true);
        }
        for items in [
            test.db
                .get_assets(0, 100, None, Some("all"), None, None)
                .unwrap()
                .0,
            test.db
                .get_all_assets(None, Some("favorites"), None, None)
                .unwrap(),
            test.db
                .get_album_assets("album", 0, 100, None, None)
                .unwrap()
                .0,
            test.db.get_all_album_assets("album", None, None).unwrap(),
            test.db
                .get_folder_assets("/photos", 0, 100, None, None)
                .unwrap()
                .0,
            test.db
                .get_all_folder_assets("/photos", None, None)
                .unwrap(),
            test.db
                .get_calendar_assets(2026, 10, 0, 100, None, None)
                .unwrap()
                .0,
            test.db
                .get_all_calendar_assets(2026, 10, None, None)
                .unwrap(),
        ] {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].id, "b");
            assert!(!items[0].is_trashed);
        }

        test.db
            .apply_deleted_state("one", "a", DeleteBehavior::Trash, true, None)
            .unwrap();
        assert!(!test.db.get_asset_summary("a").unwrap().unwrap().is_trashed);
        assert!(test
            .db
            .get_all_assets(None, Some("trashed"), None, None)
            .unwrap()
            .is_empty());
        assert!(test
            .db
            .get_all_assets(None, None, None, None)
            .unwrap()
            .iter()
            .all(|asset| !asset.is_trashed));
    }

    #[test]
    fn cached_stack_count_and_versions_ignore_foreign_account_trash_markers() {
        let test = Fixture::new();
        test.db
            .record_edit_stack("a", "a", &["a".into(), "b".into()])
            .unwrap();
        test.db
            .open()
            .unwrap()
            .execute(
                "INSERT INTO trashed_assets(asset_id,account_id) VALUES('b','one')",
                [],
            )
            .unwrap();
        assert_eq!(
            test.db.get_asset_summary("a").unwrap().unwrap().stack_count,
            Some(2)
        );
        assert_eq!(test.db.edit_version_ids("a").unwrap(), ["b"]);
        assert!(!test.db.get_asset_summary("b").unwrap().unwrap().is_trashed);
        test.db
            .apply_deleted_state("two", "b", DeleteBehavior::Trash, false, None)
            .unwrap();
        assert_eq!(
            test.db.get_asset_summary("a").unwrap().unwrap().stack_count,
            Some(1)
        );
        assert!(test.db.edit_version_ids("a").unwrap().is_empty());
        assert!(test.db.get_asset_summary("b").unwrap().unwrap().is_trashed);
    }

    #[test]
    fn deletion_and_restore_are_distinct_atomic_account_scoped_and_ordered() {
        let test = Fixture::new();
        assert!(test
            .db
            .apply_deleted_state("two", "a", DeleteBehavior::Trash, false, None)
            .is_err());
        test.db
            .apply_deleted_state(
                "one",
                "a",
                DeleteBehavior::Archive,
                false,
                Some(("delete_asset", r#"{"mode":"archive"}"#)),
            )
            .unwrap();
        let a = test.db.get_asset_summary("a").unwrap().unwrap();
        assert!(a.is_archived && !a.is_trashed);
        test.db
            .apply_deleted_state(
                "one",
                "a",
                DeleteBehavior::Archive,
                true,
                Some(("restore_deleted", r#"{"mode":"archive"}"#)),
            )
            .unwrap();
        test.db
            .apply_deleted_state(
                "one",
                "a",
                DeleteBehavior::Trash,
                false,
                Some(("delete_asset", r#"{"mode":"trash"}"#)),
            )
            .unwrap();
        let a = test.db.get_asset_summary("a").unwrap().unwrap();
        assert!(a.is_trashed && !a.is_archived);
        assert_eq!(a.visibility.as_deref(), Some("timeline"));
        assert_eq!(
            test.db
                .get_assets(0, 100, None, Some("trashed"), None, None)
                .unwrap()
                .0[0]
                .id,
            "a"
        );
        assert_eq!(
            test.db
                .get_assets(0, 100, None, Some("all"), None, None)
                .unwrap()
                .0[0]
                .id,
            "b"
        );
        let pending = test.db.list_pending_mutations().unwrap();
        assert_eq!(
            pending.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(),
            ["delete_asset", "restore_deleted", "delete_asset"]
        );
        assert!(pending.windows(2).all(|p| p[0].id < p[1].id));
        test.db
            .apply_deleted_state("one", "a", DeleteBehavior::Trash, true, None)
            .unwrap();
        assert!(!test.db.get_asset_summary("a").unwrap().unwrap().is_trashed);
    }

    #[test]
    fn deletion_refresh_preserves_other_accounts_pending_decisions_and_prune_protections() {
        let test = Fixture::new();
        test.db
            .apply_deleted_state(
                "one",
                "a",
                DeleteBehavior::Trash,
                false,
                Some(("delete_asset", r#"{"mode":"trash"}"#)),
            )
            .unwrap();
        test.db
            .apply_deleted_state("two", "b", DeleteBehavior::Trash, false, None)
            .unwrap();
        test.db
            .reconcile_deleted("one", &[], DeleteBehavior::Trash)
            .unwrap();
        assert!(test.db.get_asset_summary("a").unwrap().unwrap().is_trashed);
        assert!(test.db.get_asset_summary("b").unwrap().unwrap().is_trashed);
        assert!(test
            .db
            .get_asset_ids_in_created_at_window("two", "2026-01-01", "2027-01-01")
            .unwrap()
            .is_empty());
        test.db
            .reconcile_deleted("two", &[], DeleteBehavior::Trash)
            .unwrap();
        assert!(!test.db.get_asset_summary("b").unwrap().unwrap().is_trashed);
        test.db
            .apply_deleted_state(
                "two",
                "b",
                DeleteBehavior::Archive,
                false,
                Some(("delete_asset", r#"{"mode":"archive"}"#)),
            )
            .unwrap();
        let mut stale = test.db.get_asset_summary("b").unwrap().unwrap();
        stale.is_archived = false;
        stale.visibility = Some("timeline".into());
        test.db.upsert_assets("two", &[stale]).unwrap();
        test.db
            .reconcile_deleted("two", &[], DeleteBehavior::Archive)
            .unwrap();
        assert!(test.db.get_asset_summary("b").unwrap().unwrap().is_archived);
        assert!(test
            .db
            .get_asset_ids_in_created_at_window("two", "2026-01-01", "2027-01-01")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn deletion_keeps_versions_in_deleted_and_original_protected() {
        let test = Fixture::new();
        test.db
            .record_edit_stack("a", "b", &["a".into(), "b".into()])
            .unwrap();
        assert!(test.db.protected_original("a").unwrap());
        assert!(!test.db.protected_original("b").unwrap());
        test.db
            .apply_deleted_state("two", "b", DeleteBehavior::Trash, false, None)
            .unwrap();
        assert_eq!(
            test.db
                .get_assets(0, 100, None, Some("trashed"), None, None)
                .unwrap()
                .0[0]
                .id,
            "b"
        );
        assert!(test.db.edit_version_ids("a").unwrap().is_empty());
        test.db
            .apply_deleted_state("two", "b", DeleteBehavior::Trash, true, None)
            .unwrap();
        assert_eq!(test.db.edit_version_ids("a").unwrap(), ["b"]);
        assert!(test.db.protected_original("a").unwrap());
    }

    #[test]
    fn deletion_remote_absence_eviction_never_drops_pending_or_other_account_assets() {
        let test = Fixture::new();
        test.db
            .apply_deleted_state(
                "one",
                "a",
                DeleteBehavior::Trash,
                false,
                Some(("delete_asset", r#"{"mode":"trash"}"#)),
            )
            .unwrap();
        test.db
            .apply_deleted_state("two", "b", DeleteBehavior::Trash, false, None)
            .unwrap();
        test.db
            .evict_absent_deleted("one", &["a".into(), "b".into()])
            .unwrap();
        assert!(test.db.get_asset_summary("a").unwrap().is_some());
        assert!(test.db.get_asset_summary("b").unwrap().is_some());
        assert_eq!(test.db.count_pending_mutations().unwrap(), 1);
        test.db.evict_absent_deleted("two", &["b".into()]).unwrap();
        assert!(test.db.get_asset_summary("b").unwrap().is_none());
        assert!(test
            .db
            .deleted_ids("two", DeleteBehavior::Trash)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn deletion_trash_of_active_edit_restores_original_and_keeps_restored_edit_secondary() {
        let test = Fixture::new();
        test.db
            .open()
            .unwrap()
            .execute("UPDATE assets SET account_id='one' WHERE id='b'", [])
            .unwrap();
        test.db
            .record_edit_stack("a", "b", &["a".into(), "b".into()])
            .unwrap();
        let mut settings = test.db.get_settings().unwrap();
        settings.delete_behavior = DeleteBehavior::Trash;
        test.db.update_settings(&settings).unwrap();
        test.db
            .remove_edit_version_from_cache("b", Some("one"))
            .unwrap();
        assert!(
            !test
                .db
                .get_asset_summary("a")
                .unwrap()
                .unwrap()
                .is_stack_secondary
        );
        let deleted = test.db.get_asset_summary("b").unwrap().unwrap();
        assert!(deleted.is_trashed && deleted.is_stack_secondary && !deleted.is_archived);
        let pending = test.db.list_pending_mutations().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&pending[0].payload_json).unwrap()["mode"],
            "trash"
        );
        test.db
            .apply_deleted_state("one", "b", DeleteBehavior::Trash, true, None)
            .unwrap();
        let assets = test
            .db
            .get_assets(0, 100, None, None, None, None)
            .unwrap()
            .0;
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].id, "a");
        assert_eq!(test.db.edit_version_ids("a").unwrap(), ["b"]);
    }
}

impl Database {
    pub fn deleted_ids(&self, account: &str, mode: DeleteBehavior) -> Result<Vec<String>, String> {
        let conn = self.open()?;
        let sql = match mode {
            DeleteBehavior::Archive => "SELECT id FROM assets WHERE account_id=?1 AND (is_archived=1 OR visibility='archive')",
            DeleteBehavior::Trash => "SELECT asset_id FROM trashed_assets WHERE account_id=?1",
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([account], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn evict_absent_deleted(&self, account: &str, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        self.init_media()?;
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in ids {
            let safe: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND account_id=?2)
                 AND NOT EXISTS(SELECT 1 FROM pending_mutations WHERE asset_id=?1 AND account_id=?2)",
                params![id, account], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if !safe {
                continue;
            }
            for table in ["asset_people", "album_assets", "trashed_assets"] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE asset_id=?1 AND account_id=?2"),
                    params![id, account],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.execute("DELETE FROM edit_versions WHERE asset_id=?1", [id])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM assets WHERE id=?1 AND account_id=?2",
                params![id, account],
            )
            .map_err(|e| e.to_string())?;
            log::info!(
                "[assets.deleted-refresh] evicted remotely absent asset={id} account={account}"
            );
        }
        tx.commit().map_err(|e| e.to_string())
    }
    /// Apply and enqueue together, preserving account ownership and replay order.
    pub fn apply_deleted_state(
        &self,
        account: &str,
        id: &str,
        behavior: DeleteBehavior,
        restore: bool,
        queue: Option<(&str, &str)>,
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let owned: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND account_id=?2)",
                params![id, account],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !owned {
            return Err("Cannot delete or restore an asset owned by another account".into());
        }
        match behavior {
            DeleteBehavior::Archive => {
                tx.execute(
                    "UPDATE assets SET is_archived=?3,visibility=?4 WHERE id=?1 AND account_id=?2",
                    params![
                        id,
                        account,
                        !restore,
                        if restore { "timeline" } else { "archive" }
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            DeleteBehavior::Trash => {
                if restore {
                    tx.execute(
                        "DELETE FROM trashed_assets WHERE asset_id=?1 AND account_id=?2",
                        params![id, account],
                    )
                } else {
                    tx.execute(
                        "INSERT OR IGNORE INTO trashed_assets(asset_id,account_id) VALUES(?1,?2)",
                        params![id, account],
                    )
                }
                .map_err(|e| e.to_string())?;
            }
        }
        if let Some((kind, payload)) = queue {
            tx.execute(
                "INSERT INTO pending_mutations(asset_id,account_id,kind,payload_json,created_at)
                 VALUES(?1,?2,?3,?4,?5)",
                params![id, account, kind, payload, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Only reconcile the selected account after a complete successful listing.
    /// Pending local decisions win over the server snapshot.
    pub fn reconcile_deleted(
        &self,
        account: &str,
        ids: &[String],
        behavior: DeleteBehavior,
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        match behavior {
            DeleteBehavior::Trash => {
                tx.execute(
                    "DELETE FROM trashed_assets WHERE account_id=?1 AND asset_id NOT IN
                     (SELECT asset_id FROM pending_mutations WHERE account_id=?1)",
                    [account],
                )
                .map_err(|e| e.to_string())?;
            }
            DeleteBehavior::Archive => {
                tx.execute(
                    "UPDATE assets SET is_archived=0,visibility='timeline' WHERE account_id=?1
                     AND (is_archived=1 OR visibility='archive') AND id NOT IN
                     (SELECT asset_id FROM pending_mutations WHERE account_id=?1)",
                    [account],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        for id in ids {
            let pending: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_mutations WHERE asset_id=?1 AND account_id=?2)",
                params![id, account], |r| r.get(0),
            ).map_err(|e| e.to_string())?;
            if pending {
                continue;
            }
            match behavior {
                DeleteBehavior::Trash => {
                    tx.execute("INSERT OR IGNORE INTO trashed_assets(asset_id,account_id) VALUES(?1,?2)", params![id, account])
                }
                DeleteBehavior::Archive => {
                    tx.execute("UPDATE assets SET is_archived=1,visibility='archive' WHERE id=?1 AND account_id=?2", params![id, account])
                }
            }.map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
