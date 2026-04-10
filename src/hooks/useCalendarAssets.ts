import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedCalendarAssetsPaged } from "../api/tauri";

const PAGE_SIZE = 40;

export function useCalendarAssets(
  enabled: boolean,
  year: number,
  month: number,
) {
  return useInfiniteQuery({
    queryKey: ["calendar-assets-paged", year, month],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedCalendarAssetsPaged(year, month, pageParam, PAGE_SIZE),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasNextPage) return undefined;
      if (lastPage.items.length < PAGE_SIZE) return undefined;
      return allPages.length;
    },
    staleTime: 60_000,
  });
}
