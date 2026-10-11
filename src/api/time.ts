import { invoke } from "@tauri-apps/api/core";
import type { AssetFilter, AssetFilterCriteria, AssetPage, ViewScope } from "../types";
import type {
  AssetsTimeShiftedDetail,
  FixTimeRequestDetail,
  ShiftAssetTimesResult,
} from "../types/time";
import {
  getCachedAlbumAssetsPaged,
  getCachedAssets,
  getCachedCalendarAssetsPaged,
  getCachedFolderAssetsPaged,
} from "./tauri";

export const FIX_TIME_EVENT = "immich:fix-time";
export const ASSETS_TIME_SHIFTED_EVENT = "immich:assets-time-shifted";

/**
 * Shifts the capture time of assets by `offsetSeconds` (Immich metadata and
 * local cache only; original files are never modified). Offline changes are
 * applied locally and queued for replay.
 */
export async function shiftAssetTimes(
  assetIds: string[],
  offsetSeconds: number,
): Promise<ShiftAssetTimesResult> {
  return invoke<ShiftAssetTimesResult>("shift_asset_times", {
    payload: { assetIds, offsetSeconds },
  });
}

/** Opens the Fix time dialog hosted by the mounted PhotoGrid. */
export function requestFixTime(assetIds: string[]): void {
  if (assetIds.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<FixTimeRequestDetail>(FIX_TIME_EVENT, { detail: { assetIds } }),
  );
}

export function notifyAssetsTimeShifted(detail: AssetsTimeShiftedDetail): void {
  window.dispatchEvent(
    new CustomEvent<AssetsTimeShiftedDetail>(ASSETS_TIME_SHIFTED_EVENT, { detail }),
  );
}

/** Pages the current view from the local cache only (never the network). */
export async function getCachedScopePage(
  scope: ViewScope,
  page: number,
  pageSize: number,
  criteria?: AssetFilterCriteria | null,
): Promise<AssetPage> {
  switch (scope.kind) {
    case "album":
      if (scope.albumId) return getCachedAlbumAssetsPaged(scope.albumId, page, pageSize, criteria);
      break;
    case "folder":
      if (scope.path) return getCachedFolderAssetsPaged(scope.path, page, pageSize, criteria);
      break;
    case "month":
      if (scope.year && scope.month) {
        return getCachedCalendarAssetsPaged(scope.year, scope.month, page, pageSize, criteria);
      }
      break;
    default:
      break;
  }
  return getCachedAssets(
    page,
    pageSize,
    null,
    (scope.filter as AssetFilter | null | undefined) ?? null,
    criteria,
  );
}
