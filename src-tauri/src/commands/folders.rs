use crate::commands::assets::AssetPage;
use crate::AppState;
use crate::commands::assets::{GridLayoutAssetInput, GridLayoutResponse, calculate_grid_layout};
use std::time::Instant;

#[tauri::command]
pub async fn get_unique_original_paths(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state
        .db
        .get_unique_original_paths()
        .map_err(|err| format!("folder path cache read failed: {err}"))
}

#[tauri::command]
pub async fn get_folder_assets_paged(
    path: String,
    page: u32,
    page_size: u32,
    state: tauri::State<'_, AppState>,
) -> Result<AssetPage, String> {
    let (cached_items, cached_has_next_page) = state
        .db
        .get_folder_assets(&path, page, page_size)
        .map_err(|err| format!("folder asset cache read failed: {err}"))?;

    Ok(AssetPage {
        page,
        page_size,
        items: cached_items,
        has_next_page: cached_has_next_page,
    })
}

#[tauri::command]
pub async fn get_cached_folder_full_grid_layout(
    path: String,
    container_width: f64,
    state: tauri::State<'_, AppState>,
) -> Result<GridLayoutResponse, String> {
    let started_at = Instant::now();
    if container_width <= 0.0 {
        return Ok(GridLayoutResponse { sections: Vec::new() });
    }

    let all_assets = state
        .db
        .get_all_folder_assets(&path)
        .map_err(|err| format!("folder full grid layout cache read failed: {err}"))?;

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
        "[folders.get_cached_folder_full_grid_layout] path={} container_width={} sections={} duration_ms={}",
        path,
        container_width,
        response.sections.len(),
        started_at.elapsed().as_millis()
    );

    Ok(response)
}