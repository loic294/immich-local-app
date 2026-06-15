import { useQuery } from "@tanstack/react-query";
import { getCachedAssetDays } from "../api/tauri";
import {
  criteriaPayload,
  type AssetFilter,
  type AssetFilterCriteria,
  type SortPreference,
} from "../types";

export function useAssetDays(
  enabled: boolean,
  searchTerm: string,
  refreshToken?: string,
  filter?: AssetFilter | null,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
) {
  const payload = criteria ? criteriaPayload(criteria) : null;
  return useQuery({
    queryKey: [
      "asset-days",
      searchTerm,
      refreshToken,
      filter ?? null,
      payload,
      sort?.field ?? null,
      sort?.direction ?? null,
    ],
    enabled,
    queryFn: async () => {
      const trimmedSearch = searchTerm.trim() || null;
      const startedAt = performance.now();
      console.log("[useAssetDays] query start", {
        search: trimmedSearch,
        filter: filter ?? null,
        sort,
      });

      const result = await getCachedAssetDays(
        trimmedSearch,
        filter ?? null,
        payload,
        sort,
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
