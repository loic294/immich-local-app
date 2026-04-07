import { invoke } from "@tauri-apps/api/core";
import type {
  AlbumSummary,
  AssetPage,
  AssetSummary,
  MemorySummary,
  TimelineMonths,
} from "../types";

export type AuthResponse = {
  accessTokenPreview: string;
  userId: string;
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
