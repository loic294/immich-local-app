import { invoke } from "@tauri-apps/api/core";
import type { FeaturePreferences, StorageSummary, VideoQualityOptions } from "../types/storage";

export const getFeaturePreferences = () => invoke<FeaturePreferences>("get_feature_preferences");
export const updateFeaturePreferences = (preferences: FeaturePreferences) =>
  invoke<FeaturePreferences>("update_feature_preferences", { preferences });
export const getStorageSummary = () => invoke<StorageSummary>("get_storage_summary");
export const clearDisposableCache = () => invoke<number>("clear_disposable_cache");
export const getVideoQualityOptions = () =>
  invoke<VideoQualityOptions>("get_video_quality_options");
