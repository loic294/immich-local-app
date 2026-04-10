import { invoke } from "@tauri-apps/api/core";
import type {
  AlbumSummary,
  AssetVisibility,
  AssetPage,
  AssetDateJumpTarget,
  AssetSummary,
  GridLayoutAssetInput,
  GridLayoutResponse,
  TimelineLayoutResponse,
  MemorySummary,
  TimelineMonths,
  Settings,
  CacheStats,
  AssetCacheDetails,
} from "../types";

export type AuthResponse = {
  accessTokenPreview: string;
  userId: string;
  userName: string | null;
};

export type RestoreSessionResponse = {
  accessTokenPreview: string;
  userId: string;
  userName: string | null;
  serverUrl: string;
};

// Thumbnail cache: asset ID -> data URL
const thumbnailCache = new Map<string, string>();

// In-flight requests: asset ID -> Promise
const thumbnailRequests = new Map<string, Promise<string>>();

// Cache statistics
let thumbnailCacheHits = 0;
let thumbnailCacheMisses = 0;
let thumbnailDeduplicationHits = 0;

export function isThumbnailCached(assetId: string): string | null {
  return thumbnailCache.get(assetId) ?? null;
}

export async function authenticate(
  serverUrl: string,
  apiKey: string,
): Promise<AuthResponse> {
  return invoke<AuthResponse>("authenticate", {
    serverUrl,
    apiKey,
  });
}

export async function restoreSession(): Promise<RestoreSessionResponse | null> {
  return invoke<RestoreSessionResponse | null>("restore_session");
}

export async function logoutFromServer(): Promise<void> {
  return invoke<void>("logout");
}

export async function getProfileImage(userId: string): Promise<string | null> {
  return invoke<string | null>("get_profile_image", {
    userId,
  });
}

export async function fetchAssets(
  page: number,
  pageSize: number,
  search: string | null,
): Promise<AssetPage> {
  return invoke<AssetPage>("fetch_assets", {
    page,
    pageSize,
    search,
  });
}

export async function getCachedAssets(
  page: number,
  pageSize: number,
  search: string | null,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_cached_assets", {
    page,
    pageSize,
    search,
  });
}

export async function getAllCachedAssets(
  search: string | null,
): Promise<AssetSummary[]> {
  return invoke<AssetSummary[]>("get_all_cached_assets", {
    search,
  });
}

export async function getCachedAssetDays(
  search: string | null,
): Promise<string[]> {
  return invoke<string[]>("get_cached_asset_days", {
    search,
  });
}

export async function getCachedAssetJumpTarget(
  dateKey: string,
  pageSize: number,
  search: string | null,
): Promise<AssetDateJumpTarget | null> {
  return invoke<AssetDateJumpTarget | null>("get_cached_asset_jump_target", {
    dateKey,
    pageSize,
    search,
  });
}

export async function getCachedTimelineLayout(
  search: string | null,
  containerWidth: number,
): Promise<TimelineLayoutResponse> {
  return invoke<TimelineLayoutResponse>("get_cached_timeline_layout", {
    search,
    containerWidth,
  });
}

export async function getFullGridLayout(
  search: string | null,
  containerWidth: number,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("get_cached_full_grid_layout", {
    search,
    containerWidth,
  });
}

export async function getCachedAlbumFullGridLayout(
  albumId: string,
  containerWidth: number,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("get_cached_album_full_grid_layout", {
    albumId,
    containerWidth,
  });
}

export async function getCachedCalendarFullGridLayout(
  year: number,
  month: number,
  containerWidth: number,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("get_cached_calendar_full_grid_layout", {
    year,
    month,
    containerWidth,
  });
}

export async function getAssetThumbnail(assetId: string): Promise<string> {
  // Check cache first
  const cached = thumbnailCache.get(assetId);
  if (cached) {
    thumbnailCacheHits++;
    if (thumbnailCacheHits % 50 === 0) {
      console.log(
        "[thumbnail cache] hits=" +
          thumbnailCacheHits +
          " misses=" +
          thumbnailCacheMisses +
          " dedup=" +
          thumbnailDeduplicationHits,
      );
    }
    return cached;
  }

  // Check if a request is already in flight
  const inFlight = thumbnailRequests.get(assetId);
  if (inFlight) {
    thumbnailDeduplicationHits++;
    return inFlight;
  }

  // Start a new request
  thumbnailCacheMisses++;
  const promise = invoke<string>("get_asset_thumbnail", {
    assetId,
  });

  // Store the promise to deduplicate concurrent requests
  thumbnailRequests.set(assetId, promise);

  try {
    const result = await promise;
    // Cache the result
    thumbnailCache.set(assetId, result);
    return result;
  } finally {
    // Remove from in-flight requests
    thumbnailRequests.delete(assetId);
  }
}

export async function getAssetPlayback(assetId: string): Promise<string> {
  return invoke<string>("get_asset_playback", {
    assetId,
  });
}

