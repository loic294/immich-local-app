import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedFolderAssetsPaged } from "../api/tauri";
import { criteriaPayload, type AssetFilterCriteria } from "../types";

const PAGE_SIZE = 40;

export function useFolderAssets(
  enabled: boolean,
  path: string,
  criteria?: AssetFilterCriteria | null,
) {
  const payload = criteria ? criteriaPayload(criteria) : null;
  return useInfiniteQuery({
    queryKey: ["folder-assets-paged", path, payload],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedFolderAssetsPaged(path, pageParam, PAGE_SIZE, payload),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasNextPage) return undefined;
      return allPages.length;
    },
    staleTime: 30_000,
  });
}
