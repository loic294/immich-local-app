import { useQuery } from "@tanstack/react-query";
import { getCachedAssetDays } from "../api/tauri";
import {
  criteriaPayload,
  type AssetFilter,
  type AssetFilterCriteria,
} from "../types";

export function useAssetDays(
  enabled: boolean,
  searchTerm: string,
  refreshToken?: string,
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
) {
  const payload = criteria ? criteriaPayload(criteria) : null;
  return useQuery({
    queryKey: ["asset-days", searchTerm, refreshToken, filter ?? null, payload],
    enabled,
    queryFn: async () => {
      const trimmedSearch = searchTerm.trim() || null;
      const startedAt = performance.now();
      console.log("[useAssetDays] query start", {
        search: trimmedSearch,
        filter: filter ?? null,
      });

      const result = await getCachedAssetDays(
        trimmedSearch,
        filter ?? null,
        payload,
      );
      const durationMs = Math.round(performance.now() - startedAt);

      console.log("[useAssetDays] query done", {
        search: trimmedSearch,
        filter: filter ?? null,
        dayCount: result.length,
        durationMs,
      });

      return result;
    },
    staleTime: 60_000,
  });
}
