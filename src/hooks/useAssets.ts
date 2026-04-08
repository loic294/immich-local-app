import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedAssets } from "../api/tauri";

export const ASSET_PAGE_SIZE = 30;

export function useAssets(enabled: boolean, searchTerm: string) {
  return useInfiniteQuery({
    queryKey: ["assets", searchTerm],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedAssets(pageParam, ASSET_PAGE_SIZE, searchTerm.trim() || null),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.hasNextPage) {
        return allPages.length;
      }

      return undefined;
    },
  });
}
