import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedAssets } from "../api/tauri";
import type { SortPreference } from "../types";

export const ASSET_PAGE_SIZE = 30;

export function useAssets(
  enabled: boolean,
  searchTerm: string,
  sort?: SortPreference | null,
) {
  return useInfiniteQuery({
    queryKey: [
      "assets",
      searchTerm,
      sort?.field ?? null,
      sort?.direction ?? null,
    ],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedAssets(
        pageParam,
        ASSET_PAGE_SIZE,
        searchTerm.trim() || null,
        null,
        null,
        sort,
      ),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.hasNextPage) {
        return allPages.length;
      }

      return undefined;
    },
  });
}
