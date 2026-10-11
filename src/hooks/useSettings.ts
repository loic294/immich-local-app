import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clearDisposableCache,
  getFeaturePreferences,
  getStorageSummary,
  getVideoQualityOptions,
  updateFeaturePreferences,
} from "../api/storage";
import { getSettings } from "../api/tauri";
import type { Settings } from "../types";

export const SETTINGS_QUERY_KEY = ["settings"] as const;

/**
 * Shared, cached access to the persisted app settings. Used by the sidebar to
 * know which navigation items to show and by the settings page to read/update
 * preferences. Call `invalidateSettings` (via useInvalidateSettings) after a
 * mutation so all consumers refresh.
 */
export function useSettings() {
  return useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: getSettings,
    staleTime: 60_000,
  });
}

/** Returns a function that refreshes every cached settings consumer. */
export function useInvalidateSettings() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
}

export function useStorageSettings() {
  const client = useQueryClient();
  const preferences = useQuery({
    queryKey: ["storage-preferences"],
    queryFn: getFeaturePreferences,
  });
  const storage = useQuery({
    queryKey: ["storage-summary"],
    queryFn: getStorageSummary,
    staleTime: 0,
  });
  const videoOptions = useQuery({
    queryKey: ["video-quality-options"],
    queryFn: getVideoQualityOptions,
    retry: false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["storage-summary"] });
  const save = useMutation({
    mutationFn: updateFeaturePreferences,
    onSuccess: async (value) => {
      client.setQueryData(["storage-preferences"], value);
    },
    // A cleanup failure happens after the limit is saved, so always re-read both.
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ["storage-preferences"] });
      await refresh();
    },
  });
  const clear = useMutation({ mutationFn: clearDisposableCache, onSettled: refresh });
  return { preferences, storage, videoOptions, save, clear };
}
