import { invoke } from "@tauri-apps/api/core";
import type {
  AlbumSummary,
  AssetVisibility,
  AssetPage,
  AssetSummary,
  MemorySummary,
  TimelineMonths,
  Settings,
  CacheStats,
} from "../types";

export type AuthResponse = {
  accessTokenPreview: string;
  userId: string;
};

export type RestoreSessionResponse = {
  accessTokenPreview: string;
  userId: string;
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
): Promise<AssetPage> {
  return invoke<AssetPage>("get_cached_assets", {
    page,
    pageSize,
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

export async function fetchAssetsByOriginalPath(
  path: string,
): Promise<AssetSummary[]> {
  return invoke<AssetSummary[]>("get_assets_by_original_path", {
    path,
  });
}

export async function fetchAlbumAssets(
  albumId: string,
): Promise<AssetSummary[]> {
  return invoke<AssetSummary[]>("get_album_assets", {
    albumId,
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
