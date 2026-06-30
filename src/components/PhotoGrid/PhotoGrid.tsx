import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import { AssetThumbnail } from "./AssetThumbnail";
import { DatePickerModal } from "./DatePickerModal";
import { PhotoGridFullscreenOverlay } from "./PhotoGridFullscreenOverlay";
import { VerticalTimeline } from "./VerticalTimeline";
import type {
  AssetCacheDetails,
  GridLayoutSection,
  AssetSummary,
  AssetVisibility,
  Settings,
  TimelineLayoutDay,
  TimelineLayoutResponse,
} from "../../types";
import {
  calculateGridLayout,
  copyAssetsToLocalFolder,
  getAssetPlayback,
  getCachedAssetDetails,
  getAssetThumbnail,
  getSettings,
  refreshAsset,
  updateAssetDescription,
  updateAssetFavorite,
  updateAssetRating,
  updateAssetVisibility,
} from "../../api/tauri";
import { useI18n } from "../../i18n";
import type {
  JumpMetrics,
  PhotoGridProps,
  ScrollRestoreAnchor,
  VirtualEntry,
} from "./PhotoGrid.types";
import {
  getAssetAspectRatio,
  isVideoAsset,
  preloadImage,
  thumbhashToDataUrl,
  toPlayableSrc,
} from "./photoGridUtils";
import { usePhotoGridSelection } from "./usePhotoGridSelection";
import { usePhotoGridVirtualLayout } from "./usePhotoGridVirtualLayout";

