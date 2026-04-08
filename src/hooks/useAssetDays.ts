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
    queryFn: () => getCachedAssetDays(searchTerm.trim() || null),
    staleTime: 60_000,
  });
}
