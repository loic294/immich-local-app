import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedFolderAssetsPaged } from "../api/tauri";

const PAGE_SIZE = 40;

export function useFolderAssets(enabled: boolean, path: string) {
  return useInfiniteQuery({
    queryKey: ["folder-assets-paged", path],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedFolderAssetsPaged(path, pageParam, PAGE_SIZE),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasNextPage) return undefined;
      return allPages.length;
    },
    staleTime: 30_000,
  });
}
