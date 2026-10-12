export type VideoQuality = "server" | "original";

export interface FeaturePreferences {
  maxCacheBytes: number;
  streamingVideoQuality: VideoQuality;
  offlineVideoQuality: VideoQuality;
}

export interface StorageSummary {
  cacheBytes: number;
  offlineBytes: number;
  pendingUploadBytes: number;
  diskOfflineBytes: number;
  diskPendingUploadBytes: number;
  diskTotalBytes: number;
  diskAvailableBytes: number;
  otherUsedBytes: number;
  cacheOnLibraryVolume: boolean;
  diskPath: string;
  cachePath: string;
  warnings: string[];
  cacheLimitBytes: number;
  cacheOverLimitBytes: number;
  pinnedPath: string | null;
  pinnedBytes: number;
}

export interface VideoQualityOptions {
  online: boolean;
  options: { value: VideoQuality; label: string }[];
  message: string;
}

export interface LocalStorageGroup {
  albumId: string | null;
  name: string;
  folderPath: string | null;
  bytes: number;
  fileCount: number;
}

export interface LocalStorageRemovalPreview {
  token: string;
  fileCount: number;
  unverifiedCount: number;
}
