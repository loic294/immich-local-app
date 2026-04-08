use crate::commands::assets::AssetPage;
use crate::services::immich_client::{AlbumOwnerSummary, AlbumSummary};
use crate::AppState;

#[tauri::command]
pub async fn fetch_albums(state: tauri::State<'_, AppState>) -> Result<Vec<AlbumSummary>, String> {
    let cached = state
        .db
        .get_albums()
        .map_err(|err| format!("album cache read failed: {err}"))?;

    if !cached.is_empty() {
        return Ok(cached
            .into_iter()
            .map(|album| {
                let owner_id = album.owner_id.clone();

                AlbumSummary {
                id: album.id,
                album_name: album.album_name,
                album_thumbnail_asset_id: album.album_thumbnail_asset_id,
                owner_id,
                shared: album.shared,
                created_at: album.created_at,
                updated_at: album.updated_at,
                start_date: album.start_date,
                end_date: album.end_date,
                asset_count: album.asset_count,
                owner: Some(AlbumOwnerSummary {
                    id: album.owner_id,
                    name: album.owner_name,
                    email: album.owner_email,
                }),
                description: album.description,
            }})
            .collect());
    }

    let albums = state
        .immich
        .get_albums()
        .await
        .map_err(|err| format!("fetch albums failed: {err}"))?;

    state
        .db
        .upsert_albums(&albums)
        .map_err(|err| format!("album cache write failed: {err}"))?;

    Ok(albums)
}

#[tauri::command]
pub async fn get_album_assets_paged(
    album_id: String,
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let album_exists = state
        .db
        .has_album(&album_id)
        .map_err(|err| format!("album cache read failed: {err}"))?;

    let (cached_items, cached_has_next_page) = state
        .db
        .get_album_assets(&album_id, page, page_size)
        .map_err(|err| format!("album asset cache read failed: {err}"))?;

    if album_exists && (page > 0 || !cached_items.is_empty() || !cached_has_next_page) {
        return Ok(AssetPage {
            page,
            page_size,
            items: cached_items,
            has_next_page: cached_has_next_page,
        });
    }

    let items = state
        .immich
        .get_album_assets(&album_id)
        .await
        .map_err(|err| format!("fetch album assets failed: {err}"))?;

    state
        .db
        .upsert_assets(&items)
        .map_err(|err| format!("cache write failed: {err}"))?;

    let asset_ids = items.iter().map(|asset| asset.id.clone()).collect::<Vec<_>>();
    state
        .db
        .replace_album_assets(&album_id, &asset_ids)
        .map_err(|err| format!("album asset cache write failed: {err}"))?;

    let (items, has_next_page) = state
        .db
        .get_album_assets(&album_id, page, page_size)
        .map_err(|err| format!("album asset cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items,
        has_next_page,
    })
}