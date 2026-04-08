import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Film,
  X,
  Calendar,
} from "lucide-react";
import { thumbHashToRGBA } from "thumbhash";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FullscreenMetadataBar } from "./FullscreenMetadataBar";
import { FullscreenThumbnailStrip } from "./FullscreenThumbnailStrip";
import { DatePickerModal } from "./DatePickerModal";
import { VerticalTimeline } from "./VerticalTimeline";
import type {
  GridLayoutSection,
  AssetSummary,
  AssetVisibility,
  Settings,
  TimelineLayoutDay,
  TimelineLayoutMonth,
  TimelineLayoutResponse,
} from "../../types";
import {
  calculateGridLayout,
  getAssetPlayback,
  getAssetThumbnail,
  getSettings,
  refreshAsset,
  updateAssetFavorite,
  updateAssetRating,
  updateAssetVisibility,
} from "../../api/tauri";

type PhotoGridProps = {
  assets: AssetSummary[];
  isFetching: boolean;
  isFetchingPrevious?: boolean;
  hasNextPage: boolean;
  hasPreviousPage?: boolean;
  onLoadMore: () => Promise<void> | void;
  onLoadPrevious?: () => Promise<void> | void;
  availableDates?: string[];
  onJumpToDate?: (dateKey: string) => Promise<void> | void;
  loadTimelineLayout?: (
    containerWidth: number,
  ) => Promise<TimelineLayoutResponse>;
  maxHeight?: number;
};

type VirtualEntry =
  | {
      type: "header";
      key: string;
      sectionKey: string;
      label: string;
      top: number;
      height: number;
    }
  | {
      type: "row";
      key: string;
      sectionKey: string;
      top: number;
      height: number;
      items: { id: string; width: number }[];
    };

