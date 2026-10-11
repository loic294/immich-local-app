use crate::services::db::Database;
use crate::services::immich_client::{AssetSummary, PersonSummary};
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsingPerson {
    #[serde(flatten)]
    pub person: PersonSummary,
    pub asset_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapMarker {
    pub id: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl MapBounds {
    pub fn validate(&self) -> Result<(), String> {
        if ![self.west, self.east, self.south, self.north]
            .iter()
            .all(|v| v.is_finite())
            || !(-180.0..=180.0).contains(&self.west)
            || !(-180.0..=180.0).contains(&self.east)
            || !(-90.0..=90.0).contains(&self.south)
            || !(-90.0..=90.0).contains(&self.north)
            || self.south > self.north
        {
            return Err("invalid map bounds: finite longitude [-180,180] and latitude [-90,90] required; south must not exceed north".into());
        }
        Ok(())
    }
    pub fn contains(&self, marker: &MapMarker) -> bool {
        if marker.latitude < self.south || marker.latitude > self.north {
            return false;
        }
        if self.east - self.west >= 360.0 {
            return true;
        }
        let west = (self.west + 180.0).rem_euclid(360.0) - 180.0;
        let east = (self.east + 180.0).rem_euclid(360.0) - 180.0;
        if west <= east {
            marker.longitude >= west && marker.longitude <= east
        } else {
            marker.longitude >= west || marker.longitude <= east
        }
    }
}

fn visible_assets(conn: &Connection, alias: &str) -> Result<String, String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(assets)")
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut stack_column = false;
    for name in names {
        if name.map_err(|e| e.to_string())? == "is_stack_secondary" {
            stack_column = true;
        }
    }
    Ok(format!(
        "COALESCE({alias}.is_archived,0)=0 AND LOWER(COALESCE({alias}.visibility,'timeline')) NOT IN ('archive','hidden','locked'){}",
        if stack_column { format!(" AND COALESCE({alias}.is_stack_secondary,0)=0") } else { String::new() }
    ))
}

fn coordinates(json: &str) -> Option<(f64, f64)> {
    let exif: serde_json::Value = serde_json::from_str(json).ok()?;
    let number = |key: &str| {
        let value = exif.get(key)?;
        value
            .as_f64()
            .or_else(|| value.as_str()?.parse::<f64>().ok())
    };
    let lat = number("latitude")?;
    let lon = number("longitude")?;
    (lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon))
    .then_some((lat, lon))
}

impl Database {
    pub fn browsing_people(&self) -> Result<Vec<BrowsingPerson>, String> {
        let conn = self.open()?;
        read_people(&conn)
    }

    pub fn browsing_map_markers(&self) -> Result<Vec<MapMarker>, String> {
        let conn = self.open()?;
        read_markers(&conn)
    }

    pub fn browsing_map_assets(
        &self,
        bounds: &MapBounds,
        ids: Option<&[String]>,
    ) -> Result<Vec<AssetSummary>, String> {
        bounds.validate()?;
        let conn = self.open()?;
        read_map_assets(&conn, bounds, ids)
    }
}