export function PhotoGrid({
  assets,
  hideArchivedAssets = true,
  isFetching,
  isFetchingPrevious = false,
  hasNextPage,
  hasPreviousPage = false,
  onLoadMore,
  onLoadPrevious,
  availableDates: availableDatesProp,
  onJumpToDate,
  loadFullLayout,
  loadTimelineLayout,
  maxHeight = 0,
  onSelectedCountChange,
  onSelectedIdsChange,
  selectionCommand,
}: PhotoGridProps) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [activeSrc, setActiveSrc] = useState<string | null>(null);
  const [activeStillSrc, setActiveStillSrc] = useState<string | null>(null);
  const [activeFullsizeStillSrc, setActiveFullsizeStillSrc] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [gridSections, setGridSections] = useState<GridLayoutSection[]>([]);
  const [videoDurations, setVideoDurations] = useState<Record<string, number>>({});
  const [showVideoDebug, setShowVideoDebug] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [assetOverrides, setAssetOverrides] = useState<Record<string, Partial<AssetSummary>>>({});
  const [isPlayingLivePhoto, setIsPlayingLivePhoto] = useState(false);
  const [shouldAutoplayLivePhoto, setShouldAutoplayLivePhoto] = useState(false);
  const [favoriteUpdateId, setFavoriteUpdateId] = useState<string | null>(null);
  const [archiveUpdateId, setArchiveUpdateId] = useState<string | null>(null);
  const [ratingUpdateId, setRatingUpdateId] = useState<string | null>(null);
  const pendingFullscreenAdvanceRef = useRef(false);
  const [descriptionUpdateId, setDescriptionUpdateId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [imageContainerWidth, setImageContainerWidth] = useState(0);
  const [imageContainerHeight, setImageContainerHeight] = useState(0);
  const [isTimelineScrubbing, setIsTimelineScrubbing] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showInfoPanel, setShowInfoPanel] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem("immichFullscreenInfoPanel") === "1";
  });
  const [cachedAssetDetails, setCachedAssetDetails] = useState<AssetCacheDetails | null>(null);
  const [isLoadingCachedDetails, setIsLoadingCachedDetails] = useState(false);
  const [pendingJumpDateKey, setPendingJumpDateKey] = useState<string | null>(null);
  const sectionTopMapRef = useRef<Map<string, number>>(new Map());
  const isLoadingNextRef = useRef(false);
  const isLoadingPreviousRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);
  const latestVirtualEntriesRef = useRef<VirtualEntry[]>([]);
  const latestRenderScrollTopRef = useRef(0);
  const pendingScrollRestoreRef = useRef<ScrollRestoreAnchor | null>(null);
  const pendingRestoreAttemptsRef = useRef(0);
  const jumpMetricsRef = useRef<JumpMetrics | null>(null);
  const fullsizeStillLoadingAssetIdRef = useRef<string | null>(null);
  const [layoutReadyAssetCount, setLayoutReadyAssetCount] = useState(0);
  const [fullGridSections, setFullGridSections] = useState<GridLayoutSection[]>([]);
  const isUsingFullLayout = fullGridSections.length > 0;
  const [timelineLayout, setTimelineLayout] = useState<TimelineLayoutResponse | null>(null);

  const requestFullscreenLoadMore = () => {
    if (pendingJumpDateKey) {
      return;
    }

    if (!hasNextPage || isFetching || isLoadingNextRef.current) {
      return;
    }

    isLoadingNextRef.current = true;
    void Promise.resolve(onLoadMore()).finally(() => {
      isLoadingNextRef.current = false;
    });
  };

  const captureScrollRestoreAnchor = (
    direction: "prepend" | "append",
  ): ScrollRestoreAnchor | null => {
    // With full layout, row positions are stable — no restoration needed
    if (isUsingFullLayout) return null;
    const currentEntries = latestVirtualEntriesRef.current;
    const currentScrollTop = latestRenderScrollTopRef.current;
    const firstVisibleRow = currentEntries.find(
      (entry) => entry.type === "row" && entry.top + entry.height > currentScrollTop,
    );

    if (!firstVisibleRow || firstVisibleRow.type !== "row") {
      console.log("[PhotoGrid] Scroll restore anchor capture skipped", {
        direction,
        reason: "no-visible-row",
        currentScrollTop,
      });
      return null;
    }

    const anchorAssetId = firstVisibleRow.items[0]?.id;
    if (!anchorAssetId) {
      console.log("[PhotoGrid] Scroll restore anchor capture skipped", {
        direction,
        reason: "visible-row-has-no-items",
        rowKey: firstVisibleRow.key,
      });
      return null;
    }

    const anchor: ScrollRestoreAnchor = {
      direction,
      assetId: anchorAssetId,
      offsetWithinRow: currentScrollTop - firstVisibleRow.top,
      capturedScrollTop: currentScrollTop,
      capturedAt: Date.now(),
    };

    console.log("[PhotoGrid] Scroll restore anchor captured", {
      direction,
      assetId: anchor.assetId,
      rowKey: firstVisibleRow.key,
      rowTop: firstVisibleRow.top,
      offsetWithinRow: anchor.offsetWithinRow,
      capturedScrollTop: anchor.capturedScrollTop,
    });

    return anchor;
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setShowVideoDebug(window.localStorage.getItem("immichDebugVideoMeta") === "1");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("immichFullscreenInfoPanel", showInfoPanel ? "1" : "0");
  }, [showInfoPanel]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await getSettings();
        setSettings(data);
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    };

    void loadSettings();
  }, []);

  useEffect(() => {
    if (isUsingFullLayout) {
      // Full layout mode uses scroll-position-based load triggers instead
      return;
    }
    if (!sentinelRef.current) {
      console.log("[PhotoGrid] Bottom sentinel: no sentinelRef, skipping observer setup");
      return;
    }

    console.log("[PhotoGrid] Bottom sentinel: setting up observer", {
      hasNextPage,
      isFetching,
      isLoadingNextRef: isLoadingNextRef.current,
    });

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        console.log("[PhotoGrid] Bottom sentinel intersection", {
          isIntersecting: entry?.isIntersecting,
          hasNextPage,
          isFetching,
          pendingJumpDateKey,
          isLoadingNext: isLoadingNextRef.current,
          willLoadMore:
            entry?.isIntersecting &&
            hasNextPage &&
            !isFetching &&
            !isLoadingNextRef.current &&
            !pendingJumpDateKey,
        });
        if (
          entry?.isIntersecting &&
          hasNextPage &&
          !isFetching &&
          !isLoadingNextRef.current &&
          !pendingJumpDateKey
        ) {
          const anchor = captureScrollRestoreAnchor("append");
          pendingScrollRestoreRef.current = anchor;
          pendingRestoreAttemptsRef.current = 0;
          isLoadingNextRef.current = true;
          void Promise.resolve(onLoadMore()).finally(() => {
            console.log("[PhotoGrid] onLoadMore settled -> resetting isLoadingNextRef");
            isLoadingNextRef.current = false;
          });
        }
      },
      {
        root: viewportRef.current,
        rootMargin: "600px 0px",
      },
    );

    observer.observe(sentinelRef.current);

    return () => {
      console.log("[PhotoGrid] Bottom sentinel: disconnecting observer");
      observer.disconnect();
    };
  }, [hasNextPage, isFetching, isUsingFullLayout, onLoadMore, pendingJumpDateKey]);

  useEffect(() => {
    if (isUsingFullLayout || !topSentinelRef.current || !onLoadPrevious) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && pendingJumpDateKey) {
          console.log("[PhotoGrid] Top sentinel intersection ignored during jump", {
            pendingJumpDateKey,
            hasPreviousPage,
            isFetchingPrevious,
            isLoadingPrevious: isLoadingPreviousRef.current,
          });
          return;
        }

        if (
          entry?.isIntersecting &&
          hasPreviousPage &&
          !isFetchingPrevious &&
          !isLoadingPreviousRef.current &&
          !pendingScrollRestoreRef.current
        ) {
          const anchor = captureScrollRestoreAnchor("prepend");
          pendingScrollRestoreRef.current = anchor;
          pendingRestoreAttemptsRef.current = 0;

          isLoadingPreviousRef.current = true;

          void Promise.resolve(onLoadPrevious()).finally(() => {
            console.log("[PhotoGrid] onLoadPrevious settled -> resetting isLoadingPreviousRef");
            isLoadingPreviousRef.current = false;
          });
        }

        if (entry?.isIntersecting && pendingScrollRestoreRef.current) {
          console.log("[PhotoGrid] Top sentinel intersection ignored while restore pending", {
            pendingRestoreDirection: pendingScrollRestoreRef.current.direction,
            pendingRestoreAssetId: pendingScrollRestoreRef.current.assetId,
          });
        }
      },
      {
        root: viewportRef.current,
        rootMargin: "600px 0px",
      },
    );

    observer.observe(topSentinelRef.current);

    return () => {
      observer.disconnect();
    };
  }, [hasPreviousPage, isFetchingPrevious, isUsingFullLayout, onLoadPrevious, pendingJumpDateKey]);

  useEffect(() => {
    if (!isFetching) {
      console.log("[PhotoGrid] isFetching became false → resetting isLoadingNextRef");
      isLoadingNextRef.current = false;
    }
  }, [isFetching]);

  useEffect(() => {
    if (!isFetchingPrevious) {
      isLoadingPreviousRef.current = false;
    }
  }, [isFetchingPrevious]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewport = () => {
      setViewportWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
    };

    updateViewport();

    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);

    const handleScroll = () => {
      latestScrollTopRef.current = element.scrollTop;
      if (scrollRafRef.current !== null) {
        return;
      }

      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        setScrollTop((current) => {
          const next = latestScrollTopRef.current;
          return current === next ? current : next;
        });
      });
    };
    element.addEventListener("scroll", handleScroll, { passive: true });
    setScrollTop(element.scrollTop);

    return () => {
      element.removeEventListener("scroll", handleScroll);
      observer.disconnect();
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const displayAssets = useMemo(
    () =>
      assets
        .map((asset) => {
          const override = assetOverrides[asset.id];
          return override ? { ...asset, ...override } : asset;
        })
        .filter((asset) => {
          if (!hideArchivedAssets) {
            return true;
          }

          if (asset.isArchived) {
            return false;
          }

          const visibility = (asset.visibility ?? "").toLowerCase();
          return visibility !== "archive";
        }),
    [assetOverrides, assets, hideArchivedAssets],
  );

  // Full-layout mode only reloads when its effect dependencies change. Track
  // the currently hidden archived/visibility IDs so archive apply actions
  // trigger a layout reload instead of leaving stale rows visible.
  const hiddenArchivedAssetIdsKey = useMemo(() => {
    if (!hideArchivedAssets) {
      return "";
    }

    const hiddenIds: string[] = [];
    for (const asset of assets) {
      const override = assetOverrides[asset.id];
      const nextIsArchived =
        typeof override?.isArchived === "boolean" ? override.isArchived : asset.isArchived;
      const nextVisibility =
        typeof override?.visibility === "string" ? override.visibility : asset.visibility;

      if (nextIsArchived || (nextVisibility ?? "").toLowerCase() === "archive") {
        hiddenIds.push(asset.id);
      }
    }

    hiddenIds.sort();
    return hiddenIds.join(",");
  }, [assetOverrides, assets, hideArchivedAssets]);

  const loadedCountText = useMemo(() => {
    if (!hasNextPage) {
      return t("photoGrid.loadedAll", { count: displayAssets.length });
    }
    return t("photoGrid.loaded", { count: displayAssets.length });
  }, [displayAssets.length, hasNextPage, t]);

  const assetsById = useMemo(
    () => new Map(displayAssets.map((asset) => [asset.id, asset])),
    [displayAssets],
  );
  const { selectedAssetIds, assetIndexById, applySelection } = usePhotoGridSelection({
    displayAssets,
    selectionCommand,
    onSelectedCountChange,
    onSelectedIdsChange,
  });

  const availableDates = useMemo(
    () =>
      availableDatesProp ??
      (fullGridSections.length > 0 ? fullGridSections : gridSections).map((section) => section.key),
    [availableDatesProp, fullGridSections, gridSections],
  );

  const {
    virtualEntries,
    visibleEntries,
    totalContentHeight,
    loadedTimelineMonths,
    loadedContentTop,
    loadedContentBottom,
    sectionTopMap,
  } = usePhotoGridVirtualLayout({
    fullGridSections,
    gridSections,
    displayAssetIds: displayAssets.map((asset) => asset.id),
    isUsingFullLayout,
    viewportHeight,
    scrollTop,
  });

  useEffect(() => {
    if (!loadTimelineLayout || viewportWidth <= 0) {
      setTimelineLayout(null);
      return;
    }

    let cancelled = false;

    void loadTimelineLayout(viewportWidth)
      .then((data) => {
        if (!cancelled) {
          setTimelineLayout(data);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load timeline layout:", error);
          setTimelineLayout(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadTimelineLayout, viewportWidth]);

  useEffect(() => {
    latestVirtualEntriesRef.current = virtualEntries;
  }, [virtualEntries]);

  useEffect(() => {
    sectionTopMapRef.current = sectionTopMap;
  }, [sectionTopMap]);

  useEffect(() => {
    latestRenderScrollTopRef.current = scrollTop;
  }, [scrollTop]);

  // Load the full layout for all assets upfront so the virtual canvas is stable
  useEffect(() => {
    if (!loadFullLayout || viewportWidth <= 0) {
      return;
    }

    let cancelled = false;

    void loadFullLayout(viewportWidth)
      .then((data) => {
        if (!cancelled) {
          console.log("[PhotoGrid] Full grid layout loaded", {
            sectionCount: data.sections.length,
            viewportWidth,
          });
          setFullGridSections(data.sections);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load full grid layout:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hiddenArchivedAssetIdsKey, loadFullLayout, viewportWidth]);

  // Scroll-position-based load triggers used in full layout mode
  // (IntersectionObserver sentinels are disabled in this mode)
  const SCROLL_LOAD_TRIGGER_PX = 800;
  useEffect(() => {
    if (!isUsingFullLayout) return;
    if (pendingJumpDateKey) {
      return;
    }

    if (
      onLoadPrevious &&
      hasPreviousPage &&
      !isFetchingPrevious &&
      !isLoadingPreviousRef.current &&
      scrollTop - loadedContentTop < SCROLL_LOAD_TRIGGER_PX
    ) {
      console.log("[PhotoGrid] Full layout: scroll trigger prepend", {
        scrollTop,
        loadedContentTop,
        distance: scrollTop - loadedContentTop,
      });
      isLoadingPreviousRef.current = true;
      void Promise.resolve(onLoadPrevious()).finally(() => {
        console.log("[PhotoGrid] onLoadPrevious settled -> resetting isLoadingPreviousRef");
        isLoadingPreviousRef.current = false;
      });
    }

    if (
      hasNextPage &&
      !isFetching &&
      !isLoadingNextRef.current &&
      loadedContentBottom - scrollTop - viewportHeight < SCROLL_LOAD_TRIGGER_PX
    ) {
      console.log("[PhotoGrid] Full layout: scroll trigger append", {
        scrollTop,
        viewportHeight,
        loadedContentBottom,
        distance: loadedContentBottom - scrollTop - viewportHeight,
      });
      isLoadingNextRef.current = true;
      void Promise.resolve(onLoadMore()).finally(() => {
        console.log("[PhotoGrid] onLoadMore settled -> resetting isLoadingNextRef");
        isLoadingNextRef.current = false;
      });
    }
  }, [
    isUsingFullLayout,
    scrollTop,
    loadedContentTop,
    loadedContentBottom,
    hasPreviousPage,
    isFetchingPrevious,
    hasNextPage,
    isFetching,
    onLoadPrevious,
    onLoadMore,
    viewportHeight,
    pendingJumpDateKey,
  ]);

  useLayoutEffect(() => {
    // With full layout, row positions are stable — no scroll restoration needed
    if (isUsingFullLayout) return;

    const pendingAnchor = pendingScrollRestoreRef.current;
    if (!pendingAnchor || isFetching || isFetchingPrevious) {
      return;
    }

    if (layoutReadyAssetCount !== displayAssets.length) {
      console.log("[PhotoGrid] Scroll restore waiting for fresh layout", {
        direction: pendingAnchor.direction,
        assetId: pendingAnchor.assetId,
        layoutReadyAssetCount,
        displayAssetCount: displayAssets.length,
      });
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const anchorEntry = virtualEntries.find(
      (entry) =>
        entry.type === "row" && entry.items.some((item) => item.id === pendingAnchor.assetId),
    );

    if (!anchorEntry) {
      pendingRestoreAttemptsRef.current += 1;
      if (pendingRestoreAttemptsRef.current >= 3) {
        console.log("[PhotoGrid] Scroll restore anchor dropped after retries", {
          direction: pendingAnchor.direction,
          assetId: pendingAnchor.assetId,
          attempts: pendingRestoreAttemptsRef.current,
        });
        pendingScrollRestoreRef.current = null;
        pendingRestoreAttemptsRef.current = 0;
      } else {
        console.log("[PhotoGrid] Scroll restore anchor not found yet, retrying", {
          direction: pendingAnchor.direction,
          assetId: pendingAnchor.assetId,
          attempt: pendingRestoreAttemptsRef.current,
        });
      }
      return;
    }

    const targetScrollTop = anchorEntry.top + pendingAnchor.offsetWithinRow;
    viewport.scrollTop = targetScrollTop;
    latestScrollTopRef.current = targetScrollTop;
    latestRenderScrollTopRef.current = targetScrollTop;
    setScrollTop(targetScrollTop);
    console.log("[PhotoGrid] Scroll restore anchor restored", {
      direction: pendingAnchor.direction,
      assetId: pendingAnchor.assetId,
      restoredWithEntryKey: anchorEntry.key,
      targetScrollTop,
      entryTop: anchorEntry.top,
      offsetWithinRow: pendingAnchor.offsetWithinRow,
      capturedScrollTop: pendingAnchor.capturedScrollTop,
      latencyMs: Date.now() - pendingAnchor.capturedAt,
    });
    pendingScrollRestoreRef.current = null;
    pendingRestoreAttemptsRef.current = 0;
  }, [displayAssets.length, isFetching, isFetchingPrevious, layoutReadyAssetCount, virtualEntries]);

  const scrollToDateKey = (targetKey: string) => {
    const targetTop = sectionTopMapRef.current.get(targetKey);
    if (typeof targetTop === "number" && viewportRef.current) {
      viewportRef.current.scrollTo({ top: targetTop, behavior: "smooth" });
      return true;
    }

    return false;
  };

  const resolveDateKeyForRatio = (ratio: number, days: TimelineLayoutDay[]): string | null => {
    if (days.length === 0) {
      return null;
    }

    const totalRows = days.reduce((sum, day) => sum + Math.max(1, day.rowCount), 0);
    if (totalRows <= 0) {
      return days[0]?.dateKey ?? null;
    }

    const target = Math.max(0, Math.min(1, ratio)) * totalRows;
    let cursor = 0;

    for (const day of days) {
      cursor += Math.max(1, day.rowCount);
      if (target <= cursor) {
        return day.dateKey;
      }
    }

    return days[days.length - 1]?.dateKey ?? null;
  };

  const handleTimelineSeekRatio = (ratio: number) => {
    const dateKey = resolveDateKeyForRatio(ratio, timelineLayout?.days ?? []);
    if (dateKey) {
      void handleJumpToDate(dateKey);
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const clamped = Math.max(0, Math.min(1, ratio));
    const maxScroll = Math.max(viewport.scrollHeight - viewport.clientHeight, 0);
    viewport.scrollTo({
      top: clamped * maxScroll,
      behavior: "auto",
    });
  };

  const timelineMonths = timelineLayout?.months ?? loadedTimelineMonths;

  const timelineScrollRatio = useMemo(() => {
    const days = timelineLayout?.days;
    if (!days || days.length === 0) {
      const maxScroll = Math.max(totalContentHeight - viewportHeight, 0);
      if (maxScroll <= 0) {
        return 0;
      }

      return Math.max(0, Math.min(1, scrollTop / maxScroll));
    }

    const topVisibleDate =
      (fullGridSections.length > 0 ? fullGridSections : gridSections).find(
        (section) => sectionTopMapRef.current.get(section.key)! >= scrollTop,
      )?.key ??
      (fullGridSections.length > 0 ? fullGridSections : gridSections)[
        (fullGridSections.length > 0 ? fullGridSections : gridSections).length - 1
      ]?.key;

    if (!topVisibleDate) {
      return 0;
    }

    const totalRows = days.reduce((sum, day) => sum + Math.max(1, day.rowCount), 0);
    if (totalRows <= 0) {
      return 0;
    }

    let cumulative = 0;
    for (const day of days) {
      if (day.dateKey === topVisibleDate) {
        break;
      }
      cumulative += Math.max(1, day.rowCount);
    }

    return Math.max(0, Math.min(1, cumulative / totalRows));
  }, [
    fullGridSections,
    gridSections,
    scrollTop,
    timelineLayout?.days,
    totalContentHeight,
    viewportHeight,
  ]);

  // Fires when virtualEntries (and therefore sectionTopMapRef) updates
  useEffect(() => {
    if (!pendingJumpDateKey) {
      return;
    }

    if (scrollToDateKey(pendingJumpDateKey)) {
      setPendingJumpDateKey(null);
    }
  }, [pendingJumpDateKey, virtualEntries]);

  const handleJumpToDate = async (dateKey: string) => {
    const jumpId = `grid-jump-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAtMs = performance.now();
    jumpMetricsRef.current = {
      jumpId,
      dateKey,
      startedAtMs,
    };
    console.log("[PhotoGrid] handleJumpToDate start", { jumpId, dateKey });

    setPendingJumpDateKey(dateKey);
    if (viewportRef.current) {
      viewportRef.current.scrollTop = 0;
      latestScrollTopRef.current = 0;
      latestRenderScrollTopRef.current = 0;
      setScrollTop(0);
    }

    if (onJumpToDate) {
      console.log("[PhotoGrid] calling onJumpToDate, hasNextPage before jump:", hasNextPage);
      await onJumpToDate(dateKey);
      console.log("[PhotoGrid] handleJumpToDate data phase done", {
        jumpId,
        dateKey,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      console.log(
        "[PhotoGrid] onJumpToDate resolved, hasNextPage after jump:",
        hasNextPage,
        "isLoadingNextRef:",
        isLoadingNextRef.current,
      );
      return;
    }

    if (scrollToDateKey(dateKey)) {
      setPendingJumpDateKey(null);
      console.log("[PhotoGrid] handleJumpToDate scroll phase done", {
        jumpId,
        dateKey,
        durationMs: Math.round(performance.now() - startedAtMs),
      });
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function loadLayout() {
      // Skip per-page layout when full layout from Tauri is available
      if (fullGridSections.length > 0) {
        return;
      }

      const assetCountForLayout = displayAssets.length;
      if (viewportWidth <= 0 || displayAssets.length === 0) {
        setGridSections([]);
        setLayoutReadyAssetCount(assetCountForLayout);
        return;
      }

      try {
        console.log("[PhotoGrid] calculateGridLayout start", {
          assetCount: displayAssets.length,
          viewportWidth,
          scrollTop: latestRenderScrollTopRef.current,
        });
        const data = await calculateGridLayout(
          displayAssets.map((asset) => ({
            id: asset.id,
            fileCreatedAt: asset.fileCreatedAt,
            type: asset.type,
            width: asset.width,
            height: asset.height,
            thumbhash: asset.thumbhash,
          })),
          viewportWidth,
        );

        if (!cancelled) {
          console.log("[PhotoGrid] calculateGridLayout done", {
            sectionCount: data.sections.length,
            previousSectionCount: gridSections.length,
            assetCountForLayout,
          });
          setGridSections(data.sections);
          setLayoutReadyAssetCount(assetCountForLayout);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to calculate grid layout:", error);
          setGridSections([]);
          setLayoutReadyAssetCount(assetCountForLayout);
        }
      }
    }

    void loadLayout();

    return () => {
      cancelled = true;
    };
  }, [displayAssets, viewportWidth]);

  const hasActive = activeIndex !== null && activeIndex >= 0 && activeIndex < displayAssets.length;
  const activeAsset = hasActive && activeIndex !== null ? displayAssets[activeIndex] : null;

  useEffect(() => {
    if (activeAsset) {
      console.log("[PhotoGrid] Active asset changed:", {
        assetId: activeAsset.id,
        fileName: activeAsset.originalFileName,
        rating: activeAsset.rating,
        isFavorite: activeAsset.isFavorite,
        isArchived: activeAsset.isArchived,
        visibility: activeAsset.visibility,
      });
    }
  }, [activeAsset?.id]);

  // Refresh asset metadata from server when navigating to a new asset
  useEffect(() => {
    if (!activeAsset || !hasActive) {
      return;
    }

    const asset = activeAsset;
    let cancelled = false;

    async function refreshAssetMetadata() {
      try {
        const refreshed = await refreshAsset(asset.id);
        if (!cancelled) {
          console.log("[PhotoGrid] Asset refreshed from server:", {
            assetId: refreshed.id,
            rating: refreshed.rating,
            isFavorite: refreshed.isFavorite,
            isArchived: refreshed.isArchived,
          });
          // Update the override with the server's latest metadata
          updateActiveAssetOverride({
            rating: refreshed.rating,
            isFavorite: refreshed.isFavorite,
            isArchived: refreshed.isArchived,
            visibility: refreshed.visibility,
          });
        }
      } catch (error) {
        // Silently fail if server is offline; navigation should not be blocked
        console.log(
          "[PhotoGrid] Failed to refresh asset from server (network may be offline):",
          error,
        );
      }
    }

    void refreshAssetMetadata();

    return () => {
      cancelled = true;
    };
  }, [activeAsset?.id, hasActive]);

  useEffect(() => {
    if (!activeAsset) {
      return;
    }

    const asset = activeAsset;
    let cancelled = false;

    if (isVideoAsset(asset)) {
      setActiveStillSrc(null);
      return;
    }

    async function loadActiveStill() {
      try {
        const value = await getAssetThumbnail(asset.id);
        if (!cancelled) {
          setActiveStillSrc(value);
        }
      } catch {
        if (!cancelled) {
          setActiveStillSrc(null);
        }
      }
    }

    void loadActiveStill();

    return () => {
      cancelled = true;
    };
  }, [activeAsset]);

  useEffect(() => {
    setActiveFullsizeStillSrc(null);
    fullsizeStillLoadingAssetIdRef.current = null;
  }, [activeAsset?.id]);

  useEffect(() => {
    if (!activeAsset || isVideoAsset(activeAsset) || activeAsset.livePhotoVideoId) {
      return;
    }

    const asset = activeAsset;

    if (zoom <= 100 || activeFullsizeStillSrc) {
      return;
    }

    if (fullsizeStillLoadingAssetIdRef.current === asset.id) {
      return;
    }

    let cancelled = false;
    fullsizeStillLoadingAssetIdRef.current = asset.id;

    async function preloadFullsizeStill() {
      try {
        // If a local copy already exists on disk, reuse it instead of
        // downloading again. This prevents a redundant second download when the
        // download badge copies the original and then auto-zooms in.
        const existingDetails = await getCachedAssetDetails(asset.id);
        if (existingDetails?.localSavedPath) {
          const existingSrc = `file://${existingDetails.localSavedPath}`;
          await preloadImage(existingSrc);
          if (!cancelled) {
            setActiveFullsizeStillSrc(existingSrc);
          }
          return;
        }

        // Copy full-resolution to the user's local folder. Originals must NEVER
        // be downloaded into the cache folder — only into the configured local
        // folder. If no local folder is set, we keep using the thumbnail.
        const settings = await getSettings();
        const destinationFolder = settings.userLocalFolderPath.trim();

        if (!destinationFolder) {
          return;
        }

        // Copy the original file to local folder
        await copyAssetsToLocalFolder([asset.id], destinationFolder, false);

        // Get updated cache details to find the local path
        const cacheDetails = await getCachedAssetDetails(asset.id);

        // Use the locally saved file if available
        if (cacheDetails?.localSavedPath) {
          const localSrc = `file://${cacheDetails.localSavedPath}`;
          await preloadImage(localSrc);

          if (!cancelled) {
            setActiveFullsizeStillSrc(localSrc);
          }
        }
      } catch {
        // Keep using thumbnail source when full-size preload fails.
      } finally {
        if (fullsizeStillLoadingAssetIdRef.current === asset.id) {
          fullsizeStillLoadingAssetIdRef.current = null;
        }
      }
    }

    void preloadFullsizeStill();

    return () => {
      cancelled = true;
    };
  }, [activeAsset, activeFullsizeStillSrc, zoom]);

  useEffect(() => {
    if (!activeAsset) {
      return;
    }

    const asset = activeAsset;
    let cancelled = false;

    async function loadActiveMedia() {
      try {
        let value: string;

        if (isPlayingLivePhoto && asset.livePhotoVideoId) {
          value = await getAssetPlayback(asset.livePhotoVideoId);
          if (!cancelled) {
            setActiveSrc(toPlayableSrc(value));
          }
        } else if (isVideoAsset(asset)) {
          value = await getAssetPlayback(asset.id);
          if (!cancelled) {
            setActiveSrc(toPlayableSrc(value));
          }
        } else if (!cancelled) {
          setActiveSrc(null);
        }
      } catch {
        if (!cancelled) {
          setActiveSrc(null);
        }
      }
    }

    void loadActiveMedia();

    return () => {
      cancelled = true;
    };
  }, [activeAsset, isPlayingLivePhoto]);

  useEffect(() => {
    if (!activeAsset) {
      setCachedAssetDetails(null);
      setIsLoadingCachedDetails(false);
      return;
    }

    const asset = activeAsset;
    let cancelled = false;
    setIsLoadingCachedDetails(true);

    async function loadCachedDetails() {
      try {
        const details = await getCachedAssetDetails(asset.id);
        if (!cancelled) {
          setCachedAssetDetails(details);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load cached asset details:", error);
          setCachedAssetDetails(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCachedDetails(false);
        }
      }
    }

    void loadCachedDetails();

    return () => {
      cancelled = true;
    };
  }, [activeAsset?.id]);

  useEffect(() => {
    if (!hasActive) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveIndex(null);
        setActiveSrc(null);
        setActiveStillSrc(null);
        setIsPlayingLivePhoto(false);
        setShouldAutoplayLivePhoto(false);
        return;
      }

      if (event.key === "ArrowLeft") {
        goPrev();
        return;
      }

      if (event.key === "ArrowRight") {
        goNext();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeIndex, displayAssets.length, hasActive]);

  useEffect(() => {
    if (!activeAsset) {
      return;
    }

    if (shouldAutoplayLivePhoto && activeAsset.livePhotoVideoId && !isPlayingLivePhoto) {
      setShouldAutoplayLivePhoto(false);
      setIsPlayingLivePhoto(true);
    }
  }, [activeAsset, isPlayingLivePhoto, shouldAutoplayLivePhoto]);

  useLayoutEffect(() => {
    const element = imageContainerRef.current;
    if (!element || !hasActive) {
      return;
    }

    const updateImageContainerSize = () => {
      setImageContainerWidth(element.clientWidth);
      setImageContainerHeight(element.clientHeight);
    };

    // Measure immediately when fullscreen image container appears.
    updateImageContainerSize();

    const observer = new ResizeObserver(updateImageContainerSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [hasActive, activeAsset?.id]);

  const activeAssetRatio = getAssetAspectRatio(activeAsset);
  const livePhotoFrameStyle = {
    aspectRatio: String(activeAssetRatio),
    maxWidth: "calc(100vw - 8rem)",
    maxHeight: "calc(100vh - 18rem)",
    width:
      activeAssetRatio >= 1
        ? `min(calc(100vw - 8rem), calc((100vh - 18rem) * ${activeAssetRatio}))`
        : `calc((100vh - 18rem) * ${activeAssetRatio})`,
    height:
      activeAssetRatio >= 1
        ? `calc((100vw - 8rem) / ${activeAssetRatio})`
        : `min(calc(100vh - 18rem), calc((100vw - 8rem) / ${activeAssetRatio}))`,
  } as const;

  const resetFullscreenPlayback = (autoplayLivePhoto: boolean) => {
    setActiveSrc(null);
    setActiveStillSrc(null);
    setIsPlayingLivePhoto(false);
    setShouldAutoplayLivePhoto(autoplayLivePhoto);
    setZoom(100);
  };

  const showAssetAtIndex = (index: number, autoplayLivePhoto: boolean) => {
    setActiveIndex(index);
    resetFullscreenPlayback(autoplayLivePhoto);
  };

  const openLightbox = (assetId: string) => {
    const index = displayAssets.findIndex((asset) => asset.id === assetId);
    if (index < 0) {
      return;
    }

    showAssetAtIndex(index, true);
  };

  const closeLightbox = () => {
    setActiveIndex(null);
    resetFullscreenPlayback(false);
  };

  const goPrev = () => {
    if (activeIndex === null) {
      return;
    }

    showAssetAtIndex(Math.max(0, activeIndex - 1), true);
  };

  const goNext = () => {
    if (activeIndex === null) {
      return;
    }

    if (activeIndex < displayAssets.length - 1) {
      showAssetAtIndex(activeIndex + 1, true);
      return;
    }

    if (hasNextPage) {
      pendingFullscreenAdvanceRef.current = true;
      requestFullscreenLoadMore();
    }
  };

  useEffect(() => {
    if (activeIndex === null) {
      pendingFullscreenAdvanceRef.current = false;
      return;
    }

    if (!hasNextPage) {
      return;
    }

    const remaining = displayAssets.length - 1 - activeIndex;
    if (remaining <= 2) {
      requestFullscreenLoadMore();
    }
  }, [activeIndex, displayAssets.length, hasNextPage, isFetching, pendingJumpDateKey]);

  useEffect(() => {
    if (!pendingFullscreenAdvanceRef.current || activeIndex === null) {
      return;
    }

    if (activeIndex < displayAssets.length - 1) {
      pendingFullscreenAdvanceRef.current = false;
      showAssetAtIndex(activeIndex + 1, true);
      return;
    }

    if (!hasNextPage) {
      pendingFullscreenAdvanceRef.current = false;
    }
  }, [activeIndex, displayAssets.length, hasNextPage]);

  const updateActiveAssetOverride = (override: Partial<AssetSummary>) => {
    if (!activeAsset) {
      return;
    }

    setAssetOverrides((current) => ({
      ...current,
      [activeAsset.id]: {
        ...current[activeAsset.id],
        ...override,
      },
    }));
  };

  const handleFavoriteToggle = async () => {
    if (!activeAsset) {
      return;
    }

    const nextValue = !activeAsset.isFavorite;
    updateActiveAssetOverride({ isFavorite: nextValue });
    setFavoriteUpdateId(activeAsset.id);

    try {
      await updateAssetFavorite(activeAsset.id, nextValue);
    } catch (error) {
      updateActiveAssetOverride({ isFavorite: activeAsset.isFavorite });
      console.error("Failed to update asset favorite status:", error);
    } finally {
      setFavoriteUpdateId((current) => (current === activeAsset.id ? null : current));
    }
  };

  const handleArchiveToggle = async () => {
    if (!activeAsset) {
      return;
    }

    const nextIsArchived = !activeAsset.isArchived;
    const nextVisibility: AssetVisibility = nextIsArchived ? "archive" : "timeline";

    updateActiveAssetOverride({
      isArchived: nextIsArchived,
      visibility: nextVisibility,
    });
    setArchiveUpdateId(activeAsset.id);

    try {
      await updateAssetVisibility(activeAsset.id, nextVisibility);
    } catch (error) {
      updateActiveAssetOverride({
        isArchived: activeAsset.isArchived,
        visibility: activeAsset.visibility,
      });
      console.error("Failed to update asset archive status:", error);
    } finally {
      setArchiveUpdateId((current) => (current === activeAsset.id ? null : current));
    }
  };

  const handleRatingChange = async (rating: number | null) => {
    if (!activeAsset) {
      return;
    }

    console.log("[PhotoGrid] Rating change requested:", {
      assetId: activeAsset.id,
      oldRating: activeAsset.rating,
      newRating: rating,
    });

    updateActiveAssetOverride({ rating });
    setRatingUpdateId(activeAsset.id);

    try {
      await updateAssetRating(activeAsset.id, rating);
      console.log("[PhotoGrid] Rating update succeeded:", {
        assetId: activeAsset.id,
        rating,
      });
    } catch (error) {
      updateActiveAssetOverride({ rating: activeAsset.rating });
      console.error("Failed to update asset rating:", error);
    } finally {
      setRatingUpdateId((current) => (current === activeAsset.id ? null : current));
    }
  };

  const handleDescriptionChange = async (description: string) => {
    if (!activeAsset) {
      return;
    }

    const nextDescription = description.trim().length > 0 ? description.trim() : null;
    const previousDescription = cachedAssetDetails?.description ?? null;

    if (nextDescription === previousDescription) {
      return;
    }

    setDescriptionUpdateId(activeAsset.id);
    setCachedAssetDetails((current) =>
      current && current.id === activeAsset.id
        ? { ...current, description: nextDescription }
        : current,
    );

    try {
      await updateAssetDescription(activeAsset.id, nextDescription);
    } catch (error) {
      console.error("Failed to update asset description:", error);
      setCachedAssetDetails((current) =>
        current && current.id === activeAsset.id
          ? { ...current, description: previousDescription }
          : current,
      );
    } finally {
      setDescriptionUpdateId((current) => (current === activeAsset.id ? null : current));
    }
  };

  const handleAssetDimensions = (assetId: string, width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return;
    }

    const safeWidth = Math.round(width);
    const safeHeight = Math.round(height);
    if (safeWidth <= 0 || safeHeight <= 0) {
      return;
    }

    setAssetOverrides((current) => {
      const existingOverride = current[assetId] ?? {};
      const existingAsset = assetsById.get(assetId);
      const existingWidth = existingOverride.width ?? existingAsset?.width ?? null;
      const existingHeight = existingOverride.height ?? existingAsset?.height ?? null;

      const hasKnownDimensions =
        Number.isFinite(existingWidth) &&
        Number.isFinite(existingHeight) &&
        Number(existingWidth) > 0 &&
        Number(existingHeight) > 0;

      if (hasKnownDimensions) {
        return current;
      }

      if (existingWidth === safeWidth && existingHeight === safeHeight) {
        return current;
      }

      return {
        ...current,
        [assetId]: {
          ...existingOverride,
          width: safeWidth,
          height: safeHeight,
        },
      };
    });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="shrink-0 flex items-center justify-between text-xs text-base-content/60">
        <span>{loadedCountText}</span>
        {availableDates.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm gap-1"
            onClick={() => setShowDatePicker(true)}
            aria-label={t("photoGrid.jumpToDateAria")}
          >
            <Calendar size={16} />
            {t("photoGrid.jumpToDate")}
          </button>
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-1 items-stretch gap-2">
        <div
          ref={viewportRef}
          className="hide-scrollbar min-h-0 min-w-0 flex-1 overflow-auto pl-2 pr-2"
          style={{
            height: maxHeight > 0 ? `${maxHeight}px` : "auto",
            minHeight: 0,
          }}
        >
          <div className="relative" style={{ height: `${Math.max(totalContentHeight, 1)}px` }}>
            {/* Load-trigger sentinel for previous page, positioned at loaded content boundary */}
            <div
              ref={topSentinelRef}
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: `${isUsingFullLayout ? loadedContentTop : 0}px`,
                height: "1px",
              }}
            />
            {visibleEntries.map((entry) => {
              if (entry.type === "header") {
                return (
                  <div
                    key={entry.key}
                    className="absolute left-0 right-0 z-10 flex items-center gap-2 bg-base-200 pt-5 pb-3 text-sm font-semibold text-base-content/80"
                    style={{
                      top: `${entry.top}px`,
                      height: `${entry.height}px`,
                    }}
                  >
                    <span>{entry.label}</span>
                    <div className="h-px flex-1 bg-base-300" />
                  </div>
                );
              }

              return (
                <div
                  key={entry.key}
                  className="absolute left-0 right-0 flex gap-1"
                  style={{ top: `${entry.top}px`, height: `${entry.height}px` }}
                >
                  {entry.items.map((rowItem) => {
                    const asset = assetsById.get(rowItem.id);
                    if (!asset) {
                      // In full layout mode: render a placeholder so the virtual
                      // canvas stays stable while this page hasn't loaded yet
                      if (isUsingFullLayout) {
                        const placeholderSrc = thumbhashToDataUrl(rowItem.thumbhash ?? null);
                        return (
                          <div
                            key={rowItem.id}
                            className="relative h-full shrink-0 overflow-hidden bg-base-300"
                            style={{ width: `${rowItem.width}px` }}
                          >
                            {placeholderSrc ? (
                              <img
                                className="h-full w-full object-cover scale-110 blur-xl opacity-85"
                                src={placeholderSrc}
                                alt=""
                                aria-hidden="true"
                              />
                            ) : null}
                          </div>
                        );
                      }
                      return null;
                    }

                    const assetIndex = assetIndexById.get(asset.id) ?? -1;
                    const isSelected = selectedAssetIds.has(asset.id);

                    return (
                      <article
                        key={asset.id}
                        className={`group relative overflow-hidden bg-base-300 flex-none rounded-sm ${isSelected ? "border-4 border-primary" : ""}`}
                        style={{
                          width: `${rowItem.width}px`,
                        }}
                      >
                        <AssetThumbnail
                          asset={asset}
                          isSelected={isSelected}
                          onOpen={(event) => {
                            if (event.shiftKey || event.metaKey || event.ctrlKey) {
                              if (assetIndex >= 0) {
                                applySelection(asset.id, assetIndex, {
                                  shiftKey: event.shiftKey,
                                  metaKey: event.metaKey,
                                  ctrlKey: event.ctrlKey,
                                });
                              }
                              return;
                            }
                            openLightbox(asset.id);
                          }}
                          onToggleSelection={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (assetIndex >= 0) {
                              applySelection(asset.id, assetIndex, {
                                shiftKey: event.shiftKey,
                                metaKey: event.metaKey,
                                ctrlKey: event.ctrlKey,
                              });
                            }
                          }}
                          durationSeconds={videoDurations[asset.id]}
                          onDuration={(seconds) => {
                            setVideoDurations((current) => {
                              const existing = current[asset.id];
                              if (
                                typeof existing === "number" &&
                                Math.abs(existing - seconds) < 0.2
                              ) {
                                return current;
                              }

                              return {
                                ...current,
                                [asset.id]: seconds,
                              };
                            });
                          }}
                          onDimensions={(width, height) => {
                            handleAssetDimensions(asset.id, width, height);
                          }}
                          showDebug={showVideoDebug}
                          livePhotoAutoplay={settings?.livePhotoAutoplay ?? true}
                          suppressFullThumbnail={isTimelineScrubbing}
                          jumpMetrics={jumpMetricsRef.current}
                        />
                      </article>
                    );
                  })}
                </div>
              );
            })}

            {/* Load-trigger sentinel for next page, positioned at loaded content boundary */}
            <div
              ref={sentinelRef}
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: `${
                  isUsingFullLayout ? loadedContentBottom : Math.max(totalContentHeight - 1, 0)
                }px`,
                height: "1px",
              }}
            />
          </div>
        </div>

        <VerticalTimeline
          months={timelineMonths}
          scrollRatio={timelineScrollRatio}
          onSeekRatio={handleTimelineSeekRatio}
          onJumpToDateKey={(dateKey) => {
            void handleJumpToDate(dateKey);
          }}
          onScrubStateChange={setIsTimelineScrubbing}
          maxHeight={maxHeight}
        />
      </div>

      {isFetching ? (
        <p className="shrink-0 mt-2 text-xs text-base-content/60">
          {t("photoGrid.loadingMoreAssets")}
        </p>
      ) : null}
      {!hasNextPage ? (
        <p className="shrink-0 mt-2 text-xs text-base-content/60">{t("photoGrid.noMoreAssets")}</p>
      ) : null}

      {activeAsset && activeIndex !== null ? (
        <PhotoGridFullscreenOverlay
          activeAsset={activeAsset}
          activeIndex={activeIndex}
          displayAssets={displayAssets}
          hasNextPage={hasNextPage}
          activeSrc={activeSrc}
          activeStillSrc={activeStillSrc}
          activeFullsizeStillSrc={activeFullsizeStillSrc}
          zoom={zoom}
          onZoomChange={setZoom}
          isPlayingLivePhoto={isPlayingLivePhoto}
          onSetIsPlayingLivePhoto={setIsPlayingLivePhoto}
          showInfoPanel={showInfoPanel}
          onToggleInfoPanel={() => setShowInfoPanel((current) => !current)}
          favoriteUpdateId={favoriteUpdateId}
          archiveUpdateId={archiveUpdateId}
          ratingUpdateId={ratingUpdateId}
          descriptionUpdateId={descriptionUpdateId}
          cachedAssetDetails={cachedAssetDetails}
          isLoadingCachedDetails={isLoadingCachedDetails}
          imageContainerRef={imageContainerRef}
          imageContainerWidth={imageContainerWidth}
          imageContainerHeight={imageContainerHeight}
          livePhotoFrameStyle={livePhotoFrameStyle}
          onClose={closeLightbox}
          onGoPrev={goPrev}
          onGoNext={goNext}
          onSelectIndex={(index) => showAssetAtIndex(index, true)}
          onToggleFavorite={() => {
            void handleFavoriteToggle();
          }}
          onToggleArchive={() => {
            void handleArchiveToggle();
          }}
          onSetRating={(rating) => {
            void handleRatingChange(rating);
          }}
          onUpdateDescription={(description) => {
            void handleDescriptionChange(description);
          }}
        />
      ) : null}

      <DatePickerModal
        isOpen={showDatePicker}
        onClose={() => setShowDatePicker(false)}
        onSelectDate={(dateKey) => {
          void handleJumpToDate(dateKey);
        }}
        availableDates={availableDates}
      />
    </section>
  );
}
