import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCachedAssetDetails } from "../api/tauri";
import { trackFeature } from "../api/media";
import {
  FIX_TIME_EVENT,
  getCachedScopePage,
  notifyAssetsTimeShifted,
  shiftAssetTimes,
} from "../api/time";
import type { FixTimeAsset, FixTimeReferenceSource, FixTimeRequestDetail } from "../types/time";

const REFERENCE_PAGE_SIZE = 60;
const REFRESH_KEYS = [
  "assets",
  "asset-days",
  "timeline-months",
  "album-assets-paged",
  "folder-assets-paged",
  "calendar-assets-paged",
  "map-assets",
];

/** Listens for `immich:fix-time` and exposes the requested asset ids. */
export function useFixTimeRequest() {
  const [assetIds, setAssetIds] = useState<string[] | null>(null);
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<FixTimeRequestDetail>).detail;
      const ids = Array.from(new Set(detail?.assetIds ?? [])).filter(Boolean);
      if (ids.length === 0) return;
      console.info(`[fixTime] dialog requested assets=${ids.length}`);
      setAssetIds(ids);
    };
    window.addEventListener(FIX_TIME_EVENT, onRequest);
    return () => window.removeEventListener(FIX_TIME_EVENT, onRequest);
  }, []);
  const close = useCallback(() => setAssetIds(null), []);
  return { assetIds, close };
}

/** Loads cached capture times of the selected assets (local SQLite only). */
export function useSelectedAssetTimes(assetIds: string[] | null) {
  return useQuery({
    queryKey: ["fix-time-selected", assetIds],
    enabled: !!assetIds && assetIds.length > 0,
    queryFn: async (): Promise<FixTimeAsset[]> => {
      const ids = assetIds ?? [];
      const details = await Promise.all(
        ids.map((id) => getCachedAssetDetails(id).catch(() => null)),
      );
      return ids.map((id, index) => {
        const detail = details[index];
        return {
          id,
          originalFileName: detail?.originalFileName ?? id,
          fileCreatedAt: detail?.fileCreatedAt ?? null,
          type: detail?.type ?? null,
          thumbhash: null,
        };
      });
    },
    staleTime: 0,
  });
}

/** Infinite, cache-only pages of the current view for the reference panel. */
export function useReferenceAssets(source: FixTimeReferenceSource, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: ["fix-time-reference", source.scope, source.criteria ?? null],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getCachedScopePage(source.scope, pageParam, REFERENCE_PAGE_SIZE, source.criteria ?? null),
    getNextPageParam: (lastPage) => (lastPage.hasNextPage ? lastPage.page + 1 : undefined),
  });
  const assets = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const loadingMore = useRef(false);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || loadingMore.current) return;
    loadingMore.current = true;
    void fetchNextPage().finally(() => {
      loadingMore.current = false;
    });
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  return { ...query, assets, loadMore };
}

/** Applies the offset, refreshes cached views and notifies grids. */
export function useApplyTimeShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      assetIds,
      offsetSeconds,
    }: {
      assetIds: string[];
      offsetSeconds: number;
    }) => {
      console.info(
        `[fixTime] apply start assets=${assetIds.length} offsetSeconds=${offsetSeconds}`,
      );
      trackFeature("time-correction");
      const result = await shiftAssetTimes(assetIds, offsetSeconds);
      console.info(
        `[fixTime] apply done updated=${result.updatedCount} queued=${result.queuedCount} failed=${result.failed.length}`,
      );
      return result;
    },
    onSuccess: async (result, { assetIds, offsetSeconds }) => {
      const failed = new Set(result.failed.map((failure) => failure.assetId));
      const changed = assetIds.filter((id) => !failed.has(id));
      if (changed.length === 0) return;
      await Promise.all(
        [...REFRESH_KEYS, "fix-time-selected", "fix-time-reference"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      notifyAssetsTimeShifted({ assetIds: changed, offsetSeconds });
    },
    onError: (error) => console.error("[fixTime] apply failed", error),
  });
}