export function PhotoGrid({
  assets,
  isFetching,
  isFetchingPrevious = false,
  hasNextPage,
  hasPreviousPage = false,
  onLoadMore,
  onLoadPrevious,
  availableDates: availableDatesProp,
  onJumpToDate,
  loadTimelineLayout,
  maxHeight = 0,
}: PhotoGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [activeSrc, setActiveSrc] = useState<string | null>(null);
  const [activeStillSrc, setActiveStillSrc] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [gridSections, setGridSections] = useState<GridLayoutSection[]>([]);
  const [videoDurations, setVideoDurations] = useState<Record<string, number>>(
    {},
  );
  const [showVideoDebug, setShowVideoDebug] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [assetOverrides, setAssetOverrides] = useState<
    Record<string, Partial<AssetSummary>>
  >({});
  const [isPlayingLivePhoto, setIsPlayingLivePhoto] = useState(false);
  const [shouldAutoplayLivePhoto, setShouldAutoplayLivePhoto] = useState(false);
  const [favoriteUpdateId, setFavoriteUpdateId] = useState<string | null>(null);
  const [archiveUpdateId, setArchiveUpdateId] = useState<string | null>(null);
  const [ratingUpdateId, setRatingUpdateId] = useState<string | null>(null);
  const [isTimelineScrubbing, setIsTimelineScrubbing] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pendingJumpDateKey, setPendingJumpDateKey] = useState<string | null>(
    null,
  );
  const sectionTopMapRef = useRef<Map<string, number>>(new Map());
  const isLoadingNextRef = useRef(false);
  const isLoadingPreviousRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);
  const [timelineLayout, setTimelineLayout] =
    useState<TimelineLayoutResponse | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setShowVideoDebug(
      window.localStorage.getItem("immichDebugVideoMeta") === "1",
    );
  }, []);

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
          isLoadingNext: isLoadingNextRef.current,
          willLoadMore:
            entry?.isIntersecting &&
            hasNextPage &&
            !isFetching &&
            !isLoadingNextRef.current,
        });
        if (
          entry?.isIntersecting &&
          hasNextPage &&
          !isFetching &&
          !isLoadingNextRef.current
        ) {
          isLoadingNextRef.current = true;
          void Promise.resolve(onLoadMore()).finally(() => {
            console.log(
              "[PhotoGrid] onLoadMore settled -> resetting isLoadingNextRef",
            );
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
  }, [hasNextPage, isFetching, onLoadMore]);

  useEffect(() => {
    if (!topSentinelRef.current || !onLoadPrevious) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          entry?.isIntersecting &&
          hasPreviousPage &&
          !isFetchingPrevious &&
          !isLoadingPreviousRef.current
        ) {
          const viewport = viewportRef.current;
          const previousHeight = viewport?.scrollHeight ?? 0;
          isLoadingPreviousRef.current = true;

          void Promise.resolve(onLoadPrevious()).then(() => {
            requestAnimationFrame(() => {
              const nextViewport = viewportRef.current;
              if (nextViewport) {
                nextViewport.scrollTop +=
                  nextViewport.scrollHeight - previousHeight;
              }
            });
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
  }, [hasPreviousPage, isFetchingPrevious, onLoadPrevious]);

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
      assets.map((asset) => {
        const override = assetOverrides[asset.id];
        return override ? { ...asset, ...override } : asset;
      }),
    [assetOverrides, assets],
  );

  const loadedCountText = useMemo(() => {
    if (!hasNextPage) {
      return `${displayAssets.length} loaded (all)`;
    }
    return `${displayAssets.length} loaded`;
  }, [displayAssets.length, hasNextPage]);

  const assetsById = useMemo(
    () => new Map(displayAssets.map((asset) => [asset.id, asset])),
    [displayAssets],
  );

  const availableDates = useMemo(
    () => availableDatesProp ?? gridSections.map((section) => section.key),
    [availableDatesProp, gridSections],
  );

  const { virtualEntries, totalContentHeight, loadedTimelineMonths } =
    useMemo(() => {
      const entries: VirtualEntry[] = [];
      const nextSectionTopMap = new Map<string, number>();
      const monthMap = new Map<string, TimelineLayoutMonth>();

      const headerHeight = 52;
      const rowGap = 4;
      const sectionGap = 10;
      let cursor = 0;

      for (const section of gridSections) {
        nextSectionTopMap.set(section.key, cursor);
        entries.push({
          type: "header",
          key: `header-${section.key}`,
          sectionKey: section.key,
          label: section.label,
          top: cursor,
          height: headerHeight,
        });
        cursor += headerHeight;

        section.rows.forEach((row, rowIndex) => {
          entries.push({
            type: "row",
            key: `${section.key}-${rowIndex}`,
            sectionKey: section.key,
            top: cursor,
            height: row.height,
            items: row.items,
          });
          cursor += row.height + rowGap;
        });

        cursor += sectionGap;

        const dayInfo = parseDayKey(section.key);
        if (dayInfo) {
          const monthKey = `${dayInfo.year}-${String(dayInfo.month).padStart(2, "0")}`;
          const month = monthMap.get(monthKey);

          if (month) {
            month.rowCount += section.rows.length;
          } else {
            monthMap.set(monthKey, {
              monthKey,
              jumpDateKey: section.key,
              year: dayInfo.year,
              month: dayInfo.month,
              rowCount: section.rows.length,
            });
          }
        }
      }

      sectionTopMapRef.current = nextSectionTopMap;
      return {
        virtualEntries: entries,
        totalContentHeight: cursor,
        loadedTimelineMonths: [...monthMap.values()],
      };
    }, [gridSections]);

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

  const visibleEntries = useMemo(() => {
    if (virtualEntries.length === 0) {
      return [];
    }

    const overscan = Math.max(1000, viewportHeight * 1.5);
    const start = Math.max(0, scrollTop - overscan);
    const end = scrollTop + viewportHeight + overscan;

    const startIndex = Math.max(
      0,
      findFirstEntryAtOrAfter(virtualEntries, start) - 2,
    );
    const endIndex = Math.min(
      virtualEntries.length,
      findFirstEntryAtOrAfter(virtualEntries, end + 1) + 2,
    );

    return virtualEntries.slice(startIndex, endIndex).filter((entry) => {
      const entryBottom = entry.top + entry.height;
      return entryBottom >= start && entry.top <= end;
    });
  }, [virtualEntries, scrollTop, viewportHeight]);

  const scrollToDateKey = (targetKey: string) => {
    const targetTop = sectionTopMapRef.current.get(targetKey);
    if (typeof targetTop === "number" && viewportRef.current) {
      viewportRef.current.scrollTo({ top: targetTop, behavior: "smooth" });
      return true;
    }

    return false;
  };

  const resolveDateKeyForRatio = (
    ratio: number,
    days: TimelineLayoutDay[],
  ): string | null => {
    if (days.length === 0) {
      return null;
    }

    const totalRows = days.reduce(
      (sum, day) => sum + Math.max(1, day.rowCount),
      0,
    );
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
    const maxScroll = Math.max(
      viewport.scrollHeight - viewport.clientHeight,
      0,
    );
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
      gridSections.find(
        (section) => sectionTopMapRef.current.get(section.key)! >= scrollTop,
      )?.key ?? gridSections[gridSections.length - 1]?.key;

    if (!topVisibleDate) {
      return 0;
    }

    const totalRows = days.reduce(
      (sum, day) => sum + Math.max(1, day.rowCount),
      0,
    );
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
    gridSections,
    scrollTop,
    timelineLayout?.days,
    totalContentHeight,
    viewportHeight,
  ]);

  useEffect(() => {
    if (!pendingJumpDateKey) {
      return;
    }

    if (scrollToDateKey(pendingJumpDateKey)) {
      setPendingJumpDateKey(null);
    }
  }, [gridSections, pendingJumpDateKey]);

  const handleJumpToDate = async (dateKey: string) => {
    console.log("[PhotoGrid] handleJumpToDate", { dateKey });
    setPendingJumpDateKey(dateKey);
    if (viewportRef.current) {
      viewportRef.current.scrollTop = 0;
    }

    if (onJumpToDate) {
      console.log("[PhotoGrid] calling onJumpToDate, hasNextPage before jump:", hasNextPage);
      await onJumpToDate(dateKey);
      console.log("[PhotoGrid] onJumpToDate resolved, hasNextPage after jump:", hasNextPage, "isLoadingNextRef:", isLoadingNextRef.current);
      return;
    }

    if (scrollToDateKey(dateKey)) {
      setPendingJumpDateKey(null);
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function loadLayout() {
      if (viewportWidth <= 0 || displayAssets.length === 0) {
        setGridSections([]);
        return;
      }

      try {
        const data = await calculateGridLayout(
          displayAssets.map((asset) => ({
            id: asset.id,
            fileCreatedAt: asset.fileCreatedAt,
            width: asset.width,
            height: asset.height,
          })),
          viewportWidth,
        );

        if (!cancelled) {
          setGridSections(data.sections);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to calculate grid layout:", error);
          setGridSections([]);
        }
      }
    }

    void loadLayout();

    return () => {
      cancelled = true;
    };
  }, [displayAssets, viewportWidth]);

  const hasActive =
    activeIndex !== null &&
    activeIndex >= 0 &&
    activeIndex < displayAssets.length;
  const activeAsset =
    hasActive && activeIndex !== null ? displayAssets[activeIndex] : null;

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
        setActiveSrc(null);
        setActiveStillSrc(null);
        setIsPlayingLivePhoto(false);
        setShouldAutoplayLivePhoto(true);
        setActiveIndex((current) => {
          if (current === null) {
            return current;
          }
          return Math.max(0, current - 1);
        });
        return;
      }

      if (event.key === "ArrowRight") {
        setActiveSrc(null);
        setActiveStillSrc(null);
        setIsPlayingLivePhoto(false);
        setShouldAutoplayLivePhoto(true);
        setActiveIndex((current) => {
          if (current === null) {
            return current;
          }
          return Math.min(displayAssets.length - 1, current + 1);
        });
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [displayAssets.length, hasActive]);

  useEffect(() => {
    if (!activeAsset) {
      return;
    }

    if (
      shouldAutoplayLivePhoto &&
      activeAsset.livePhotoVideoId &&
      !isPlayingLivePhoto
    ) {
      setShouldAutoplayLivePhoto(false);
      setIsPlayingLivePhoto(true);
    }
  }, [activeAsset, isPlayingLivePhoto, shouldAutoplayLivePhoto]);

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

    showAssetAtIndex(Math.min(displayAssets.length - 1, activeIndex + 1), true);
  };

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
      setFavoriteUpdateId((current) =>
        current === activeAsset.id ? null : current,
      );
    }
  };

  const handleArchiveToggle = async () => {
    if (!activeAsset) {
      return;
    }

    const nextIsArchived = !activeAsset.isArchived;
    const nextVisibility: AssetVisibility = nextIsArchived
      ? "archive"
      : "timeline";

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
      setArchiveUpdateId((current) =>
        current === activeAsset.id ? null : current,
      );
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
      setRatingUpdateId((current) =>
        current === activeAsset.id ? null : current,
      );
    }
  };

  const handleAssetDimensions = (
    assetId: string,
    width: number,
    height: number,
  ) => {
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
      const existingWidth =
        existingOverride.width ?? existingAsset?.width ?? null;
      const existingHeight =
        existingOverride.height ?? existingAsset?.height ?? null;

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
            aria-label="Jump to date"
          >
            <Calendar size={16} />
            Jump to Date
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
          <div ref={topSentinelRef} className="h-px" />
          <div
            className="relative"
            style={{ height: `${Math.max(totalContentHeight, 1)}px` }}
          >
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
                      return null;
                    }

                    return (
                      <article
                        key={asset.id}
                        className="overflow-hidden bg-base-300 flex-none"
                        style={{
                          width: `${rowItem.width}px`,
                        }}
                      >
                        <AssetThumbnail
                          asset={asset}
                          onOpen={() => {
                            openLightbox(asset.id);
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
                          livePhotoAutoplay={
                            settings?.livePhotoAutoplay ?? true
                          }
                          suppressFullThumbnail={isTimelineScrubbing}
                        />
                      </article>
                    );
                  })}
                </div>
              );
            })}

            <div
              ref={sentinelRef}
              className="absolute left-0 right-0 h-px"
              style={{ top: `${Math.max(totalContentHeight - 1, 0)}px` }}
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
          Loading more assets...
        </p>
      ) : null}
      {!hasNextPage ? (
        <p className="shrink-0 mt-2 text-xs text-base-content/60">
          No more assets to load.
        </p>
      ) : null}

      {activeAsset ? (
        <div
          className="group fixed inset-0 z-9999 flex items-center justify-center bg-black/96 p-6"
          role="dialog"
          aria-modal="true"
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="btn btn-circle btn-sm btn-ghost absolute right-4 top-4 border border-white/20 bg-black/40 text-white"
            aria-label="Close full screen"
            onClick={(event) => {
              event.stopPropagation();
              closeLightbox();
              setIsPlayingLivePhoto(false);
            }}
          >
            <X size={22} />
          </button>

          {activeAsset.livePhotoVideoId && isPlayingLivePhoto ? (
            <button
              type="button"
              className="btn btn-circle btn-sm btn-ghost absolute right-16 top-4 border border-white/20 bg-black/40 text-white"
              aria-label="Play live photo again"
              onClick={(event) => {
                event.stopPropagation();
                setIsPlayingLivePhoto(false);
              }}
            >
              <CirclePlay size={22} />
            </button>
          ) : null}

          <button
            type="button"
            className="btn btn-circle btn-md btn-ghost absolute left-4 top-1/2 -translate-y-1/2 border border-white/20 bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-30"
            aria-label="Previous image"
            onClick={(event) => {
              event.stopPropagation();
              goPrev();
            }}
            disabled={activeIndex === 0}
          >
            <ChevronLeft size={28} />
          </button>

          <button
            type="button"
            className="btn btn-circle btn-md btn-ghost absolute right-4 top-1/2 -translate-y-1/2 border border-white/20 bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-30"
            aria-label="Next image"
            onClick={(event) => {
              event.stopPropagation();
              goNext();
            }}
            disabled={activeIndex === displayAssets.length - 1}
          >
            <ChevronRight size={28} />
          </button>

          <div
            className="pointer-events-none flex h-full w-full max-w-[min(96rem,calc(100vw-4rem))] flex-col items-center justify-center gap-2 py-2"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="pointer-events-auto flex min-h-0 w-full flex-1 items-center justify-center px-12">
              {isVideoAsset(activeAsset) ? (
                activeSrc ? (
                  <video
                    className="max-h-full max-w-full object-contain"
                    src={activeSrc}
                    controls
                    autoPlay
                    playsInline
                    onError={(event) => {
                      const video = event.currentTarget;
                      console.error("[video-fullscreen-error]", {
                        assetId: activeAsset.id,
                        src: video.currentSrc,
                        errorCode: video.error?.code,
                        errorMessage: video.error?.message,
                      });
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2 text-sm text-white/80">
                    <span className="loading loading-spinner loading-sm" />
                    Loading video...
                  </div>
                )
              ) : isPlayingLivePhoto && activeAsset.livePhotoVideoId ? (
                <div
                  className="relative flex items-center justify-center overflow-hidden"
                  style={livePhotoFrameStyle}
                >
                  {activeStillSrc ? (
                    <img
                      className="h-full w-full object-contain"
                      src={activeStillSrc}
                      alt={activeAsset.originalFileName}
                    />
                  ) : null}
                  {activeSrc ? (
                    <video
                      className="absolute inset-0 h-full w-full object-fill"
                      src={activeSrc}
                      autoPlay
                      playsInline
                      onEnded={() => {
                        setIsPlayingLivePhoto(false);
                      }}
                      onError={(event) => {
                        const video = event.currentTarget;
                        console.error("[live-photo-video-error]", {
                          assetId: activeAsset.livePhotoVideoId,
                          src: video.currentSrc,
                          errorCode: video.error?.code,
                          errorMessage: video.error?.message,
                        });
                      }}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                      <span className="loading loading-spinner loading-sm text-white" />
                    </div>
                  )}
                </div>
              ) : activeAsset.livePhotoVideoId ? (
                <div
                  className="flex items-center justify-center"
                  style={livePhotoFrameStyle}
                >
                  <img
                    className="max-h-full max-w-full object-contain"
                    src={activeStillSrc ?? activeSrc ?? ""}
                    alt={activeAsset.originalFileName}
                    onClick={() => {
                      setIsPlayingLivePhoto(true);
                    }}
                  />
                </div>
              ) : (
                <img
                  className="max-h-full max-w-full object-contain"
                  src={activeStillSrc ?? activeSrc ?? ""}
                  alt={activeAsset.originalFileName}
                />
              )}
            </div>

            <div className="pointer-events-auto w-full max-w-5xl">
              <FullscreenMetadataBar
                asset={activeAsset}
                isUpdatingFavorite={favoriteUpdateId === activeAsset.id}
                isUpdatingArchive={archiveUpdateId === activeAsset.id}
                isUpdatingRating={ratingUpdateId === activeAsset.id}
                onToggleFavorite={() => {
                  void handleFavoriteToggle();
                }}
                onToggleArchive={() => {
                  void handleArchiveToggle();
                }}
                onSetRating={(rating) => {
                  void handleRatingChange(rating);
                }}
              />
            </div>

            <div className="pointer-events-auto w-full max-w-5xl rounded-2xl border border-white/10 bg-black/35 px-3 py-2 backdrop-blur-md">
              <FullscreenThumbnailStrip
                assets={displayAssets}
                activeIndex={activeIndex ?? 0}
                onSelect={(index) => {
                  showAssetAtIndex(index, true);
                }}
              />
            </div>
          </div>
        </div>
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

function AssetThumbnail({
  asset,
  onOpen,
  durationSeconds,
  onDuration,
  onDimensions,
  showDebug,
  livePhotoAutoplay,
  suppressFullThumbnail,
}: {
  asset: AssetSummary;
  onOpen: () => void;
  durationSeconds?: number;
  onDuration: (seconds: number) => void;
  onDimensions: (width: number, height: number) => void;
  showDebug: boolean;
  livePhotoAutoplay: boolean;
  suppressFullThumbnail: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [livePhotoVideoSrc, setLivePhotoVideoSrc] = useState<string | null>(
    null,
  );
  const [videoRetryToken, setVideoRetryToken] = useState(0);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [isPlayingLivePhoto, setIsPlayingLivePhoto] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const retryTimeoutRef = useRef<number | null>(null);
  const thumbhashPlaceholderSrc = useMemo(
    () => thumbhashToDataUrl(asset.thumbhash),
    [asset.thumbhash],
  );
  const isVideo = isVideoAsset(asset);
  const isLivePhoto = asset.livePhotoVideoId != null;

  useEffect(() => {
    if (suppressFullThumbnail) {
      return;
    }

    let canceled = false;

    async function load() {
      try {
        const value = await getAssetThumbnail(asset.id);
        if (!canceled) {
          setSrc(value);
        }
      } catch {
        if (!canceled) {
          setSrc(null);
        }
      }
    }

    void load();

    return () => {
      canceled = true;
    };
  }, [asset.id, suppressFullThumbnail]);

  useEffect(() => {
    if (
      suppressFullThumbnail ||
      !isVideo ||
      !isHovering ||
      videoSrc ||
      isVideoLoading
    ) {
      return;
    }

    let cancelled = false;

    async function loadPlayback() {
      setIsVideoLoading(true);
      try {
        const value = await getAssetPlayback(asset.id);
        if (!cancelled) {
          setVideoSrc(toPlayableSrc(value));
          setVideoRetryToken(0);
        }
      } catch {
        if (!cancelled) {
          setVideoSrc(null);
        }
      } finally {
        if (!cancelled) {
          setIsVideoLoading(false);
        }
      }
    }

    void loadPlayback();

    return () => {
      cancelled = true;
    };
  }, [
    asset.id,
    isHovering,
    isVideo,
    isVideoLoading,
    suppressFullThumbnail,
    videoSrc,
  ]);

  // Load live photo video when hovering (if autoplay enabled and not already loaded)
  useEffect(() => {
    if (
      suppressFullThumbnail ||
      !isLivePhoto ||
      !isHovering ||
      livePhotoVideoSrc ||
      isVideoLoading ||
      !livePhotoAutoplay
    ) {
      return;
    }

    let cancelled = false;

    async function loadLivePhotoPlayback() {
      setIsVideoLoading(true);
      try {
        const value = await getAssetPlayback(asset.livePhotoVideoId!);
        if (!cancelled) {
          setLivePhotoVideoSrc(toPlayableSrc(value));
        }
      } catch {
        if (!cancelled) {
          setLivePhotoVideoSrc(null);
        }
      } finally {
        if (!cancelled) {
          setIsVideoLoading(false);
        }
      }
    }

    void loadLivePhotoPlayback();

    return () => {
      cancelled = true;
    };
  }, [
    asset.id,
    asset.livePhotoVideoId,
    isHovering,
    isLivePhoto,
    livePhotoVideoSrc,
    isVideoLoading,
    livePhotoAutoplay,
    suppressFullThumbnail,
  ]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }

    if (isHovering) {
      // For live photos with autoplay enabled, play the video
      if (
        isLivePhoto &&
        livePhotoAutoplay &&
        livePhotoVideoSrc &&
        !isPlayingLivePhoto
      ) {
        setIsPlayingLivePhoto(true);
        void video.play().catch(() => {
          // Ignore autoplay rejection
        });
        return;
      }

      // For regular videos
      if (isVideo && videoSrc) {
        void video.play().catch(() => {
          // Ignore autoplay rejection; user can still click for fullscreen playback.
        });
      }
      return;
    }

    // Mouse left
    video.pause();
    video.currentTime = 0;
    setIsPlayingLivePhoto(false);
  }, [
    isHovering,
    videoSrc,
    videoRetryToken,
    isVideo,
    isLivePhoto,
    livePhotoAutoplay,
    livePhotoVideoSrc,
    isPlayingLivePhoto,
  ]);

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-base-300 text-xs text-base-content/60">
        {thumbhashPlaceholderSrc ? (
          <img
            className="h-full w-full object-cover scale-105 blur-lg opacity-90"
            src={thumbhashPlaceholderSrc}
            alt=""
            aria-hidden="true"
          />
        ) : (
          "Loading preview..."
        )}
      </div>
    );
  }

  if (suppressFullThumbnail) {
    return (
      <button
        type="button"
        className="relative block h-full w-full cursor-zoom-in"
        onClick={onOpen}
        aria-label={`Open ${asset.originalFileName} in full screen`}
      >
        {thumbhashPlaceholderSrc ? (
          <img
            className="h-full w-full object-cover scale-105 blur-lg opacity-90"
            src={thumbhashPlaceholderSrc}
            alt=""
            aria-hidden="true"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-base-300 text-xs text-base-content/60">
            Loading preview...
          </div>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="relative block h-full w-full cursor-zoom-in"
      onClick={onOpen}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => {
        setIsHovering(false);
        setVideoRetryToken(0);
        setIsPlayingLivePhoto(false);
        if (retryTimeoutRef.current !== null) {
          window.clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
      }}
      aria-label={`Open ${asset.originalFileName} in full screen`}
    >
      {isLivePhoto && isHovering && isPlayingLivePhoto && livePhotoVideoSrc ? (
        <video
          ref={previewVideoRef}
          className="h-full w-full object-cover"
          src={livePhotoVideoSrc}
          muted
          autoPlay
          playsInline
          preload="metadata"
          onEnded={() => {
            setIsPlayingLivePhoto(false);
          }}
          onCanPlay={(event) => {
            if (!isHovering) {
              return;
            }

            const video = event.currentTarget;
            video.muted = true;
            void video.play().catch(() => {
              // Autoplay may still be denied on some systems.
            });
          }}
          onError={(event) => {
            const video = event.currentTarget;
            console.error("[live-photo-hover-error]", {
              assetId: asset.livePhotoVideoId,
              src: video.currentSrc,
              errorCode: video.error?.code,
              errorMessage: video.error?.message,
            });
          }}
        />
      ) : isVideo && isHovering && videoSrc ? (
        <video
          ref={previewVideoRef}
          className="h-full w-full object-cover"
          src={
            videoRetryToken > 0 ? `${videoSrc}?r=${videoRetryToken}` : videoSrc
          }
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
          onCanPlay={(event) => {
            if (!isHovering) {
              return;
            }

            const video = event.currentTarget;
            video.muted = true;
            void video.play().catch(() => {
              // Autoplay may still be denied on some systems.
            });
          }}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              onDimensions(video.videoWidth, video.videoHeight);
            }
            if (Number.isFinite(video.duration) && video.duration > 0) {
              onDuration(video.duration);
            }
          }}
          onError={(event) => {
            const video = event.currentTarget;
            console.error("[video-hover-error]", {
              assetId: asset.id,
              src: video.currentSrc,
              errorCode: video.error?.code,
              errorMessage: video.error?.message,
            });

            if (!isHovering) {
              return;
            }

            if (retryTimeoutRef.current !== null) {
              window.clearTimeout(retryTimeoutRef.current);
            }

            retryTimeoutRef.current = window.setTimeout(() => {
              setVideoRetryToken((current) => current + 1);
            }, 250);
          }}
        />
      ) : (
        <img
          className="h-full w-full object-contain transition-transform duration-200 hover:scale-105"
          src={src}
          alt={asset.originalFileName}
          loading="lazy"
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              onDimensions(image.naturalWidth, image.naturalHeight);
            }
          }}
          onClick={() => {
            if (isLivePhoto && !livePhotoAutoplay) {
              setIsPlayingLivePhoto(true);
            }
          }}
        />
      )}

      {isVideo ? (
        <div className="absolute right-1 top-1 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
          <span>{formatVideoDuration(asset.duration, durationSeconds)}</span>
          <CirclePlay size={12} />
        </div>
      ) : null}

      {isLivePhoto ? (
        <div className="absolute right-1 top-1 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
          <Film size={12} />
          <span>LIVE</span>
        </div>
      ) : null}

      {isVideo && isHovering && isVideoLoading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/25">
          <span className="loading loading-spinner loading-sm text-white" />
        </div>
      ) : null}

      {isLivePhoto && isHovering && isVideoLoading && livePhotoAutoplay ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/25">
          <span className="loading loading-spinner loading-sm text-white" />
        </div>
      ) : null}

      {isVideo && showDebug ? (
        <div className="absolute bottom-1 left-1 max-w-[95%] rounded bg-black/70 px-1.5 py-1 text-[10px] leading-tight text-white">
          <div>id: {asset.id.slice(0, 8)}</div>
          <div>type: {asset.type ?? "null"}</div>
          <div>raw duration: {asset.duration ?? "null"}</div>
          <div>
            resolved seconds:{" "}
            {typeof durationSeconds === "number"
              ? durationSeconds.toFixed(2)
              : "null"}
          </div>
          <div>has playback src: {videoSrc ? "yes" : "no"}</div>
        </div>
      ) : null}
    </button>
  );
}

