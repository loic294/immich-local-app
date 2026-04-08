import { useQuery } from "@tanstack/react-query";
import { getCachedAssetDays } from "../api/tauri";

export function useAssetDays(
  enabled: boolean,
  searchTerm: string,
  refreshToken?: string,
) {
  return useQuery({
    queryKey: ["asset-days", searchTerm, refreshToken],
    enabled,
    queryFn: async () => {
      const trimmedSearch = searchTerm.trim() || null;
      const startedAt = performance.now();
      console.log("[useAssetDays] query start", {
        search: trimmedSearch,
      });

      const result = await getCachedAssetDays(trimmedSearch);
      const durationMs = Math.round(performance.now() - startedAt);

      console.log("[useAssetDays] query done", {
        search: trimmedSearch,
        dayCount: result.length,
        durationMs,
      });

      return result;
    },
    staleTime: 60_000,
  });
}
