import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Film,
  X,
  Calendar,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FullscreenMetadataBar } from "./FullscreenMetadataBar";
import { FullscreenThumbnailStrip } from "./FullscreenThumbnailStrip";
import { DatePickerModal } from "./DatePickerModal";
import type {
  GridLayoutSection,
  AssetSummary,
  AssetVisibility,
  Settings,
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
  const [showDatePicker, setShowDatePicker] = useState(false);
  const sectionRefsMap = useRef<Map<string, HTMLElement | null>>(new Map());

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
    () => gridSections.map((section) => section.key),
    [gridSections],
  );

  const jumpToDate = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const targetKey = `${year}-${month}-${day}`;

    const sectionRef = sectionRefsMap.current.get(targetKey);
    if (sectionRef && viewportRef.current) {
      sectionRef.scrollIntoView({ behavior: "smooth", block: "start" });
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

  return (
    <section>
      <div className="mb-1 flex items-center justify-between text-xs text-base-content/60">
        <span>{loadedCountText}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm gap-1"
          onClick={() => setShowDatePicker(true)}
          aria-label="Jump to date"
        >
          <Calendar size={16} />
          Jump to Date
        </button>
      </div>

      <div className="relative">
        <div
          ref={viewportRef}
          className="h-[calc(100vh-180px)] overflow-auto pr-2"
        >
          <div className="flex flex-col gap-2.5">
            {gridSections.map((section) => (
              <section
                key={section.key}
                ref={(el) => {
                  if (el) {
                    sectionRefsMap.current.set(section.key, el);
                  }
                }}
                className="flex flex-col gap-1"
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
                      {row.items.map((rowItem) => {
                        const asset = assetsById.get(rowItem.id);
                        if (!asset) {
                          return null;
                        }

                        return (
                          <article
                            key={asset.id}
                            className="overflow-hidden bg-base-300"
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
                              showDebug={showVideoDebug}
                              livePhotoAutoplay={
                                settings?.livePhotoAutoplay ?? true
                              }
                            />
                          </article>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div ref={sentinelRef} className="h-px" />
        </div>
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
      <DatePickerModal
        isOpen={showDatePicker}
        onClose={() => setShowDatePicker(false)}
        onSelectDate={jumpToDate}
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
  showDebug,
  livePhotoAutoplay,
}: {
  asset: AssetSummary;
  onOpen: () => void;
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

function getAssetAspectRatio(asset: AssetSummary | null): number {
  if (!asset) {
    return 4 / 3;
  }

  if (asset.width && asset.height && asset.height > 0) {
    return asset.width / asset.height;
  }

  return 4 / 3;
}