export async function refreshAsset(assetId: string): Promise<AssetSummary> {
  return invoke<AssetSummary>("refresh_asset", {
    assetId,
  });
}

export async function getCachedAssetDetails(
  assetId: string,
): Promise<AssetCacheDetails | null> {
  return invoke<AssetCacheDetails | null>("get_cached_asset_details", {
    assetId,
  });
}

export function clearThumbnailCache(): void {
  const totalSize = thumbnailCache.size;
  thumbnailCache.clear();
  console.log(
    `[thumbnail cache] cleared ${totalSize} cached items, hits=${thumbnailCacheHits} misses=${thumbnailCacheMisses} dedup=${thumbnailDeduplicationHits}`,
  );
}

export function getThumbnailCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  dedup: number;
  hitRate: string;
} {
  const total = thumbnailCacheHits + thumbnailCacheMisses;
  const hitRate =
    total > 0 ? ((thumbnailCacheHits / total) * 100).toFixed(1) : "N/A";
  return {
    size: thumbnailCache.size,
    hits: thumbnailCacheHits,
    misses: thumbnailCacheMisses,
    dedup: thumbnailDeduplicationHits,
    hitRate: hitRate + "%",
  };
}

export async function fetchMemories(): Promise<MemorySummary[]> {
  return invoke<MemorySummary[]>("fetch_memories");
}

export async function getCachedTimelineMonths(): Promise<TimelineMonths> {
  return invoke<TimelineMonths>("get_timeline_months");
}

export async function getCachedAlbums(): Promise<AlbumSummary[]> {
  return invoke<AlbumSummary[]>("fetch_albums");
}

export async function getCachedUniqueOriginalPaths(): Promise<string[]> {
  return invoke<string[]>("get_unique_original_paths");
}

export async function getCachedAlbumAssetsPaged(
  albumId: string,
  page: number,
  pageSize: number,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_album_assets_paged", {
    albumId,
    page,
    pageSize,
  });
}

export async function getCachedFolderAssetsPaged(
  path: string,
  page: number,
  pageSize: number,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_folder_assets_paged", {
    path,
    page,
    pageSize,
  });
}

export async function getCachedCalendarAssetsPaged(
  year: number,
  month: number,
  page: number,
  pageSize: number,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_calendar_assets_paged", {
    year,
    month,
    page,
    pageSize,
  });
}

export async function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export async function updateSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>("update_settings", { settings });
}

export async function getCacheStats(): Promise<CacheStats> {
  return invoke<CacheStats>("get_cache_stats");
}

export async function getCachePath(): Promise<string> {
  return invoke<string>("get_cache_path");
}

export async function fetchTimelineMonths(): Promise<TimelineMonths> {
  return getCachedTimelineMonths();
}

export async function fetchAlbums(): Promise<AlbumSummary[]> {
  return getCachedAlbums();
}

export async function fetchUniqueOriginalPaths(): Promise<string[]> {
  return getCachedUniqueOriginalPaths();
}

export async function fetchAlbumAssetsPaged(
  albumId: string,
  page: number,
  pageSize: number,
): Promise<AssetPage> {
  return getCachedAlbumAssetsPaged(albumId, page, pageSize);
}

export async function fetchFolderAssetsPaged(
  path: string,
  page: number,
  pageSize: number,
): Promise<AssetPage> {
  return getCachedFolderAssetsPaged(path, page, pageSize);
}

export async function fetchCalendarAssetsPaged(
  year: number,
  month: number,
  page: number,
  pageSize: number,
): Promise<AssetPage> {
  return getCachedCalendarAssetsPaged(year, month, page, pageSize);
}

export async function updateAssetFavorite(
  assetId: string,
  isFavorite: boolean,
): Promise<AssetSummary> {
  return invoke<AssetSummary>("update_asset_favorite", {
    assetId,
    isFavorite,
  });
}

export async function updateAssetVisibility(
  assetId: string,
  visibility: AssetVisibility,
): Promise<AssetSummary> {
  return invoke<AssetSummary>("update_asset_visibility", {
    payload: {
      assetId,
      visibility,
    },
  });
}

export async function updateAssetRating(
  assetId: string,
  rating: number | null,
): Promise<AssetSummary> {
  return invoke<AssetSummary>("update_asset_rating", {
    assetId,
    rating,
  });
}

export async function updateAssetDescription(
  assetId: string,
  description: string | null,
): Promise<void> {
  return invoke<void>("update_asset_description", {
    payload: {
      assetId,
      description,
    },
  });
}

export async function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

export async function fetchAssetsByMonth(
  year: number,
  month: number,
): Promise<AssetPage> {
  return invoke<AssetPage>("fetch_assets_by_month", { year, month });
}

export async function calculateGridLayout(
  assets: GridLayoutAssetInput[],
  containerWidth: number,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("calculate_grid_layout", {
    assets,
    containerWidth,
  });
}
