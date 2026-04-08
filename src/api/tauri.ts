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

export async function getAssetThumbnail(assetId: string): Promise<string> {
  return invoke<string>("get_asset_thumbnail", {
    assetId,
  });
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

export async function fetchMemories(): Promise<MemorySummary[]> {
  return invoke<MemorySummary[]>("fetch_memories");
}

export async function fetchTimelineMonths(): Promise<TimelineMonths> {
  return invoke<TimelineMonths>("get_timeline_months");
}

export async function fetchAlbums(): Promise<AlbumSummary[]> {
  return invoke<AlbumSummary[]>("fetch_albums");
}

export async function fetchUniqueOriginalPaths(): Promise<string[]> {
  return invoke<string[]>("get_unique_original_paths");
}

export async function fetchAlbumAssetsPaged(
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

export async function fetchFolderAssetsPaged(
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

export async function fetchCalendarAssetsPaged(
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
