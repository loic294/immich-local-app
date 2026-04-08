import { useCallback, useEffect, useMemo, useState } from "react";
import { getCachedAssets } from "../api/tauri";
import type { AssetSummary } from "../types";

export const ASSET_PAGE_SIZE = 30;

type AssetPageWindow = {
  page: number;
  items: AssetSummary[];
  hasNextPage: boolean;
};

type UseAssetWindowReturn = {
  assets: AssetSummary[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  isFetchingNextPage: boolean;
  isFetchingPreviousPage: boolean;
  isInitialLoading: boolean;
  error: Error | null;
  loadNextPage: () => Promise<void>;
  loadPreviousPage: () => Promise<void>;
  jumpToPage: (page: number) => Promise<void>;
};

export function useAssetWindow(
  enabled: boolean,
  searchTerm: string,
  refreshToken?: string,
): UseAssetWindowReturn {
  const [pages, setPages] = useState<Record<number, AssetPageWindow>>({});
  const [orderedPages, setOrderedPages] = useState<number[]>([]);
  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);
  const [isFetchingPreviousPage, setIsFetchingPreviousPage] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadPage = useCallback(
    async (page: number): Promise<AssetPageWindow> => {
      const result = await getCachedAssets(
        page,
        ASSET_PAGE_SIZE,
        searchTerm.trim() || null,
      );

      return {
        page,
        items: result.items,
        hasNextPage: result.hasNextPage,
      };
    },
    [searchTerm],
  );

  const replaceWithPage = useCallback(
    async (page: number) => {
      console.log("[useAssetWindow] replaceWithPage start", { page });
      setIsInitialLoading(true);
      setError(null);

      try {
        const currentPage = await loadPage(page);
        console.log("[useAssetWindow] replaceWithPage loaded", {
          page,
          itemCount: currentPage.items.length,
          hasNextPage: currentPage.hasNextPage,
        });
        setPages({ [page]: currentPage });
        setOrderedPages([page]);
      } catch (err) {
        setPages({});
        setOrderedPages([]);
        setError(
          err instanceof Error ? err : new Error("Failed to load assets"),
        );
      } finally {
        console.log("[useAssetWindow] replaceWithPage done, isInitialLoading -> false");
        setIsInitialLoading(false);
      }
    },
    [loadPage],
  );

  useEffect(() => {
    if (!enabled) {
      setPages({});
      setOrderedPages([]);
      setError(null);
      return;
    }

    void replaceWithPage(0);
  }, [enabled, replaceWithPage, refreshToken]);

  const loadNextPage = useCallback(async () => {
    if (isFetchingNextPage || orderedPages.length === 0) {
      console.log("[useAssetWindow] loadNextPage: skipped", {
        isFetchingNextPage,
        orderedPagesLength: orderedPages.length,
      });
      return;
    }

    const lastPageNumber = Math.max(...orderedPages);
    const lastPage = pages[lastPageNumber];
    if (!lastPage?.hasNextPage) {
      console.log("[useAssetWindow] loadNextPage: no more pages", {
        lastPageNumber,
        hasNextPage: lastPage?.hasNextPage,
      });
      return;
    }

    console.log("[useAssetWindow] loadNextPage: loading", {
      nextPage: lastPageNumber + 1,
    });
    setIsFetchingNextPage(true);
    setError(null);

    try {
      const nextPageNumber = lastPageNumber + 1;
      const nextPage = await loadPage(nextPageNumber);
      setPages((current) => ({
        ...current,
        [nextPageNumber]: nextPage,
      }));
      setOrderedPages((current) =>
        current.includes(nextPageNumber)
          ? current
          : [...current, nextPageNumber].sort((left, right) => left - right),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error("Failed to load next page"),
      );
    } finally {
      setIsFetchingNextPage(false);
    }
  }, [isFetchingNextPage, loadPage, orderedPages, pages]);

  const loadPreviousPage = useCallback(async () => {
    if (isFetchingPreviousPage || orderedPages.length === 0) {
      return;
    }

    const firstPageNumber = Math.min(...orderedPages);
    if (firstPageNumber <= 0) {
      return;
    }

    setIsFetchingPreviousPage(true);
    setError(null);

    try {
      const previousPageNumber = firstPageNumber - 1;
      const previousPage = await loadPage(previousPageNumber);
      setPages((current) => ({
        ...current,
        [previousPageNumber]: previousPage,
      }));
      setOrderedPages((current) =>
        current.includes(previousPageNumber)
          ? current
          : [previousPageNumber, ...current].sort(
              (left, right) => left - right,
            ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error("Failed to load previous page"),
      );
    } finally {
      setIsFetchingPreviousPage(false);
    }
  }, [isFetchingPreviousPage, loadPage, orderedPages]);

  const jumpToPage = useCallback(
    async (page: number) => {
      await replaceWithPage(page);
    },
    [replaceWithPage],
  );

  const assets = useMemo(
    () =>
      [...orderedPages]
        .sort((left, right) => left - right)
        .flatMap((pageNumber) => pages[pageNumber]?.items ?? []),
    [orderedPages, pages],
  );

  const hasPreviousPage =
    orderedPages.length > 0 && Math.min(...orderedPages) > 0;
  const hasNextPage =
    orderedPages.length > 0
      ? (pages[Math.max(...orderedPages)]?.hasNextPage ?? false)
      : false;

  return {
    assets,
    hasNextPage,
    hasPreviousPage,
    isFetchingNextPage,
    isFetchingPreviousPage,
    isInitialLoading,
    error,
    loadNextPage,
    loadPreviousPage,
    jumpToPage,
  };
}
