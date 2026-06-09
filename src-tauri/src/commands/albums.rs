use crate::commands::assets::{
    calculate_grid_layout, AssetPage, GridLayoutAssetInput, GridLayoutResponse,
};
use crate::services::immich_client::{
    AlbumOwnerSummary, AlbumShareUser, AlbumSummary, AlbumUserCandidate,
};
use crate::AppState;
use std::time::Instant;

fn is_visible_in_grid(asset: &crate::services::immich_client::AssetSummary) -> bool {
    if asset.is_archived {
        return false;
    }

    let visibility = asset
        .visibility
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    visibility != "archive"
}

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
                role: None,
                is_read_only: None,
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
        return Ok(GridLayoutResponse {
            sections: Vec::new(),
        });
    }

    let all_assets = state
        .db
        .get_all_album_assets(&album_id)
        .map_err(|err| format!("album full grid layout cache read failed: {err}"))?;

    let layout_assets = all_assets
        .into_iter()
        .filter(is_visible_in_grid)
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

#[tauri::command]
pub async fn create_album_with_assets(
    album_name: String,
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<AlbumSummary, String> {
    let created = state
        .immich
        .create_album_with_assets(&album_name, &asset_ids)
        .await
        .map_err(|err| format!("create album failed: {err}"))?;

    let albums = state
        .immich
        .get_albums()
        .await
        .map_err(|err| format!("refresh album list failed: {err}"))?;

    state
        .db
        .upsert_albums(&albums)
        .map_err(|err| format!("album cache write failed: {err}"))?;

    Ok(created)
}

#[tauri::command]
pub async fn add_assets_to_album(
    album_id: String,
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .immich
        .add_assets_to_album(&album_id, &asset_ids)
        .await
        .map_err(|err| format!("add assets to album failed: {err}"))?;

    let albums = state
        .immich
        .get_albums()
        .await
        .map_err(|err| format!("refresh album list failed: {err}"))?;

    state
        .db
        .upsert_albums(&albums)
        .map_err(|err| format!("album cache write failed: {err}"))?;

    Ok(())
}

#[tauri::command]
pub async fn create_share_link_for_assets(
    asset_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .immich
        .create_share_link_for_assets(&asset_ids)
        .await
        .map_err(|err| format!("create share link failed: {err}"))
}

#[tauri::command]
pub async fn can_manage_album_sharing(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    state
        .immich
        .can_manage_album_sharing(&album_id)
        .await
        .map_err(|err| format!("can manage album sharing failed: {err}"))
}

#[tauri::command]
pub async fn get_or_create_album_share_link(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .immich
        .get_or_create_album_share_link(&album_id)
        .await
        .map_err(|err| format!("get or create album share link failed: {err}"))
}

#[tauri::command]
pub async fn get_album_share_link(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    state
        .immich
        .get_album_share_link(&album_id)
        .await
        .map_err(|err| format!("get album share link failed: {err}"))
}

#[tauri::command]
pub async fn get_album_share_users(
    album_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AlbumShareUser>, String> {
    state
        .immich
        .get_album_share_users(&album_id)
        .await
        .map_err(|err| format!("get album share users failed: {err}"))
}

#[tauri::command]
pub async fn get_shareable_users(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AlbumUserCandidate>, String> {
    state
        .immich
        .get_shareable_users()
        .await
        .map_err(|err| format!("get shareable users failed: {err}"))
}

#[tauri::command]
pub async fn add_user_to_album(
    album_id: String,
    user_id: String,
    role: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .immich
        .add_user_to_album(&album_id, &user_id, &role)
        .await
        .map_err(|err| format!("add user to album failed: {err}"))
}

#[tauri::command]
pub async fn remove_user_from_album(
    album_id: String,
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .immich
        .remove_user_from_album(&album_id, &user_id)
        .await
        .map_err(|err| format!("remove user from album failed: {err}"))
}
