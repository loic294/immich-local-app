import { invoke } from "@tauri-apps/api/core";
import type { AssetPage } from "../types";

export type AuthResponse = {
  accessTokenPreview: string;
  hasRefreshToken: boolean;
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
): Promise<AssetPage> {
  return invoke<AssetPage>("fetch_assets", {
    page,
    pageSize,
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
