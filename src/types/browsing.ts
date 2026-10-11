import type { AssetSummary, PersonSummary } from "../types";

export type MapMarker = { id: string; latitude: number; longitude: number };
export type MapFocus = MapMarker;
export type MapBounds = { west: number; south: number; east: number; north: number };
export type BrowsingPerson = PersonSummary & { assetCount: number };
export type MapAsset = AssetSummary;

export function openAssetOnMap(focus: MapFocus): void {
  window.dispatchEvent(new CustomEvent("immich:open-map", { detail: focus }));
}
