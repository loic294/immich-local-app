import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary, GridLayoutResponse } from "../types";
import type { BrowsingPerson, MapBounds, MapMarker } from "../types/browsing";

export const getCachedPeople = () => invoke<BrowsingPerson[]>("get_cached_people");
export const refreshPeople = () => invoke<void>("refresh_people");
export const getCachedMapMarkers = () => invoke<MapMarker[]>("get_cached_map_markers");
export const getCachedMapAssets = (bounds: MapBounds, assetIds: string[] | null) =>
  invoke<AssetSummary[]>("get_cached_map_assets", { bounds, assetIds });
export const getCachedMapFullGridLayout = (
  bounds: MapBounds,
  assetIds: string[] | null,
  containerWidth: number,
) =>
  invoke<GridLayoutResponse>("get_cached_map_full_grid_layout", {
    bounds,
    assetIds,
    containerWidth,
  });
export const refreshMapAssets = (assetIds: string[]) =>
  invoke<number>("refresh_map_assets", { assetIds });
