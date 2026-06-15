import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedFolderAssetsPaged } from "../api/tauri";
import {
  criteriaPayload,
  type AssetFilterCriteria,
  type SortPreference,
} from "../types";

const PAGE_SIZE = 40;

export function useFolderAssets(
  enabled: boolean,
  path: string,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
) {
  const payload = criteria ? criteriaPayload(criteria) : null;
  return useInfiniteQuery({
    queryKey: [
      "folder-assets-paged",
      path,
      payload,
      sort?.field ?? null,
      sort?.direction ?? null,
    ],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedFolderAssetsPaged(path, pageParam, PAGE_SIZE, payload, sort),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasNextPage) return undefined;
      return allPages.length;
    },
    staleTime: 30_000,
  });
}
