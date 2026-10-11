import type { AssetFilterCriteria, AssetSummary, ViewScope } from "../types";

export type ShiftAssetTimeFailure = {
  assetId: string;
  error: string;
};

/** Result of `shift_asset_times`: updated on Immich, queued offline, failed. */
export type ShiftAssetTimesResult = {
  updatedCount: number;
  queuedCount: number;
  failed: ShiftAssetTimeFailure[];
};

/** Detail of the `immich:fix-time` window event. */
export type FixTimeRequestDetail = {
  assetIds: string[];
};

/** Detail of the `immich:assets-time-shifted` window event. */
export type AssetsTimeShiftedDetail = {
  assetIds: string[];
  offsetSeconds: number;
};

/** Source of the reference (right) panel in the Fix time dialog. */
export type FixTimeReferenceSource = {
  scope: ViewScope;
  criteria?: AssetFilterCriteria | null;
};

export type FixTimeAsset = Pick<
  AssetSummary,
  "id" | "originalFileName" | "fileCreatedAt" | "type" | "thumbhash"
>;

/** A signed offset broken into editable parts. */
export type TimeOffsetParts = {
  sign: 1 | -1;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};
