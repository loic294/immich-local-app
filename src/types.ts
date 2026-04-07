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
};

export type AssetPage = {
  page: number;
  pageSize: number;
  items: AssetSummary[];
  hasNextPage: boolean;
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
