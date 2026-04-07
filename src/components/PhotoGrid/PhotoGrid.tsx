import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CirclePlay, Film, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FullscreenMetadataBar } from "./FullscreenMetadataBar";
import { FullscreenThumbnailStrip } from "./FullscreenThumbnailStrip";
import type {
  AssetSummary,
  AssetVisibility,
  TimelineMonths,
  Settings,
} from "../../types";
import {
  fetchTimelineMonths,
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
  hasNextPage: boolean;
  onLoadMore: () => void;
};

export function PhotoGrid({
  assets,
  isFetching,
  hasNextPage,
  onLoadMore,
}: PhotoGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [activeSrc, setActiveSrc] = useState<string | null>(null);
  const [activeStillSrc, setActiveStillSrc] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [assetRatios, setAssetRatios] = useState<Record<string, number>>({});
  const [videoDurations, setVideoDurations] = useState<Record<string, number>>(
    {},
  );
  const [showVideoDebug, setShowVideoDebug] = useState(false);
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null);
  const [scrollThumbHeight, setScrollThumbHeight] = useState(28);
  const [timelineMonths, setTimelineMonths] = useState<TimelineMonths | null>(
    null,
  );
  const [settings, setSettings] = useState<Settings | null>(null);
  const [assetOverrides, setAssetOverrides] = useState<
    Record<string, Partial<AssetSummary>>
  >({});
  const [isPlayingLivePhoto, setIsPlayingLivePhoto] = useState(false);
  const [shouldAutoplayLivePhoto, setShouldAutoplayLivePhoto] = useState(false);
  const [favoriteUpdateId, setFavoriteUpdateId] = useState<string | null>(null);
  const [archiveUpdateId, setArchiveUpdateId] = useState<string | null>(null);
  const [ratingUpdateId, setRatingUpdateId] = useState<string | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const isScrubbingRef = useRef(false);

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
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && hasNextPage && !isFetching) {
          onLoadMore();
        }
      },
      {
        root: viewportRef.current,
        rootMargin: "600px 0px",
      },
    );

    observer.observe(sentinelRef.current);

    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetching, onLoadMore]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setViewportWidth(element.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let canceled = false;

    async function loadTimelineMonths() {
      try {
        const data = await fetchTimelineMonths();
        if (!canceled) {
          setTimelineMonths(data);
        }
      } catch {
        if (!canceled) {
          setTimelineMonths(null);
        }
      }
    }

    void loadTimelineMonths();

    return () => {
      canceled = true;
    };
  }, [assets.length]);

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

  const sections = useMemo(() => {
    return groupAssetsByDay(displayAssets);
  }, [displayAssets]);

  const justifiedSections = useMemo(() => {
    return sections.map((section) => ({
      ...section,
      rows: buildJustifiedRows(section.items, viewportWidth, assetRatios),
    }));
  }, [assetRatios, sections, viewportWidth]);

  const timelineBounds = useMemo(() => {
    if (!timelineMonths?.newestMonth || !timelineMonths?.oldestMonth) {
      return null;
    }

    const newestIndex = getMonthIndexFromMonthKey(timelineMonths.newestMonth);
    const oldestIndex = getMonthIndexFromMonthKey(timelineMonths.oldestMonth);
    if (
      newestIndex === null ||
      oldestIndex === null ||
      newestIndex < oldestIndex
    ) {
      return null;
    }

    return {
      newestIndex,
      oldestIndex,
      range: Math.max(1, newestIndex - oldestIndex),
    };
  }, [timelineMonths]);

  const monthDots = useMemo(() => {
    if (!timelineBounds || !timelineMonths) {
      return [];
    }

    return timelineMonths.months
      .map((monthKey) => {
        const index = getMonthIndexFromMonthKey(monthKey);
        if (index === null) {
          return null;
        }

        const clamped = Math.min(
          timelineBounds.newestIndex,
          Math.max(timelineBounds.oldestIndex, index),
        );
        const ratio =
          (timelineBounds.newestIndex - clamped) / timelineBounds.range;
        return {
          monthKey,
          ratio,
        };
      })
      .filter(
        (dot): dot is { monthKey: string; ratio: number } => dot !== null,
      );
  }, [timelineBounds, timelineMonths]);

  const yearMarkers = useMemo(() => {
    if (
      !timelineBounds ||
      !timelineMonths?.newestMonth ||
      !timelineMonths?.oldestMonth
    ) {
      return [];
    }

    const newestYear = Number.parseInt(
      timelineMonths.newestMonth.slice(0, 4),
      10,
    );
    const oldestYear = Number.parseInt(
      timelineMonths.oldestMonth.slice(0, 4),
      10,
    );
    if (Number.isNaN(newestYear) || Number.isNaN(oldestYear)) {
      return [];
    }

    const markers: Array<{ year: number; ratio: number }> = [];
    for (let year = newestYear; year >= oldestYear; year -= 1) {
      const januaryIndex = getMonthIndexFromParts(year, 1);
      if (januaryIndex === null) {
        continue;
      }

      const clamped = Math.min(
        timelineBounds.newestIndex,
        Math.max(timelineBounds.oldestIndex, januaryIndex),
      );
      const ratio =
        (timelineBounds.newestIndex - clamped) / timelineBounds.range;
      markers.push({ year, ratio });
    }

    return markers;
  }, [timelineBounds, timelineMonths]);

  const currentMonthLabel = useMemo(() => {
    if (!activeSectionKey) {
      return null;
    }

    return getMonthYearLabelFromKey(activeSectionKey);
  }, [activeSectionKey]);

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

  useEffect(() => {
    if (sections.length > 0 && !activeSectionKey) {
      setActiveSectionKey(sections[0].key);
    }
  }, [activeSectionKey, sections]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || sections.length === 0) {
      return;
    }

    const updateActiveSection = () => {
      const nextThumbHeight = Math.max(
        24,
        Math.round(
          (viewport.clientHeight / Math.max(1, viewport.scrollHeight)) *
            viewport.clientHeight,
        ),
      );
      setScrollThumbHeight((prev) =>
        prev === nextThumbHeight ? prev : nextThumbHeight,
      );

      const threshold = viewport.scrollTop + 56;
      let currentKey = sections[0].key;

      for (const section of sections) {
        const element = sectionRefs.current[section.key];
        if (!element) {
          continue;
        }

        if (element.offsetTop <= threshold) {
          currentKey = section.key;
        } else {
          break;
        }
      }

      setActiveSectionKey((prev) => (prev === currentKey ? prev : currentKey));
    };

    updateActiveSection();
    viewport.addEventListener("scroll", updateActiveSection, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", updateActiveSection);
    };
  }, [sections]);

  const timelineProgress = useMemo(() => {
    if (!timelineBounds || !activeSectionKey) {
      return 0;
    }

    const activeMonthIndex = getMonthIndexFromSectionKey(activeSectionKey);
    if (activeMonthIndex === null) {
      return 0;
    }

    const clamped = Math.min(
      timelineBounds.newestIndex,
      Math.max(timelineBounds.oldestIndex, activeMonthIndex),
    );
    return (timelineBounds.newestIndex - clamped) / timelineBounds.range;
  }, [activeSectionKey, timelineBounds]);

  const scrubberThumbTop = useMemo(() => {
    const trackHeight = scrubberRef.current?.clientHeight ?? 0;
    const maxTop = Math.max(0, trackHeight - scrollThumbHeight);
    return maxTop * timelineProgress;
  }, [scrollThumbHeight, timelineProgress]);

  const jumpToProgress = (
    nextProgress: number,
    behavior: ScrollBehavior = "auto",
  ) => {
    const viewport = viewportRef.current;
    if (!viewport || !timelineBounds || sections.length === 0) {
      return;
    }

    const clamped = Math.max(0, Math.min(1, nextProgress));
    const targetMonthIndex = Math.round(
      timelineBounds.newestIndex - clamped * timelineBounds.range,
    );

    let nearestSection: { key: string; distance: number } | null = null;
    for (const section of sections) {
      const monthIndex = getMonthIndexFromSectionKey(section.key);
      if (monthIndex === null) {
        continue;
      }

      const distance = Math.abs(monthIndex - targetMonthIndex);
      if (!nearestSection || distance < nearestSection.distance) {
        nearestSection = { key: section.key, distance };
      }
    }

    if (!nearestSection) {
      return;
    }

    const target = sectionRefs.current[nearestSection.key];
    if (!target) {
      return;
    }

    viewport.scrollTo({
      top: Math.max(0, target.offsetTop - 48),
      behavior,
    });
  };

  const jumpToClientY = (
    clientY: number,
    behavior: ScrollBehavior = "auto",
  ) => {
    const track = scrubberRef.current;
    if (!track) {
      return;
    }

    const rect = track.getBoundingClientRect();
    const y = clientY - rect.top;
    jumpToProgress(y / Math.max(1, rect.height), behavior);
  };

  const activeAssetRatio = activeAsset
    ? getAssetRatio(activeAsset.id, assetRatios)
    : 4 / 3;
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

  return (
    <section>
      <div className="mb-1 text-xs text-base-content/60">{loadedCountText}</div>

      <div className="relative">
        <div
          ref={viewportRef}
          className="h-[calc(100vh-180px)] overflow-auto pr-14 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          <div className="flex flex-col gap-2.5">
            {justifiedSections.map((section) => (
              <section
                key={section.key}
                className="flex flex-col gap-1"
                ref={(node) => {
                  sectionRefs.current[section.key] = node;
                }}
              >
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-base-200 pt-5 pb-3 text-sm font-semibold text-base-content/80">
                  <span>{section.label}</span>
                  <div className="h-px flex-1 bg-base-300" />
                </div>

                <div className="flex flex-col gap-1">
                  {section.rows.map((row, rowIndex) => (
                    <div
                      key={`${section.key}-${rowIndex}`}
                      className="flex gap-1"
                      style={{ height: `${row.height}px` }}
                    >
                      {row.items.map((asset) => (
                        <article
                          key={asset.id}
                          className="overflow-hidden bg-base-300"
                          style={{
                            width: `${row.height * getAssetRatio(asset.id, assetRatios)}px`,
                          }}
                        >
                          <AssetThumbnail
                            asset={asset}
                            onOpen={() => {
                              openLightbox(asset.id);
                            }}
                            onRatio={(ratio) => {
                              setAssetRatios((current) => {
                                const existing = current[asset.id];
                                if (
                                  existing &&
                                  Math.abs(existing - ratio) < 0.01
                                ) {
                                  return current;
                                }

                                return {
                                  ...current,
                                  [asset.id]: ratio,
                                };
                              });
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
                            showDebug={showVideoDebug}
                            livePhotoAutoplay={
                              settings?.livePhotoAutoplay ?? true
                            }
                          />
                        </article>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div ref={sentinelRef} className="h-px" />
        </div>

        <aside className="absolute inset-y-2 right-0 hidden w-14 xl:block">
          <div ref={scrubberRef} className="relative h-full">
            <div
              role="slider"
              aria-label="Timeline scrollbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(timelineProgress * 100)}
              className="absolute inset-0 cursor-ns-resize select-none touch-none"
              onPointerDown={(event) => {
                isScrubbingRef.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                jumpToClientY(event.clientY, "auto");
              }}
              onPointerMove={(event) => {
                if (!isScrubbingRef.current) {
                  return;
                }
                jumpToClientY(event.clientY, "auto");
              }}
              onPointerUp={(event) => {
                if (isScrubbingRef.current) {
                  jumpToClientY(event.clientY, "auto");
                }
                isScrubbingRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={(event) => {
                isScrubbingRef.current = false;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
            />

            <div className="absolute right-5 top-0 h-full w-px bg-primary/35" />

            {monthDots.map((dot) => (
              <span
                key={dot.monthKey}
                className="absolute right-4 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary/55"
                style={{ top: `${dot.ratio * 100}%` }}
              />
            ))}

            <div
              className="absolute right-3.75 w-0.75 rounded-full bg-primary"
              style={{
                top: `${scrubberThumbTop}px`,
                height: `${scrollThumbHeight}px`,
              }}
            />

            {currentMonthLabel ? (
              <div
                className="badge badge-sm badge-outline absolute right-0 pointer-events-none border-primary/40 bg-base-100 text-[11px] font-medium text-base-content/80"
                style={{ top: `${Math.max(4, scrubberThumbTop - 8)}px` }}
              >
                {currentMonthLabel}
              </div>
            ) : null}

            <div className="absolute inset-0">
              {yearMarkers.map((marker) => {
                const topPercent = marker.ratio * 100;
                const isActiveYear =
                  activeSectionKey !== null &&
                  getYearFromKey(activeSectionKey) === marker.year;

                return (
                  <div
                    key={marker.year}
                    className="absolute right-0 -translate-y-1/2"
                    style={{ top: `${topPercent}%` }}
                  >
                    <button
                      type="button"
                      className={`mr-1 rounded px-1 text-xs transition-colors ${
                        isActiveYear
                          ? "font-semibold text-primary"
                          : "text-base-content/60 hover:text-base-content"
                      }`}
                      onClick={() => {
                        if (!timelineBounds) {
                          return;
                        }

                        const yearStart = getMonthIndexFromParts(
                          marker.year,
                          1,
                        );
                        if (yearStart === null) {
                          return;
                        }

                        const clamped = Math.min(
                          timelineBounds.newestIndex,
                          Math.max(timelineBounds.oldestIndex, yearStart),
                        );
                        const progress =
                          (timelineBounds.newestIndex - clamped) /
                          timelineBounds.range;
                        jumpToProgress(progress, "smooth");
                      }}
                    >
                      {marker.year}
                    </button>
                    <span
                      className={`absolute -left-1.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full ${
                        isActiveYear ? "bg-primary" : "bg-primary/50"
                      }`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      {isFetching ? (
        <p className="mt-2 text-xs text-base-content/60">
          Loading more assets...
        </p>
      ) : null}
      {!hasNextPage ? (
        <p className="mt-2 text-xs text-base-content/60">
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
    </section>
  );
}
function groupAssetsByDay(
  assets: AssetSummary[],
): Array<{ key: string; label: string; items: AssetSummary[] }> {
  const sections: Array<{ key: string; label: string; items: AssetSummary[] }> =
    [];
  let currentKey = "";
  let currentLabel = "";
  let currentItems: AssetSummary[] = [];

  for (const asset of assets) {
    const { key, label } = getAssetDay(asset.fileCreatedAt);

    if (currentKey === "") {
      currentKey = key;
      currentLabel = label;
    }

    if (key !== currentKey) {
      sections.push({
        key: currentKey,
        label: currentLabel,
        items: currentItems,
      });
      currentKey = key;
      currentLabel = label;
      currentItems = [];
    }

    currentItems.push(asset);
  }

  if (currentItems.length > 0) {
    sections.push({
      key: currentKey,
      label: currentLabel,
      items: currentItems,
    });
  }

  return sections;
}

function getAssetDay(fileCreatedAt: string | null): {
  key: string;
  label: string;
} {
  if (!fileCreatedAt) {
    return { key: "unknown", label: "Unknown date" };
  }

  const date = new Date(fileCreatedAt);
  if (Number.isNaN(date.getTime())) {
    return { key: "unknown", label: "Unknown date" };
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const key = `${y}-${m}-${d}`;

  const today = new Date();
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const dateStart = new Date(y, date.getMonth(), date.getDate());
  const diffMs = todayStart.getTime() - dateStart.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);

  let label: string;
  if (diffDays === 0) {
    label = "Today";
  } else if (diffDays === 1) {
    label = "Yesterday";
  } else {
    label = date.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return { key, label };
}

function AssetThumbnail({
  asset,
  onOpen,
  onRatio,
  durationSeconds,
  onDuration,
  showDebug,
  livePhotoAutoplay,
}: {
  asset: AssetSummary;
  onOpen: () => void;
  onRatio: (ratio: number) => void;
  durationSeconds?: number;
  onDuration: (seconds: number) => void;
  showDebug: boolean;
  livePhotoAutoplay: boolean;
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
  const isVideo = isVideoAsset(asset);
  const isLivePhoto = asset.livePhotoVideoId != null;

  useEffect(() => {
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
  }, [asset.id]);

  useEffect(() => {
    if (!isVideo || !isHovering || videoSrc || isVideoLoading) {
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
  }, [asset.id, isHovering, isVideo, isVideoLoading, videoSrc]);

  // Load live photo video when hovering (if autoplay enabled and not already loaded)
  useEffect(() => {
    if (
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
        Loading preview...
      </div>
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
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              onRatio(video.videoWidth / video.videoHeight);
            }
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
              onRatio(video.videoWidth / video.videoHeight);
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
              onRatio(image.naturalWidth / image.naturalHeight);
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

function getAssetRatio(
  assetId: string,
  ratios: Record<string, number>,
): number {
  return ratios[assetId] ?? 4 / 3;
}

function buildJustifiedRows(
  items: AssetSummary[],
  containerWidth: number,
  ratios: Record<string, number>,
): Array<{ items: AssetSummary[]; height: number }> {
  if (containerWidth <= 0 || items.length === 0) {
    return [];
  }

  const gap = 4;
  const targetRowHeight = containerWidth < 700 ? 120 : 210;
  const rows: Array<{ items: AssetSummary[]; height: number }> = [];

  let rowItems: AssetSummary[] = [];
  let rowRatioSum = 0;

  for (const item of items) {
    const ratio = getAssetRatio(item.id, ratios);
    rowItems.push(item);
    rowRatioSum += ratio;

    const projectedWidth =
      rowRatioSum * targetRowHeight + gap * (rowItems.length - 1);
    if (projectedWidth >= containerWidth && rowItems.length > 1) {
      const height = Math.max(
        90,
        Math.min(
          280,
          (containerWidth - gap * (rowItems.length - 1)) / rowRatioSum,
        ),
      );
      rows.push({ items: rowItems, height });
      rowItems = [];
      rowRatioSum = 0;
    }
  }

  if (rowItems.length > 0) {
    rows.push({
      items: rowItems,
      height: targetRowHeight,
    });
  }

  return rows;
}

function getYearFromKey(key: string): number | null {
  const yearPart = key.split("-")[0];
  const year = Number.parseInt(yearPart ?? "", 10);
  return Number.isNaN(year) ? null : year;
}

function getMonthIndexFromParts(year: number, month: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return null;
  }

  if (month < 1 || month > 12) {
    return null;
  }

  return year * 12 + (month - 1);
}

function getMonthIndexFromMonthKey(key: string): number | null {
  const [yearRaw, monthRaw] = key.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  if (Number.isNaN(year) || Number.isNaN(month)) {
    return null;
  }

  return getMonthIndexFromParts(year, month);
}

function getMonthIndexFromSectionKey(key: string): number | null {
  const [yearRaw, monthRaw] = key.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  if (Number.isNaN(year) || Number.isNaN(month)) {
    return null;
  }

  return getMonthIndexFromParts(year, month);
}

function getMonthYearLabelFromKey(key: string): string {
  const [yearRaw, monthRaw, dayRaw] = key.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  const day = Number.parseInt(dayRaw ?? "", 10);

  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    month < 1 ||
    month > 12
  ) {
    return "";
  }

  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}