function findFirstEntryAtOrAfter(entries: VirtualEntry[], top: number): number {
  let left = 0;
  let right = entries.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (entries[mid].top < top) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return left;
}

function isVideoAsset(asset: AssetSummary): boolean {
  if ((asset.type ?? "").toUpperCase() === "VIDEO") {
    return true;
  }

  const name = asset.originalFileName.toLowerCase();
  return /(\.mp4|\.mov|\.webm|\.mkv|\.avi|\.m4v)$/.test(name);
}

function formatVideoDuration(
  value: string | null,
  durationSeconds?: number,
): string {
  if (
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    return formatDurationSeconds(Math.round(durationSeconds));
  }

  if (!value) {
    return "0:00";
  }

  const trimmed = value.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number.parseFloat(trimmed);
    return formatDurationSeconds(Math.max(0, Math.round(numeric)));
  }

  if (/^PT/i.test(trimmed)) {
    const isoMatch = trimmed.match(
      /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i,
    );
    if (isoMatch) {
      const hours = Number.parseFloat(isoMatch[1] ?? "0");
      const minutes = Number.parseFloat(isoMatch[2] ?? "0");
      const seconds = Number.parseFloat(isoMatch[3] ?? "0");
      const totalSeconds = Math.round(hours * 3600 + minutes * 60 + seconds);
      if (Number.isFinite(totalSeconds) && totalSeconds > 0) {
        return formatDurationSeconds(totalSeconds);
      }
    }
  }

  const main = trimmed.split(".")[0] ?? "";
  const parts = main
    .split(":")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

  if (parts.length === 0) {
    return "0:00";
  }

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }

  return formatDurationSeconds(seconds);
}

function formatDurationSeconds(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function toPlayableSrc(value: string): string {
  if (value.startsWith("/")) {
    return convertFileSrc(value);
  }

  return value;
}

function getAssetAspectRatio(asset: AssetSummary | null): number {
  if (!asset) {
    return 4 / 3;
  }

  if (asset.width && asset.height && asset.height > 0) {
    return asset.width / asset.height;
  }

  return 4 / 3;
}

const thumbhashDataUrlCache = new Map<string, string>();

function thumbhashToDataUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const cached = thumbhashDataUrlCache.get(value);
  if (cached) {
    return cached;
  }

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const decoded = thumbHashToRGBA(bytes);
    const canvas = document.createElement("canvas");
    canvas.width = decoded.w;
    canvas.height = decoded.h;

    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    const imageData = context.createImageData(decoded.w, decoded.h);
    imageData.data.set(decoded.rgba);
    context.putImageData(imageData, 0, 0);

    const dataUrl = canvas.toDataURL("image/png");
    thumbhashDataUrlCache.set(value, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

function parseDayKey(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return { year, month, day };
}
