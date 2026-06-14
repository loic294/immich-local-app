import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedAlbumAssetsPaged } from "../api/tauri";
import { criteriaPayload, type AssetFilterCriteria } from "../types";

const PAGE_SIZE = 40;

export function useAlbumAssets(
  enabled: boolean,
  albumId: string,
  criteria?: AssetFilterCriteria | null,
) {
  const payload = criteria ? criteriaPayload(criteria) : null;
  return useInfiniteQuery({
    queryKey: ["album-assets-paged", albumId, payload],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedAlbumAssetsPaged(albumId, pageParam, PAGE_SIZE, payload),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasNextPage) return undefined;
      if (lastPage.items.length < PAGE_SIZE) return undefined;
      return allPages.length;
    },
    staleTime: 60_000,
  });
}
