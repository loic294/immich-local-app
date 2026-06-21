export type AssetSummary = {
  id: string;
  originalFileName: string;
  fileCreatedAt: string | null;
  checksum: string | null;
  type: string | null;
  duration: string | null;
  livePhotoVideoId: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  visibility: string | null;
  rating: number | null;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
};

export type GridLayoutAssetInput = {
  id: string;
  fileCreatedAt: string | null;
  type: string | null;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
};

export type GridLayoutItem = {
  id: string;
  width: number;
  thumbhash: string | null;
};

export type GridLayoutRow = {
  height: number;
  items: GridLayoutItem[];
};

export type GridLayoutSection = {
  key: string;
  label: string;
  rows: GridLayoutRow[];
};

export type GridLayoutResponse = {
  sections: GridLayoutSection[];
};

export type AssetPage = {
  page: number;
  pageSize: number;
  items: AssetSummary[];
  hasNextPage: boolean;
};

export type AssetDateJumpTarget = {
  dateKey: string;
  page: number;
};

export type TimelineLayoutDay = {
  dateKey: string;
  year: number;
  month: number;
  rowCount: number;
};

export type TimelineLayoutMonth = {
  monthKey: string;
  jumpDateKey: string;
  year: number;
  month: number;
  rowCount: number;
};

export type TimelineLayoutResponse = {
  totalRows: number;
  days: TimelineLayoutDay[];
  months: TimelineLayoutMonth[];
};

export type MemorySummary = {
  id: string;
  title: string | null;
  memoryAt: string | null;
  year: number | null;
  assets: AssetSummary[];
};

export type TimelineMonths = {
  newestMonth: string | null;
  oldestMonth: string | null;
  months: string[];
};

export type AlbumOwnerSummary = {
  id: string;
  name: string | null;
  email: string | null;
};

export type AlbumSummary = {
  id: string;
  albumName: string;
  albumThumbnailAssetId: string | null;
  ownerId: string;
  shared: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  assetCount: number | null;
  owner: AlbumOwnerSummary | null;
  description: string | null;
  savedLocalFolderPath: string | null;
  role: string | null;
  isReadOnly: boolean | null;
};

export type AlbumShareUser = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
};

export type AlbumUserCandidate = {
  id: string;
  name: string | null;
  email: string | null;
};

export type AlbumSaveResponse = {
  folderPath: string;
};

export type MyPhotosRule = {
  startDate: string;
  endDate: string | null;
  endDateCurrent: boolean;
  camera: string;
};

export type Settings = {
  locale: "en-CA" | "fr-CA";
  livePhotoAutoplay: boolean;
  thumbnailCachePath: string;
  videoCachePath: string;
  userLocalFolderPath: string;
  menuItems: string[];
  myPhotosRules: MyPhotosRule[];
};

export type LocalCopyResult = {
  copiedOriginalCount: number;
  copiedCachedCount: number;
  originalUnavailableCount: number;
  cacheFallbackAvailableCount: number;
  skippedCount: number;
  failedCount: number;
  hasFallbackCandidates: boolean;
  fallbackCandidateAssetIds: string[];
};

export type CacheStats = {
  totalThumbnailsSize: number;
  thumbnailsCount: number;
  totalVideosSize: number;
  videosCount: number;
  totalSize: number;
};

export type AssetVisibility = "timeline" | "archive" | "hidden" | "locked";

export type AssetFilter = "all" | "favorites" | "archived";

/** How the rating value should be compared against an asset's rating. */
export type RatingMode = "eq" | "gte" | "lte";

/** Media-type selector for the Type filter. */
export type MediaTypeFilter = "photo" | "raw" | "photo_raw" | "video";

/**
 * Structured, server-evaluated filter criteria applied on top of a photo grid
 * view (all photos, album, folder or calendar month). All fields are optional;
 * an absent/null field means "do not filter on this dimension".
 */
export type AssetFilterCriteria = {
  rating: number | null;
  ratingMode: RatingMode | null;
  favoriteOnly: boolean | null;
  myPhotosOnly: boolean | null;
  mediaType: MediaTypeFilter | null;
  camera: string | null;
  personId: string | null;
};

export const DEFAULT_FILTER_CRITERIA: AssetFilterCriteria = {
  rating: null,
  ratingMode: "gte",
  favoriteOnly: null,
  myPhotosOnly: null,
  mediaType: null,
  camera: null,
  personId: null,
};

/** The dimension by which assets are sorted. */
export type SortField = "date_captured" | "filename";

/** Direction of a sort. */
export type SortDirection = "asc" | "desc";

/** User-selected sort preference, persisted globally across all views. */
export type SortPreference = {
  field: SortField;
  direction: SortDirection;
};

export const DEFAULT_SORT_PREFERENCE: SortPreference = {
  field: "date_captured",
  direction: "desc",
};

/** True when any filter dimension is active (i.e. would narrow the result set). */
export function isFilterActive(criteria: AssetFilterCriteria): boolean {
  return (
    criteria.rating != null ||
    criteria.favoriteOnly === true ||
    criteria.myPhotosOnly === true ||
    criteria.mediaType != null ||
    (criteria.camera != null && criteria.camera !== "") ||
    (criteria.personId != null && criteria.personId !== "")
  );
}

/**
 * Build the criteria payload to send to the backend, collapsing an inactive
 * filter to `null` so unfiltered queries skip the criteria subquery entirely.
 */
export function criteriaPayload(
  criteria: AssetFilterCriteria,
): AssetFilterCriteria | null {
  return isFilterActive(criteria) ? criteria : null;
}

/** The kind of photo grid view a filter is scoped to. */
export type ViewScopeKind = "all" | "album" | "folder" | "month";

/**
 * Identifies the current photo grid view so the backend can scope the
 * Camera/People dropdown options to just the assets shown in that view.
 */
export type ViewScope = {
  kind: ViewScopeKind;
  filter?: string | null;
  albumId?: string | null;
  path?: string | null;
  year?: number | null;
  month?: number | null;
};

/** A person that appears in the photos, used by the People filter dropdown. */
export type PersonSummary = {
  id: string;
  name: string | null;
  isHidden: boolean;
  thumbnailPath: string | null;
};

export type AssetCacheDetails = {
  id: string;
  originalFileName: string;
  description: string | null;
  originalPath: string | null;
  fileCreatedAt: string | null;
  checksum: string | null;
  type: string | null;
  duration: string | null;
  width: number | null;
  height: number | null;
  camera: string | null;
  lens: string | null;
  fileSizeBytes: number | null;
  fileExtension: string | null;
  people: string | null;
  tags: string | null;
  exifInfoJson: string | null;
  isMyPhoto: boolean;
};

export type SavedLocalFileChange = {
  id: number;
  assetId: string;
  localPath: string;
  fileName: string;
  changeKind: "deleted" | "modified" | string;
  detailsJson: string;
  detectedAt: string;
};

export type ApplySavedLocalFileChangesResult = {
  appliedCount: number;
  failedCount: number;
  errors: string[];
};
