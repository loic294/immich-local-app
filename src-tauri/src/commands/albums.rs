use crate::commands::assets::{calculate_grid_layout, AssetPage, GridLayoutAssetInput, GridLayoutResponse};
use crate::services::immich_client::{AlbumOwnerSummary, AlbumSummary};
use crate::AppState;
use std::time::Instant;

#[tauri::command]
pub async fn fetch_albums(state: tauri::State<'_, AppState>) -> Result<Vec<AlbumSummary>, String> {
    let cached = state
        .db
        .get_albums()
        .map_err(|err| format!("album cache read failed: {err}"))?;

    Ok(cached
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
            }
        })
        .collect())
}

#[tauri::command]
pub async fn get_album_assets_paged(
    album_id: String,
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let (cached_items, cached_has_next_page) = state
        .db
        .get_album_assets(&album_id, page, page_size)
        .map_err(|err| format!("album asset cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items: cached_items,
        has_next_page: cached_has_next_page,
    })
}

#[tauri::command]
pub async fn get_cached_album_full_grid_layout(
    album_id: String,
    container_width: f64,
    state: tauri::State<'_, AppState>,
) -> Result<GridLayoutResponse, String> {
    let started_at = Instant::now();
    if container_width <= 0.0 {
        return Ok(GridLayoutResponse { sections: Vec::new() });
    }

    let all_assets = state
        .db
        .get_all_album_assets(&album_id)
        .map_err(|err| format!("album full grid layout cache read failed: {err}"))?;

    let layout_assets = all_assets
        .into_iter()
        .map(|asset| GridLayoutAssetInput {
            id: asset.id,
            file_created_at: asset.file_created_at,
            r#type: asset.r#type,
            width: asset.width,
            height: asset.height,
            thumbhash: asset.thumbhash,
        })
        .collect();

    let response = calculate_grid_layout(layout_assets, container_width)?;

    eprintln!(
        "[albums.get_cached_album_full_grid_layout] album_id={} container_width={} sections={} duration_ms= {}",
        album_id,
        container_width,
        response.sections.len(),
        started_at.elapsed().as_millis()
    );

    Ok(response)
}