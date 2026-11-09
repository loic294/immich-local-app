import { invoke } from "./invoke";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { deleteAsset } from "./deletion";
import { ThumbnailQueue, type ThumbnailRequestOptions } from "./thumbnailQueue";
import type { AlbumStatistics } from "../types/albumStatistics";
import type {
  AlbumSummary,
  AlbumShareUser,
  AlbumUserCandidate,
  AlbumUserRole,
  AssetVisibility,
  AssetPage,
  AssetDateJumpTarget,
  AssetSummary,
  GridLayoutAssetInput,
  GridLayoutResponse,
  TimelineLayoutResponse,
  MemorySummary,
  SavedLocalFileChange,
  TimelineMonths,
  Settings,
  CacheStats,
  AssetCacheDetails,
  ApplySavedLocalFileChangesResult,
  LocalCopyResult,
  AssetFilter,
  AssetFilterCriteria,
  ViewScope,
  PersonSummary,
  SortPreference,
} from "../types";

export function removeLocalOriginal(assetId: string, allowUnverified = false) {
  return invoke<{ confirmationRequired: boolean; removedCount: number }>("remove_local_original", {
    assetId,
    allowUnverified,
  });
}

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
  /** True when the session was restored from cache because the server was
   *  unreachable. The app should enter offline mode. */
  offline: boolean;
};

export type OAuthUrlResponse = {
  authorizationUrl: string;
};

/** A locally-registered Immich account. The auth token is never sent to the
 *  frontend (it is stripped server-side). */
export type Account = {
  id: string;
  serverUrl: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  authType: "api_key" | "oauth" | "password";
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
};

// Thumbnail cache: account + asset ID -> data URL
const thumbnailCache = new Map<string, string>();
const thumbnailQueue = new ThumbnailQueue(6);

// Cache statistics
let thumbnailCacheHits = 0;
let thumbnailCacheMisses = 0;
let thumbnailDeduplicationHits = 0;

function thumbnailKey(assetId: string, accountId?: string | null): string {
  return JSON.stringify([accountId ?? null, assetId]);
}

export function isThumbnailCached(assetId: string, accountId?: string | null): string | null {
  return thumbnailCache.get(thumbnailKey(assetId, accountId)) ?? null;
}

export async function getOAuthAuthorizationUrl(
  serverUrl: string,
  redirectUri?: string,
): Promise<OAuthUrlResponse> {
  return invoke<OAuthUrlResponse>("get_oauth_authorization_url", {
    serverUrl,
    redirectUri,
  });
}

export async function completeOAuthFlow(
  serverUrl: string,
  callbackUrl: string,
): Promise<AuthResponse> {
  return invoke<AuthResponse>("complete_oauth_flow", {
    serverUrl,
    callbackUrl,
  });
}

export async function authenticate(serverUrl: string, apiKey: string): Promise<AuthResponse> {
  return invoke<AuthResponse>("authenticate", {
    serverUrl,
    apiKey,
  });
}

export async function authenticateWithPassword(
  serverUrl: string,
  email: string,
  password: string,
): Promise<AuthResponse> {
  return invoke<AuthResponse>("authenticate_with_password", {
    serverUrl,
    email,
    password,
  });
}

export async function restoreSession(): Promise<RestoreSessionResponse | null> {
  return invoke<RestoreSessionResponse | null>("restore_session");
}

/** Probe whether the configured Immich server is currently reachable. */
export async function checkServerConnection(): Promise<boolean> {
  return invoke<boolean>("check_server_connection");
}

/** Replay queued offline mutations; resolves with the number still pending. */
export async function flushPendingMutations(): Promise<number> {
  return invoke<number>("flush_pending_mutations");
}

/** Number of asset mutations queued locally while offline. */
export async function getPendingMutationCount(): Promise<number> {
  return invoke<number>("get_pending_mutation_count");
}

export async function logoutFromServer(): Promise<void> {
  return invoke<void>("logout");
}

// ---------------------------------------------------------------------------
// Multi-account management
// ---------------------------------------------------------------------------

/** List every locally-registered account (primary first). */
export async function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("list_accounts");
}

/** Change which account is primary. */
export async function setPrimaryAccount(accountId: string): Promise<void> {
  return invoke<void>("set_primary_account", { accountId });
}

/** Remove an account. Resolves with the id of the new primary if it changed. */
export async function removeAccount(accountId: string): Promise<string | null> {
  return invoke<string | null>("remove_account", { accountId });
}

