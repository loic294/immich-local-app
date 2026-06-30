import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Check, CirclePlay, Film, Heart } from "lucide-react";
import { getAssetPlayback, getAssetThumbnail, isThumbnailCached } from "../../api/tauri";
import { useI18n } from "../../i18n";
import type { AssetSummary } from "../../types";
import type { JumpMetrics } from "./PhotoGrid.types";
import {
  formatVideoDuration,
  isVideoAsset,
  thumbhashToDataUrl,
  toPlayableSrc,
} from "./photoGridUtils";

interface AssetThumbnailProps {
  asset: AssetSummary;
  isSelected: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  onToggleSelection: (event: MouseEvent<HTMLDivElement>) => void;
  durationSeconds?: number;
  onDuration: (seconds: number) => void;
  onDimensions: (width: number, height: number) => void;
  showDebug: boolean;
  livePhotoAutoplay: boolean;
  suppressFullThumbnail: boolean;
  jumpMetrics: JumpMetrics | null;
}

export function AssetThumbnail({
  asset,
  isSelected,
  onOpen,
  onToggleSelection,
  durationSeconds,
  onDuration,
  onDimensions,
  showDebug,
  livePhotoAutoplay,
  suppressFullThumbnail,
  jumpMetrics,
}: AssetThumbnailProps) {
  const { t } = useI18n();
  const [src, setSrc] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [livePhotoVideoSrc, setLivePhotoVideoSrc] = useState<string | null>(null);
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
  const thumbnailFetchStartedAtRef = useRef<number | null>(null);
  const fullImageReadyLoggedRef = useRef(false);

  useEffect(() => {
    fullImageReadyLoggedRef.current = false;
  }, [asset.id, src]);

  useLayoutEffect(() => {
    if (suppressFullThumbnail) {
      return;
    }

    const cached = isThumbnailCached(asset.id);
    if (cached) {
      setSrc(cached);
      return;
    }

    let canceled = false;

    async function load() {
      try {
        thumbnailFetchStartedAtRef.current = performance.now();
        const value = await getAssetThumbnail(asset.id);
        if (!canceled) {
          setSrc(value);
          const fetchDurationMs = Math.round(
            performance.now() - (thumbnailFetchStartedAtRef.current ?? performance.now()),
          );

          if (fetchDurationMs >= 150 || jumpMetrics) {
            console.log("[AssetThumbnail] fetch done", {
              assetId: asset.id,
              fileName: asset.originalFileName,
              fetchDurationMs,
              duringJump: Boolean(jumpMetrics),
              jumpId: jumpMetrics?.jumpId ?? null,
              jumpDateKey: jumpMetrics?.dateKey ?? null,
              jumpElapsedMs: jumpMetrics
                ? Math.round(performance.now() - jumpMetrics.startedAtMs)
                : null,
            });
          }
        }
      } catch (error) {
        if (!canceled) {
          setSrc(null);
          console.warn("[AssetThumbnail] fetch failed", {
            assetId: asset.id,
            fileName: asset.originalFileName,
            duringJump: Boolean(jumpMetrics),
            jumpId: jumpMetrics?.jumpId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    void load();

    return () => {
      canceled = true;
    };
  }, [asset.id, asset.originalFileName, jumpMetrics, suppressFullThumbnail]);

  useEffect(() => {
    if (suppressFullThumbnail || !isVideo || !isHovering || videoSrc || isVideoLoading) {
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
  }, [asset.id, isHovering, isVideo, isVideoLoading, suppressFullThumbnail, videoSrc]);

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
      if (isLivePhoto && livePhotoAutoplay && livePhotoVideoSrc && !isPlayingLivePhoto) {
        setIsPlayingLivePhoto(true);
        void video.play().catch(() => {
          // Ignore autoplay rejection
        });
        return;
      }

      if (isVideo && videoSrc) {
        void video.play().catch(() => {
          // Ignore autoplay rejection; user can still click for fullscreen playback.
        });
      }
      return;
    }

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
          t("photoGrid.loadingPreview")
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
        aria-label={t("photoGrid.openFullscreenAria", {
          name: asset.originalFileName,
        })}
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
            {t("photoGrid.loadingPreview")}
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
      aria-label={t("photoGrid.openFullscreenAria", {
        name: asset.originalFileName,
      })}
    >
      <div
        role="button"
        tabIndex={-1}
        aria-label={isSelected ? t("photoGrid.deselectPhotoAria") : t("photoGrid.selectPhotoAria")}
        aria-pressed={isSelected}
        className={`absolute left-1 top-1 z-20 flex h-5 w-5 cursor-pointer items-center justify-center rounded border text-[10px] transition ${
          isSelected
            ? "border-primary bg-primary text-primary-content opacity-100"
            : "border-white/70 bg-black/45 text-white opacity-0 group-hover:opacity-100"
        }`}
        onClick={onToggleSelection}
      >
        {isSelected ? <Check size={12} /> : null}
      </div>

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
          src={videoRetryToken > 0 ? `${videoSrc}?r=${videoRetryToken}` : videoSrc}
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

            if (!fullImageReadyLoggedRef.current) {
              fullImageReadyLoggedRef.current = true;
              console.log("[AssetThumbnail] image rendered", {
                assetId: asset.id,
                fileName: asset.originalFileName,
                width: image.naturalWidth,
                height: image.naturalHeight,
                duringJump: Boolean(jumpMetrics),
                jumpId: jumpMetrics?.jumpId ?? null,
                jumpDateKey: jumpMetrics?.dateKey ?? null,
                jumpElapsedMs: jumpMetrics
                  ? Math.round(performance.now() - jumpMetrics.startedAtMs)
                  : null,
              });
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
          <span>{t("photoGrid.liveBadge")}</span>
        </div>
      ) : null}

      {asset.isFavorite ? (
        <div className="absolute bottom-1 right-1 z-10 text-error" aria-hidden="true">
          <Heart size={14} fill="currentColor" />
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
            {typeof durationSeconds === "number" ? durationSeconds.toFixed(2) : "null"}
          </div>
          <div>has playback src: {videoSrc ? "yes" : "no"}</div>
        </div>
      ) : null}
    </button>
  );
}