fn read_people(conn: &Connection) -> Result<Vec<BrowsingPerson>, String> {
    let visible = visible_assets(conn, "a")?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT p.id, p.name, p.is_hidden, p.thumbnail_path, COUNT(DISTINCT a.id)
             FROM people p LEFT JOIN asset_people ap ON ap.person_id=p.id
             LEFT JOIN assets a ON a.id=ap.asset_id AND ({visible})
             WHERE COALESCE(p.is_hidden,0)=0 GROUP BY p.id HAVING COUNT(DISTINCT a.id)>0
             ORDER BY CASE WHEN TRIM(COALESCE(p.name,''))='' THEN 1 ELSE 0 END,
                p.name COLLATE NOCASE, p.id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(BrowsingPerson {
                person: PersonSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    is_hidden: row.get::<_, Option<i32>>(2)?.unwrap_or(0) != 0,
                    thumbnail_path: row.get(3)?,
                },
                asset_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn read_markers(conn: &Connection) -> Result<Vec<MapMarker>, String> {
    let visible = visible_assets(conn, "a")?;
    let mut stmt = conn.prepare(&format!(
            "SELECT a.id, a.exif_info_json FROM assets a WHERE a.exif_info_json IS NOT NULL AND ({visible})"
        )).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut markers = Vec::new();
    for row in rows {
        let (id, json) = row.map_err(|e| e.to_string())?;
        if let Some((latitude, longitude)) = coordinates(&json) {
            markers.push(MapMarker {
                id,
                latitude,
                longitude,
            });
        }
    }
    Ok(markers)
}

fn read_map_assets(
    conn: &Connection,
    bounds: &MapBounds,
    ids: Option<&[String]>,
) -> Result<Vec<AssetSummary>, String> {
    bounds.validate()?;
    if ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(Vec::new());
    }
    let visible = visible_assets(conn, "a")?;
    let latitude = "CAST(json_extract(CASE WHEN json_valid(a.exif_info_json) THEN a.exif_info_json ELSE '{}' END,'$.latitude') AS REAL)";
    let longitude = "CAST(json_extract(CASE WHEN json_valid(a.exif_info_json) THEN a.exif_info_json ELSE '{}' END,'$.longitude') AS REAL)";
    let mut assets = Vec::new();
    // Fixed-size batches stay below SQLite's bind limit without a per-photo query.
    let batches: Vec<&[String]> = ids
        .map(|ids| ids.chunks(500).collect::<Vec<&[String]>>())
        .unwrap_or_else(|| vec![&[]]);
    for batch in batches {
        let selection = if ids.is_some() {
            format!("a.id IN ({})", vec!["?"; batch.len()].join(","))
        } else {
            let lon_filter = if bounds.west <= bounds.east {
                format!(
                    "{longitude}>={} AND {longitude}<={}",
                    bounds.west, bounds.east
                )
            } else {
                format!(
                    "({longitude}>={} OR {longitude}<={})",
                    bounds.west, bounds.east
                )
            };
            format!(
                "{latitude}>={} AND {latitude}<={} AND ({lon_filter})",
                bounds.south, bounds.north
            )
        };
        let mut stmt = conn.prepare(&format!(
                "SELECT a.id,a.original_file_name,a.original_path,a.file_created_at,a.checksum,a.asset_type,a.duration,
                a.is_favorite,a.is_archived,a.visibility,a.rating,a.width,a.height,a.thumbhash,a.exif_info_json
                FROM assets a WHERE ({visible}) AND ({selection})"
            )).map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(batch.iter()), |r| {
                Ok((
                    AssetSummary {
                        id: r.get(0)?,
                        original_file_name: r.get(1)?,
                        original_path: r.get(2)?,
                        file_created_at: r.get(3)?,
                        checksum: r.get(4)?,
                        r#type: r.get(5)?,
                        duration: r.get(6)?,
                        live_photo_video_id: None,
                        is_favorite: r.get::<_, Option<i32>>(7)?.unwrap_or(0) != 0,
                        is_archived: r.get::<_, Option<i32>>(8)?.unwrap_or(0) != 0,
                        visibility: r.get(9)?,
                        rating: r.get(10)?,
                        width: r.get(11)?,
                        height: r.get(12)?,
                        thumbhash: r.get(13)?,
                    },
                    r.get::<_, Option<String>>(14)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (asset, json) = row.map_err(|e| e.to_string())?;
            if json.as_deref().and_then(coordinates).is_some() {
                assets.push(asset);
            }
        }
    }
    assets.sort_by(|a, b| {
        b.file_created_at
            .cmp(&a.file_created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    assets.dedup_by(|a, b| a.id == b.id);
    Ok(assets)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE assets(id TEXT PRIMARY KEY, original_file_name TEXT,original_path TEXT,
             file_created_at TEXT,checksum TEXT,asset_type TEXT,duration TEXT,is_favorite INTEGER,
             is_archived INTEGER,visibility TEXT,rating INTEGER,width INTEGER,height INTEGER,thumbhash TEXT,exif_info_json TEXT);
             CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT,is_hidden INTEGER,thumbnail_path TEXT);
             CREATE TABLE asset_people(asset_id TEXT,person_id TEXT,PRIMARY KEY(asset_id,person_id));
             INSERT INTO people VALUES('alice','Alice',0,NULL),('private','Private',0,NULL),('hidden-person','Hidden',1,NULL);
             INSERT INTO assets(id,original_file_name,file_created_at,width,height,thumbhash,exif_info_json)
             VALUES('zero','zero.jpg','2026-01-01',1000,600,'hash','{\"latitude\":\"0\",\"longitude\":0}'),
             ('dateline','dateline.jpg','2026-02-01',800,500,NULL,'{\"latitude\":1,\"longitude\":-175}'),
             ('invalid','invalid.jpg','2026-03-01',NULL,NULL,NULL,'{\"latitude\":95,\"longitude\":0}'),
             ('bad-number','bad.jpg','2026-03-01',NULL,NULL,NULL,'{\"latitude\":\"bad\",\"longitude\":0}'),
             ('bad-json','bad.json','2026-03-01',NULL,NULL,NULL,'not-json');
             INSERT INTO assets(id,original_file_name,visibility,is_archived,exif_info_json)
             VALUES('locked','locked.jpg','locked',0,'{\"latitude\":0,\"longitude\":0}'),
             ('hidden','hidden.jpg','hidden',0,'{\"latitude\":0,\"longitude\":0}'),
             ('archive','archive.jpg','timeline',1,'{\"latitude\":0,\"longitude\":0}');
             INSERT INTO asset_people VALUES('zero','alice'),('locked','alice'),('locked','private'),
             ('hidden','private'),('archive','private'),('zero','hidden-person');"
        ).unwrap();
        conn
    }
    fn world() -> MapBounds {
        MapBounds {
            west: -180.,
            east: 180.,
            south: -90.,
            north: 90.,
        }
    }
    #[test]
    fn cached_queries_preserve_metadata_and_hide_private_assets() {
        let conn = fixture();
        let markers = read_markers(&conn).unwrap();
        assert_eq!(markers.len(), 2);
        let people = read_people(&conn).unwrap();
        assert_eq!(people.len(), 1);
        assert_eq!(people[0].person.id, "alice");
        assert_eq!(people[0].asset_count, 1);
        let assets = read_map_assets(&conn, &world(), None).unwrap();
        assert_eq!(assets.len(), 2);
        assert_eq!(assets[1].id, "zero");
        assert_eq!(assets[1].width, Some(1000));
        assert_eq!(assets[1].thumbhash.as_deref(), Some("hash"));
        let dateline = MapBounds {
            west: 170.,
            east: -170.,
            south: -10.,
            north: 10.,
        };
        assert_eq!(
            read_map_assets(&conn, &dateline, None).unwrap()[0].id,
            "dateline"
        );
        // Cluster selection remains stable after zooming to new bounds.
        let ids = vec!["zero".to_string(), "zero".to_string(), "locked".to_string()];
        let assets = read_map_assets(&conn, &dateline, Some(&ids)).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].id, "zero");
    }
    #[test]
    fn optional_stack_column_excludes_secondary_versions() {
        let conn = fixture();
        conn.execute_batch(
            "ALTER TABLE assets ADD COLUMN is_stack_secondary INTEGER DEFAULT 0;
            UPDATE assets SET is_stack_secondary=1 WHERE id='zero';",
        )
        .unwrap();
        assert_eq!(read_markers(&conn).unwrap().len(), 1);
        assert_eq!(read_map_assets(&conn, &world(), None).unwrap().len(), 1);
        assert!(read_people(&conn).unwrap().is_empty());
    }
    #[test]
    fn invalid_bounds_are_explicit_errors() {
        for bounds in [
            MapBounds {
                west: f64::NAN,
                ..world()
            },
            MapBounds {
                north: f64::INFINITY,
                ..world()
            },
            MapBounds {
                north: 91.,
                ..world()
            },
            MapBounds {
                west: -181.,
                ..world()
            },
            MapBounds {
                south: 50.,
                north: 40.,
                ..world()
            },
        ] {
            assert!(bounds
                .validate()
                .unwrap_err()
                .starts_with("invalid map bounds:"));
            assert!(read_map_assets(&fixture(), &bounds, None).is_err());
        }
    }
    #[test]
    fn bounded_selection_uses_primary_key_and_handles_large_clusters() {
        let mut conn = fixture();
        let tx = conn.transaction().unwrap();
        for i in 0..10000 {
            tx.execute("INSERT INTO assets(id,original_file_name,exif_info_json) VALUES(?1,'photo.jpg','{\"latitude\":10,\"longitude\":10}')",[format!("bulk-{i}")]).unwrap();
        }
        tx.commit().unwrap();
        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM assets WHERE id IN (?1)",
                ["bulk-0"],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("SEARCH"), "{plan}");
        let ids: Vec<String> = (0..1200).map(|i| format!("bulk-{i}")).collect();
        let started = std::time::Instant::now();
        assert_eq!(
            read_map_assets(&conn, &world(), Some(&ids)).unwrap().len(),
            1200
        );
        eprintln!(
            "1200 selected photos from 10000 cached photos in {:?}",
            started.elapsed()
        );
        assert!(read_map_assets(&conn, &world(), Some(&[]))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn gps_validation() {
        assert_eq!(
            coordinates(r#"{"latitude":"0","longitude":0}"#),
            Some((0.0, 0.0))
        );
        assert_eq!(coordinates(r#"{"latitude":91,"longitude":0}"#), None);
        assert_eq!(coordinates("{}"), None);
        assert_eq!(coordinates("invalid"), None);
    }
    #[test]
    fn antimeridian_bounds() {
        let bounds = MapBounds {
            west: 170.0,
            east: -170.0,
            south: -20.0,
            north: 20.0,
        };
        assert!(bounds.contains(&MapMarker {
            id: "a".into(),
            latitude: 0.0,
            longitude: -175.0
        }));
        assert!(!bounds.contains(&MapMarker {
            id: "a".into(),
            latitude: 0.0,
            longitude: 0.0
        }));
    }
}
