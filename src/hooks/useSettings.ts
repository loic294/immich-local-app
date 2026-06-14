import { useQuery, useQueryClient } from "@tanstack/react-query";
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
