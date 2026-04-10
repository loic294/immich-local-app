import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedAlbumAssetsPaged } from "../api/tauri";

const PAGE_SIZE = 40;

export function useAlbumAssets(enabled: boolean, albumId: string) {
  return useInfiniteQuery({
    queryKey: ["album-assets-paged", albumId],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedAlbumAssetsPaged(albumId, pageParam, PAGE_SIZE),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasNextPage) return undefined;
      if (lastPage.items.length < PAGE_SIZE) return undefined;
      return allPages.length;
    },
    staleTime: 60_000,
  });
}
