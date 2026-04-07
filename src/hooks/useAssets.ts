import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchAssets } from "../api/tauri";

const PAGE_SIZE = 30;

export function useAssets(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["assets"],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchAssets(pageParam, PAGE_SIZE),
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
