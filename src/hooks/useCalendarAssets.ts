import { useInfiniteQuery } from "@tanstack/react-query";
import { getCachedCalendarAssetsPaged } from "../api/tauri";
import {
  criteriaPayload,
  type AssetFilterCriteria,
  type SortPreference,
} from "../types";

const PAGE_SIZE = 40;

export function useCalendarAssets(
  enabled: boolean,
  year: number,
  month: number,
  criteria?: AssetFilterCriteria | null,
  sort?: SortPreference | null,
) {
  const payload = criteria ? criteriaPayload(criteria) : null;
  return useInfiniteQuery({
    queryKey: [
      "calendar-assets-paged",
      year,
      month,
      payload,
      sort?.field ?? null,
      sort?.direction ?? null,
    ],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedCalendarAssetsPaged(
        year,
        month,
        pageParam,
        PAGE_SIZE,
        payload,
        sort,
      ),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasNextPage) return undefined;
      if (lastPage.items.length < PAGE_SIZE) return undefined;
      return allPages.length;
    },
    staleTime: 60_000,
  });
}
