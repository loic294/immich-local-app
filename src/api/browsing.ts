import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary, GridLayoutResponse } from "../types";
import type { BrowsingPerson, MapBounds, MapMarker } from "../types/browsing";

export const getCachedPeople = () => invoke<BrowsingPerson[]>("get_cached_people");
export const getCachedNamedPeople = (accountId: string) =>
  invoke<BrowsingPerson[]>("get_cached_named_people", { accountId });
export const refreshPeople = () => invoke<void>("refresh_people");
export const changePerson = (
  accountId: string,
  personId: string,
  action: "name" | "merge" | "hide",
  name?: string,
  targetId?: string,
) => invoke<void>("change_person", { accountId, personId, action, name, targetId });
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
