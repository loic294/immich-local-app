use super::{
    asset_filter_where_clause, criteria_filter, criteria_with_search, AssetFilterCriteria,
    Database, SortParams,
};
use crate::commands::assets::GridLayoutAssetInput;
use rusqlite::params_from_iter;

impl Database {
    /// Read only persisted layout fields, not per-photo fullscreen/stack metadata.
    pub fn get_grid_layout_assets(
        &self,
        search: Option<&str>,
        filter: Option<&str>,
        criteria: Option<&AssetFilterCriteria>,
        sort: Option<&SortParams>,
    ) -> Result<Vec<GridLayoutAssetInput>, String> {
        let conn = self.open()?;
        let merged = criteria_with_search(search, criteria);
        let filter = filter.unwrap_or("all").trim().to_ascii_lowercase();
        let deleted_view = matches!(filter.as_str(), "archived" | "trashed");
        let (criteria_sql, params) =
            criteria_filter(&conn, merged.as_ref().or(criteria), "id", 1, deleted_view);
        let visibility = if deleted_view {
            ""
        } else {
            " AND COALESCE(is_archived, 0) = 0 AND LOWER(COALESCE(visibility, '')) <> 'archive'"
        };
        let default_sort = SortParams::default();
        let query = format!(
            "SELECT id, file_created_at, asset_type, width, height, thumbhash
             FROM assets WHERE ({}){visibility}{criteria_sql} ORDER BY {}",
            asset_filter_where_clause(Some(&filter)),
            sort.unwrap_or(&default_sort).order_by_clause()
        );
        let mut statement = conn.prepare(&query).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(params.iter()), |row| {
                Ok(GridLayoutAssetInput {
                    id: row.get(0)?,
                    file_created_at: row.get(1)?,
                    r#type: row.get(2)?,
                    width: row.get(3)?,
                    height: row.get(4)?,
                    thumbhash: row.get(5)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
}