/** Add a secondary account using an API key. */
export async function addAccountWithKey(serverUrl: string, apiKey: string): Promise<Account> {
  return invoke<Account>("add_account_with_key", { serverUrl, apiKey });
}

/** Add a secondary account using email + password. */
export async function addAccountWithPassword(
  serverUrl: string,
  email: string,
  password: string,
): Promise<Account> {
  return invoke<Account>("add_account_with_password", {
    serverUrl,
    email,
    password,
  });
}

/** Begin an add-account OAuth flow; returns the authorization URL to open. */
export async function addAccountOAuthUrl(
  serverUrl: string,
  redirectUri?: string,
): Promise<OAuthUrlResponse> {
  return invoke<OAuthUrlResponse>("add_account_oauth_url", {
    serverUrl,
    redirectUri,
  });
}

/** Complete an add-account OAuth flow started by addAccountOAuthUrl. */
export async function addAccountCompleteOAuth(
  serverUrl: string,
  callbackUrl: string,
): Promise<Account> {
  return invoke<Account>("add_account_complete_oauth", {
    serverUrl,
    callbackUrl,
  });
}

export async function clearWebviewBrowsingData(): Promise<void> {
  await getCurrentWebview().clearAllBrowsingData();
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
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_cached_assets", {
    page,
    pageSize,
    search,
    filter,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getAllCachedAssets(
  search: string | null,
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<AssetSummary[]> {
  return invoke<AssetSummary[]>("get_all_cached_assets", {
    search,
    filter,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getCachedAssetDays(
  search: string | null,
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<string[]> {
  return invoke<string[]>("get_cached_asset_days", {
    search,
    filter,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getCachedAssetJumpTarget(
  dateKey: string,
  pageSize: number,
  search: string | null,
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
): Promise<AssetDateJumpTarget | null> {
  return invoke<AssetDateJumpTarget | null>("get_cached_asset_jump_target", {
    dateKey,
    pageSize,
    search,
    filter,
    criteria: criteria ?? null,
  });
}

export async function getCachedTimelineLayout(
  search: string | null,
  containerWidth: number,
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<TimelineLayoutResponse> {
  return invoke<TimelineLayoutResponse>("get_cached_timeline_layout", {
    search,
    containerWidth,
    filter,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getFullGridLayout(
  search: string | null,
  containerWidth: number,
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("get_cached_full_grid_layout", {
    search,
    containerWidth,
    filter,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getCachedAlbumFullGridLayout(
  albumId: string,
  containerWidth: number,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("get_cached_album_full_grid_layout", {
    albumId,
    containerWidth,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getCachedCalendarFullGridLayout(
  year: number,
  month: number,
  containerWidth: number,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("get_cached_calendar_full_grid_layout", {
    year,
    month,
    containerWidth,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getCachedFolderFullGridLayout(
  path: string,
  containerWidth: number,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
  recursive?: boolean | null,
): Promise<GridLayoutResponse> {
  return invoke<GridLayoutResponse>("get_cached_folder_full_grid_layout", {
    path,
    containerWidth,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
    recursive: recursive ?? null,
  });
}

export async function getAssetThumbnail(
  assetId: string,
  accountId?: string | null,
  options: ThumbnailRequestOptions = {},
): Promise<string> {
  if (options.signal?.aborted) throw options.signal.reason;
  const key = thumbnailKey(assetId, accountId);
  // Check cache first
  const cached = thumbnailCache.get(key);
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
  if (thumbnailQueue.has(key)) {
    thumbnailDeduplicationHits++;
  } else {
    thumbnailCacheMisses++;
  }

  return thumbnailQueue.request(
    key,
    async () => {
      const result = await invoke<string>("get_asset_thumbnail", {
        assetId,
        accountId: accountId ?? null,
      });
      thumbnailCache.set(key, result);
      return result;
    },
    options,
  );
}

export async function getAssetPlayback(assetId: string): Promise<string> {
  return invoke<string>("get_asset_playback", {
    assetId,
  });
}

export async function isVideoDownloadComplete(assetId: string): Promise<boolean> {
  return invoke<boolean>("is_video_download_complete", {
    assetId,
  });
}

export async function refreshAsset(assetId: string): Promise<AssetSummary> {
  return invoke<AssetSummary>("refresh_asset", {
    assetId,
  });
}

export async function getCachedAssetDetails(assetId: string): Promise<AssetCacheDetails | null> {
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
  const hitRate = total > 0 ? ((thumbnailCacheHits / total) * 100).toFixed(1) : "N/A";
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
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_album_assets_paged", {
    albumId,
    page,
    pageSize,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

export async function getCachedFolderAssetsPaged(
  path: string,
  page: number,
  pageSize: number,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
  recursive?: boolean | null,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_folder_assets_paged", {
    path,
    page,
    pageSize,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
    recursive: recursive ?? null,
  });
}

export async function getCachedCalendarAssetsPaged(
  year: number,
  month: number,
  page: number,
  pageSize: number,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
): Promise<AssetPage> {
  return invoke<AssetPage>("get_calendar_assets_paged", {
    year,
    month,
    page,
    pageSize,
    criteria: criteria ?? null,
    sortField: sort?.field ?? null,
    sortDirection: sort?.direction ?? null,
  });
}

/** Distinct camera names present in the assets of the given view scope. */
export async function getCamerasInScope(scope: ViewScope): Promise<string[]> {
  return invoke<string[]>("get_cameras_in_scope", { scope });
}

/** People that appear in the assets of the given view scope. */
export async function getPeopleInScope(scope: ViewScope): Promise<PersonSummary[]> {
  return invoke<PersonSummary[]>("get_people_in_scope", { scope });
}

// Only scoped callers use the in-memory face cache.
const personThumbnailCache = new Map<string, string>();
const personThumbnailRequests = new Map<string, Promise<string>>();

/** Data URL for a person's face thumbnail (deduped + memoized in-memory). */
export async function getPersonThumbnail(personId: string, accountScope?: string): Promise<string> {
  if (!accountScope) return invoke<string>("get_person_thumbnail", { personId });
  const cacheKey = JSON.stringify([accountScope, personId]);
  const cached = personThumbnailCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = personThumbnailRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = invoke<string>("get_person_thumbnail", { personId });
  personThumbnailRequests.set(cacheKey, promise);

  try {
    const result = await promise;
    personThumbnailCache.set(cacheKey, result);
    return result;
  } finally {
    personThumbnailRequests.delete(cacheKey);
  }
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

export async function getRecentAlbums(limit = 5): Promise<AlbumSummary[]> {
  return invoke<AlbumSummary[]>("get_recent_albums", { limit });
}

export async function recordRecentAlbum(albumId: string): Promise<void> {
  await invoke<void>("record_recent_album", { albumId });
  window.dispatchEvent(new Event("recent-albums-changed"));
}

export async function getFoldersBaseDirectory(accountId: string): Promise<string> {
  return invoke<string>("get_folders_base_directory", { accountId });
}

export async function setFoldersBaseDirectory(
  accountId: string,
  baseDirectory: string,
): Promise<string> {
  const result = await invoke<string>("set_folders_base_directory", { accountId, baseDirectory });
  window.dispatchEvent(
    new CustomEvent("folders-base-directory-changed", { detail: { accountId } }),
  );
  return result;
}

export async function fetchAlbums(): Promise<AlbumSummary[]> {
  return getCachedAlbums();
}

export async function createAlbumWithAssets(
  albumName: string,
  assetIds: string[],
): Promise<AlbumSummary> {
  const album = await invoke<AlbumSummary>("create_album_with_assets", {
    albumName,
    assetIds,
  });
  window.dispatchEvent(new Event("recent-albums-changed"));
  return album;
}

export async function addAssetsToAlbum(albumId: string, assetIds: string[]): Promise<void> {
  await invoke<void>("add_assets_to_album", {
    albumId,
    assetIds,
  });
  window.dispatchEvent(new Event("recent-albums-changed"));
}

export async function createShareLinkForAssets(assetIds: string[]): Promise<string> {
  return invoke<string>("create_share_link_for_assets", {
    assetIds,
  });
}

export async function canManageAlbumSharing(albumId: string): Promise<boolean> {
  return invoke<boolean>("can_manage_album_sharing", {
    albumId,
  });
}

export async function getOrCreateAlbumShareLink(albumId: string): Promise<string> {
  return invoke<string>("get_or_create_album_share_link", {
    albumId,
  });
}

export async function getAlbumShareLink(albumId: string): Promise<string | null> {
  return invoke<string | null>("get_album_share_link", {
    albumId,
  });
}

export async function getAlbumShareUsers(albumId: string): Promise<AlbumShareUser[]> {
  return invoke<AlbumShareUser[]>("get_album_share_users", {
    albumId,
  });
}

export async function getShareableUsers(accountId?: string): Promise<AlbumUserCandidate[]> {
  return invoke<AlbumUserCandidate[]>("get_shareable_users", { accountId });
}

export async function getAlbumShareableUsers(albumId: string): Promise<AlbumUserCandidate[]> {
  return invoke<AlbumUserCandidate[]>("get_album_shareable_users", { albumId });
}

export async function addUserToAlbum(albumId: string, userId: string, role: string): Promise<void> {
  return invoke<void>("add_user_to_album", {
    albumId,
    userId,
    role,
  });
}

export async function updateAlbumUserRole(
  albumId: string,
  userId: string,
  role: AlbumUserRole,
): Promise<void> {
  return invoke<void>("update_album_user_role", {
    albumId,
    userId,
    role,
  });
}

export async function removeUserFromAlbum(albumId: string, userId: string): Promise<void> {
  return invoke<void>("remove_user_from_album", {
    albumId,
    userId,
  });
}

export async function saveAlbumLocally(albumId: string): Promise<{ folderPath: string }> {
  const folderPath = await invoke<string>("save_album_locally", {
    albumId,
  });
  return { folderPath };
}

export async function getAlbumLocalStatus(albumId: string): Promise<{
  totalCount: number;
  localCount: number;
  missingCount: number;
}> {
  return invoke("get_album_local_status", { albumId });
}

/** Album coverage of the cached library; reads SQLite only, works offline. */
export async function getAlbumStatistics(): Promise<AlbumStatistics> {
  return invoke<AlbumStatistics>("get_album_statistics");
}

export async function deleteLocalAlbum(albumId: string): Promise<void> {
  return invoke<void>("delete_local_album", { albumId });
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
  // All normal archive/Delete actions honor the persisted app-wide preference.
  if (visibility === "archive") {
    return deleteAsset(assetId);
  }
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

export async function copyAssetsToClipboard(assetIds: string[]): Promise<void> {
  return invoke<void>("copy_assets_to_clipboard", { assetIds });
}

export async function openFolderInFileExplorer(path: string): Promise<void> {
  return invoke<void>("open_folder_in_file_explorer", { path });
}

export async function copyAssetsToLocalFolder(
  assetIds: string[],
  destinationFolder: string,
  allowCachedFallback: boolean,
  preferAlbumFolder = false,
): Promise<LocalCopyResult> {
  return invoke<LocalCopyResult>("copy_assets_to_local_folder", {
    assetIds,
    destinationFolder,
    allowCachedFallback,
    preferAlbumFolder,
  });
}

export async function copyTextToClipboard(text: string): Promise<void> {
  return invoke<void>("copy_text_to_clipboard", { text });
}

export async function fetchAssetsByMonth(year: number, month: number): Promise<AssetPage> {
  return invoke<AssetPage>("fetch_assets_by_month", { year, month });
}

/**
 * Lazily refresh a single album's assets from the server (local-first). The UI
 * renders from the local cache first; this updates that cache in the background
 * when the user opens an album. Rejects with an `offline:`-prefixed marker when
 * the server is unreachable.
 */
export async function refreshAlbumAssets(albumId: string): Promise<void> {
  return invoke<void>("refresh_album_assets", { albumId });
}

/**
 * Lazily refresh a single folder's assets from the server (local-first). Used by
 * folder-backed views such as Phone Photos. Rejects with an `offline:`-prefixed
 * marker when the server is unreachable.
 */
export async function refreshFolderAssets(path: string): Promise<number> {
  return invoke<number>("refresh_folder_assets", { path });
}

/**
 * Refresh the cached album list metadata (local-first). Albums the server no
 * longer returns are pruned from the cache, so recent-album lists are refreshed.
 */
export async function refreshAlbumList(): Promise<number> {
  const count = await invoke<number>("refresh_album_list");
  window.dispatchEvent(new Event("recent-albums-changed"));
  return count;
}

export async function scanSavedLocalFiles(): Promise<number> {
  return invoke<number>("scan_saved_local_files");
}

export async function getSavedLocalFileChanges(): Promise<SavedLocalFileChange[]> {
  return invoke<SavedLocalFileChange[]>("get_saved_local_file_changes");
}

export async function applySavedLocalFileChanges(
  changeIds: number[],
): Promise<ApplySavedLocalFileChangesResult> {
  return invoke<ApplySavedLocalFileChangesResult>("apply_saved_local_file_changes", {
    input: { changeIds },
  });
}

/**
 * Dismiss (skip) tracked local file changes without applying them. Updates the
 * tracked snapshot / stops tracking removed paths so the same changes are not
 * re-detected on the next scan.
 */
export async function dismissSavedLocalFileChanges(changeIds: number[]): Promise<number> {
  return invoke<number>("dismiss_saved_local_file_changes", {
    input: { changeIds },
  });
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
