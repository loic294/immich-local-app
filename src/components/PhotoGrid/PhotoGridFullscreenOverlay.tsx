import type { CSSProperties, RefObject } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, CirclePlay, Info } from "lucide-react";
import { SelectionActions } from "../Layout/SelectionActions";
import { useI18n } from "../../i18n";
import type { AssetCacheDetails, AssetSummary } from "../../types";
import { CanvasImageViewer } from "./CanvasImageViewer";
import { FullscreenInfoPanel } from "./FullscreenInfoPanel";
import { FullscreenMetadataBar } from "./FullscreenMetadataBar";
import { FullscreenThumbnailStrip } from "./FullscreenThumbnailStrip";
import { ZoomControl } from "./ZoomControl";
import { isVideoAsset } from "./photoGridUtils";

interface PhotoGridFullscreenOverlayProps {
  activeAsset: AssetSummary;
  activeIndex: number;
  displayAssets: AssetSummary[];
  hasNextPage: boolean;
  activeSrc: string | null;
  activeStillSrc: string | null;
  activeFullsizeStillSrc: string | null;
  zoom: number;
  onZoomChange: (value: number) => void;
  isPlayingLivePhoto: boolean;
  onSetIsPlayingLivePhoto: (value: boolean) => void;
  showInfoPanel: boolean;
  onToggleInfoPanel: () => void;
  favoriteUpdateId: string | null;
  archiveUpdateId: string | null;
  ratingUpdateId: string | null;
  descriptionUpdateId: string | null;
  cachedAssetDetails: AssetCacheDetails | null;
  isLoadingCachedDetails: boolean;
  imageContainerRef: RefObject<HTMLDivElement>;
  imageContainerWidth: number;
  imageContainerHeight: number;
  livePhotoFrameStyle: CSSProperties;
  onClose: () => void;
  onGoPrev: () => void;
  onGoNext: () => void;
  onSelectIndex: (index: number) => void;
  onToggleFavorite: () => void;
  onToggleArchive: () => void;
  onSetRating: (rating: number | null) => void;
  onUpdateDescription: (description: string) => void;
}

