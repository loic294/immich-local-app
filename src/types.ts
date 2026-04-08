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
  width: number | null;
  height: number | null;
};

export type GridLayoutItem = {
  id: string;
  width: number;
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
};

export type Settings = {
  livePhotoAutoplay: boolean;
  thumbnailCachePath: string;
  videoCachePath: string;
};

export type CacheStats = {
  totalThumbnailsSize: number;
  thumbnailsCount: number;
  totalVideosSize: number;
  videosCount: number;
  totalSize: number;
};

export type AssetVisibility = "timeline" | "archive" | "hidden" | "locked";
