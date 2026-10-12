import { invoke } from "@tauri-apps/api/core";
import type {
  FeaturePreferences,
  StorageSummary,
  VideoQualityOptions,
  LocalStorageGroup,
  LocalStorageRemovalPreview,
} from "../types/storage";

export const getFeaturePreferences = () => invoke<FeaturePreferences>("get_feature_preferences");
export const updateFeaturePreferences = (preferences: FeaturePreferences) =>
  invoke<FeaturePreferences>("update_feature_preferences", { preferences });
export const getStorageSummary = () => invoke<StorageSummary>("get_storage_summary");
export const clearDisposableCache = () => invoke<number>("clear_disposable_cache");
export const getVideoQualityOptions = () =>
  invoke<VideoQualityOptions>("get_video_quality_options");
export const getLocalStorageGroups = () => invoke<LocalStorageGroup[]>("get_local_storage_groups");
export const prepareLocalStorageRemoval = (albumId: string | null) =>
  invoke<LocalStorageRemovalPreview>("prepare_local_storage_removal", { albumId });
export const removeLocalStorageGroup = (preview: LocalStorageRemovalPreview) =>
  invoke<number>("remove_local_storage_group", {
    token: preview.token,
    allowUnverified: preview.unverifiedCount > 0,
  });