export function PhotoGridFullscreenOverlay({
  activeAsset,
  activeIndex,
  displayAssets,
  hasNextPage,
  activeSrc,
  activeStillSrc,
  activeFullsizeStillSrc,
  zoom,
  onZoomChange,
  isPlayingLivePhoto,
  onSetIsPlayingLivePhoto,
  showInfoPanel,
  onToggleInfoPanel,
  favoriteUpdateId,
  archiveUpdateId,
  ratingUpdateId,
  descriptionUpdateId,
  cachedAssetDetails,
  isLoadingCachedDetails,
  imageContainerRef,
  imageContainerWidth,
  imageContainerHeight,
  livePhotoFrameStyle,
  onClose,
  onGoPrev,
  onGoNext,
  onSelectIndex,
  onToggleFavorite,
  onToggleArchive,
  onSetRating,
  onUpdateDescription,
}: PhotoGridFullscreenOverlayProps) {
  const { t } = useI18n();

  return (
    <div
      className="group fixed inset-0 z-9999 flex items-center justify-center bg-black p-6"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="btn btn-circle btn-sm btn-ghost absolute left-4 top-4 border border-white/15 bg-zinc-900 text-white"
        aria-label={t("photoGrid.backAria")}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
          onSetIsPlayingLivePhoto(false);
        }}
      >
        <ArrowLeft size={20} />
      </button>

      <div
        className="pointer-events-auto absolute top-4 left-1/2 z-40 max-w-[min(70vw,48rem)] -translate-x-1/2 rounded-xl px-4 py-1.5 text-sm font-medium text-white/95 select-text"
        onClick={(event) => event.stopPropagation()}
      >
        {activeAsset.originalFileName}
      </div>

      <div className="pointer-events-auto absolute right-4 top-4 z-40 flex items-center gap-2">
        {activeAsset.livePhotoVideoId && isPlayingLivePhoto ? (
          <button
            type="button"
            className="btn btn-circle btn-sm btn-ghost border border-white/15 bg-zinc-900 text-white"
            aria-label={t("photoGrid.playLiveAgainAria")}
            onClick={(event) => {
              event.stopPropagation();
              onSetIsPlayingLivePhoto(false);
            }}
          >
            <CirclePlay size={20} />
          </button>
        ) : null}

        {!isVideoAsset(activeAsset) ? (
          <>
            <div className="w-px bg-white/10" />
            <div onClick={(event) => event.stopPropagation()}>
              <ZoomControl zoomLevel={zoom} onZoomChange={onZoomChange} />
            </div>
          </>
        ) : null}

        <div className="h-4 border-l border-white/25" />
        <SelectionActions
          selectedAssetIds={[activeAsset.id]}
          selectedCount={1}
          variant="preview"
          modalZIndexClass="z-[10010]"
          stopPropagation
          disableCopy={isVideoAsset(activeAsset)}
        />

        <button
          type="button"
          className={`btn btn-sm border border-white/15 ${showInfoPanel ? "bg-white text-black hover:bg-white" : "bg-zinc-900 text-white"}`}
          aria-label={t("photoGrid.toggleInfoAria")}
          onClick={(event) => {
            event.stopPropagation();
            onToggleInfoPanel();
          }}
        >
          <Info size={16} />
          {t("photoGrid.info")}
        </button>
      </div>

      <div
        className="pointer-events-none flex h-full w-full items-stretch gap-4 pt-16"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <button
            type="button"
            className="pointer-events-auto btn btn-circle btn-md btn-ghost absolute left-2 top-1/2 z-30 -translate-y-1/2 border border-white/15 bg-zinc-900 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-30"
            aria-label={t("photoGrid.previousImageAria")}
            onClick={(event) => {
              event.stopPropagation();
              onGoPrev();
            }}
            disabled={activeIndex === 0}
          >
            <ChevronLeft size={28} />
          </button>

          <button
            type="button"
            className="pointer-events-auto btn btn-circle btn-md btn-ghost absolute right-2 top-1/2 z-30 -translate-y-1/2 border border-white/15 bg-zinc-900 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-30"
            aria-label={t("photoGrid.nextImageAria")}
            onClick={(event) => {
              event.stopPropagation();
              onGoNext();
            }}
            disabled={activeIndex === displayAssets.length - 1 && !hasNextPage}
          >
            <ChevronRight size={28} />
          </button>

          <div
            ref={imageContainerRef}
            className="pointer-events-auto flex min-h-0 w-full flex-1 items-center justify-center px-12"
          >
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
                  {t("photoGrid.loadingVideo")}
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
                      onSetIsPlayingLivePhoto(false);
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
              <div className="flex items-center justify-center" style={livePhotoFrameStyle}>
                <img
                  className="max-h-full max-w-full object-contain"
                  src={activeStillSrc ?? activeSrc ?? ""}
                  alt={activeAsset.originalFileName}
                  onClick={() => {
                    onSetIsPlayingLivePhoto(true);
                  }}
                />
              </div>
            ) : (
              <div className="relative flex h-full w-full items-center justify-center">
                <CanvasImageViewer
                  assetId={activeAsset.id}
                  src={activeFullsizeStillSrc ?? activeStillSrc ?? activeSrc ?? ""}
                  alt={activeAsset.originalFileName}
                  zoom={zoom}
                  onZoomChange={onZoomChange}
                  containerWidth={imageContainerWidth}
                  containerHeight={imageContainerHeight}
                  onNavigate={(direction) => {
                    if (direction === "next") {
                      onGoNext();
                    } else {
                      onGoPrev();
                    }
                  }}
                />
                {zoom === 100 && (activeStillSrc ?? activeSrc) ? (
                  <img
                    className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                    src={activeStillSrc ?? activeSrc ?? ""}
                    alt={activeAsset.originalFileName}
                  />
                ) : null}
              </div>
            )}
          </div>

          <div className="pointer-events-auto mx-auto w-full max-w-5xl">
            <FullscreenMetadataBar
              asset={activeAsset}
              isUpdatingFavorite={favoriteUpdateId === activeAsset.id}
              isUpdatingArchive={archiveUpdateId === activeAsset.id}
              isUpdatingRating={ratingUpdateId === activeAsset.id}
              onToggleFavorite={onToggleFavorite}
              onToggleArchive={onToggleArchive}
              onSetRating={onSetRating}
            />
          </div>

          <div className="pointer-events-auto mx-auto w-full max-w-5xl">
            <FullscreenThumbnailStrip
              assets={displayAssets}
              activeIndex={activeIndex}
              onSelect={onSelectIndex}
            />
          </div>
        </div>

        {showInfoPanel ? (
          <FullscreenInfoPanel
            asset={activeAsset}
            details={cachedAssetDetails}
            isLoading={isLoadingCachedDetails}
            isUpdatingDescription={descriptionUpdateId === activeAsset.id}
            onUpdateDescription={onUpdateDescription}
          />
        ) : null}
      </div>
    </div>
  );
}
