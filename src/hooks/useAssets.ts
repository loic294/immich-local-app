import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchAssets } from "../api/tauri";

const PAGE_SIZE = 30;

export function useAssets(enabled: boolean, searchTerm: string) {
  return useInfiniteQuery({
    queryKey: ["assets", searchTerm],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchAssets(pageParam, PAGE_SIZE, searchTerm.trim() || null),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.hasNextPage) {
        return allPages.length;
      }

      if (lastPage.items.length < PAGE_SIZE) {
        return undefined;
      }
      return allPages.length;
    },
  });
}
