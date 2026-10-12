import type { CSSProperties, RefObject } from "react";
import React from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Info,
  MoreHorizontal,
  Clock,
  Pencil,
  HardDrive,
} from "lucide-react";
import { SelectionActions } from "../Layout/SelectionActions";
import { useI18n } from "../../i18n";
import type { AssetCacheDetails, AssetSummary } from "../../types";
import {
  copyAssetsToLocalFolder,
  getCachedAssetDetails,
  getSettings,
  openFolderInFileExplorer,
  isThumbnailCached,
  removeLocalOriginal,
} from "../../api/tauri";
import { CanvasImageViewer } from "./CanvasImageViewer";
import { FullscreenInfoPanel } from "./FullscreenInfoPanel";
import { FullscreenMetadataBar } from "./FullscreenMetadataBar";
import { FullscreenThumbnailStrip } from "./FullscreenThumbnailStrip";
import { ZoomControl } from "./ZoomControl";
import { isVideoAsset } from "./photoGridUtils";
import { useAssetState } from "../../hooks/useAssetState";
import { AssetStatusBadge } from "./AssetStatusBadge";
import { LocalOriginalRemovalDialog } from "./LocalOriginalRemovalDialog";
import { EditImportPill } from "../Media/EditImportPill";
import { requestMediaEdit, getMediaEditState, subscribeMediaEditState } from "../../api/media";
import { requestFixTime } from "../../api/time";
import { useSearchTimeI18n } from "../../i18n/searchTime";
import { useMediaLabels } from "../../i18n/media";
import { isMacPlatform } from "../../utils/platform";

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
  onLocalOriginalRemoved: (assetId: string) => void;
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
  activeStillSrc: incomingStillSrc,
  activeFullsizeStillSrc,
  zoom,
  onZoomChange,
  onLocalOriginalRemoved,
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
  const timeLabels = useSearchTimeI18n();
  const mediaLabels = useMediaLabels();
  const mac = isMacPlatform();
  const moreMenuRef = React.useRef<HTMLDetailsElement>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const editLabelRef = React.useRef<HTMLSpanElement>(null);
  const [showEditLabel, setShowEditLabel] = React.useState(true);
  React.useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const label = editLabelRef.current;
    const header = toolbar?.parentElement;
    if (!toolbar || !label || !header) return;
    const update = () => {
      const gap = Number.parseFloat(getComputedStyle(toolbar).columnGap) || 0;
      const button = label.parentElement!;
      const labelSpace =
        label.getBoundingClientRect().width +
        (Number.parseFloat(getComputedStyle(button).columnGap) || 0);
      const currentWidth =
        Array.from(toolbar.children).reduce(
          (width, child) => width + child.getBoundingClientRect().width,
          0,
        ) +
        gap * (toolbar.children.length - 1);
      const requiredWidth = currentWidth + (showEditLabel ? 0 : labelSpace);
      setShowEditLabel(requiredWidth <= header.clientWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, [
    showEditLabel,
    mediaLabels.edit,
    activeAsset.type,
    activeAsset.livePhotoVideoId,
    isPlayingLivePhoto,
  ]);
  const [isDownloading, setIsDownloading] = React.useState(false);
  const downloadProgressRef = React.useRef<number>(0);
  const [downloadProgress, setDownloadProgress] = React.useState<number | null>(null);
  const [shareProgress, setShareProgress] = React.useState<number | null>(null);
  const [cacheRefreshNonce, setCacheRefreshNonce] = React.useState(0);
  const [isRemovingOriginal, setIsRemovingOriginal] = React.useState(false);
  const [removalConfirmation, setRemovalConfirmation] = React.useState<{
    assetId: string;
    fileName: string;
  } | null>(null);
  const [localRemovalError, setLocalRemovalError] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const activeStillSrc = isThumbnailCached(activeAsset.id) ?? incomingStillSrc;
  const editState = React.useSyncExternalStore(subscribeMediaEditState, getMediaEditState);
  const originalId = activeAsset.stackOriginalId ?? activeAsset.id;
  const editImport = editState.imports[originalId];
  const editing = editState.phase !== "idle";
  const sessionAsset =
    editState.assetIds.includes(activeAsset.id) || editState.assetIds.includes(originalId);

  const assetState = useAssetState({
    activeAsset,
    activeStillSrc,
    activeFullsizeStillSrc,
    zoom,
    isPlayingLivePhoto,
    activeSrc,
    isLoadingActiveMedia: isVideoAsset(activeAsset) && activeSrc === null,
    cacheRefreshNonce,
  });

  const handleStatusBadgeDownload = async () => {
    if (isRemovingOriginal) return;
    setDownloadError(null);
    try {
      const settings = await getSettings();
      const destinationFolder = settings.userLocalFolderPath.trim();
      if (!destinationFolder) {
        console.warn("[PhotoGridFullscreenOverlay] Local folder not configured for download");
        return;
      }

      // When the full-resolution copy already exists locally, the badge acts as
      // an "Open in File Explorer" button instead of re-downloading.
      if (assetState.isFullResCached) {
        const details = await getCachedAssetDetails(activeAsset.id);
        const localPath = details?.localSavedPath;
        const folder = localPath?.replace(/[/\\][^/\\]+$/, "");
        await openFolderInFileExplorer(folder || destinationFolder);
        return;
      }

      setIsDownloading(true);
      setDownloadProgress(0);
      downloadProgressRef.current = 0;

      // Listen for real byte-level download progress emitted by the backend for
      // this specific asset. The backend streams the original to disk and
      // reports downloaded/total bytes as chunks arrive.
      const unlisten = await listen<{
        assetId: string;
        downloadedBytes: number;
        totalBytes: number | null;
        percent: number | null;
      }>("asset_download_progress", (event) => {
        if (event.payload.assetId !== activeAsset.id) {
          return;
        }
        if (event.payload.percent !== null) {
          downloadProgressRef.current = event.payload.percent;
          setDownloadProgress(event.payload.percent);
        }
      });

      try {
        // Copy the original file, with cached fallback if original is unavailable
        const result = await copyAssetsToLocalFolder(
          [activeAsset.id],
          destinationFolder,
          false,
          true,
        );
        if (result.copiedOriginalCount === 0) {
          throw new Error("The original could not be downloaded");
        }
      } finally {
        unlisten();
      }

      setDownloadProgress(100);

      setCacheRefreshNonce((value) => value + 1);
      console.info("[asset-status:download] refreshing saved-file status", {
        assetId: activeAsset.id,
      });

      // Clear progress after a short delay
      setTimeout(() => {
        setDownloadProgress(null);
        setIsDownloading(false);
      }, 500);
    } catch (error) {
      console.error("[PhotoGridFullscreenOverlay] Download failed:", error);
      setDownloadError(String(error));
      setDownloadProgress(null);
      setIsDownloading(false);
    }
  };

  const handleRemoveLocalOriginal = async (assetId = activeAsset.id, allowUnverified = false) => {
    if (isRemovingOriginal || isDownloading) {
      console.warn("[local-original:remove] action already busy", { assetId: activeAsset.id });
      return;
    }
    if (moreMenuRef.current) moreMenuRef.current.open = false;
    setIsRemovingOriginal(true);
    setLocalRemovalError(null);
    console.info("[local-original:remove] verifying backup", { assetId });
    try {
      const result = await removeLocalOriginal(assetId, allowUnverified);
      console.info("[local-original:remove] verification result", { assetId, ...result });
      if (result.confirmationRequired) {
        setRemovalConfirmation({
          assetId,
          fileName: activeAsset.originalFileName,
        });
        return;
      }
      if (!result.confirmationRequired) {
        setRemovalConfirmation(null);
        onLocalOriginalRemoved(assetId);
        setCacheRefreshNonce((value) => value + 1);
      }
    } catch (error) {
      console.error("[local-original:remove] failed", { assetId, error });
      setLocalRemovalError(String(error));
      setRemovalConfirmation(null);
      setCacheRefreshNonce((value) => value + 1);
    } finally {
      setIsRemovingOriginal(false);
    }
  };

  return (
    <div
      className="group fixed inset-0 z-9999 flex items-center justify-center bg-black p-6"
      role="dialog"
      aria-modal="true"
      aria-label={activeAsset.originalFileName}
    >
      <div aria-hidden="true" data-tauri-drag-region className="absolute inset-x-0 top-0 h-16" />
      <div
        data-tauri-drag-region
        className={`absolute inset-x-4 top-0 z-40 flex min-h-16 flex-wrap items-center gap-2 py-3 ${mac ? "pl-20" : ""}`}
      >
        <button
          type="button"
          className="btn btn-circle btn-sm btn-ghost shrink-0 border border-white/15 bg-zinc-900 text-white"
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
          data-tauri-drag-region
          className="pointer-events-auto min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm font-medium text-white/95 select-none"
          title={activeAsset.originalFileName}
          onClick={(event) => event.stopPropagation()}
        >
          {activeAsset.originalFileName}
        </div>

        {removalConfirmation && (
          <LocalOriginalRemovalDialog
            fileName={removalConfirmation.fileName}
            busy={isRemovingOriginal}
            onConfirm={() => void handleRemoveLocalOriginal(removalConfirmation.assetId, true)}
            onClose={() => {
              console.info("[local-original:remove] cancelled", {
                assetId: removalConfirmation.assetId,
              });
              setRemovalConfirmation(null);
            }}
          />
        )}

        <div
          ref={toolbarRef}
          data-tauri-drag-region
          className="pointer-events-auto ml-auto flex max-w-full flex-wrap items-center justify-end gap-1 sm:gap-2"
        >
          {!isVideoAsset(activeAsset) ? (
            <>
              <div onClick={(event) => event.stopPropagation()}>
                <ZoomControl zoomLevel={zoom} onZoomChange={onZoomChange} />
              </div>
              <div aria-hidden="true" className="h-4 w-px bg-white/25" />
            </>
          ) : null}

          <SelectionActions
            selectedAssetIds={[activeAsset.id]}
            selectedCount={1}
            variant="preview"
            modalZIndexClass="z-[10010]"
            stopPropagation
            disableCopy={isVideoAsset(activeAsset)}
            onCopyProgress={setShareProgress}
            showTimeButton={false}
          />
          <div aria-hidden="true" className="h-4 w-px bg-white/25" />
          {!isVideoAsset(activeAsset) && (
            <button
              type="button"
              className="btn btn-sm btn-ghost border border-white/15 bg-zinc-900 text-white"
              aria-label={mediaLabels.edit}
              aria-busy={sessionAsset && editing}
              disabled={editing || !!editImport}
              title={mediaLabels.edit}
              onClick={(event) => {
                event.stopPropagation();
                requestMediaEdit([activeAsset.id]);
              }}
            >
              {sessionAsset && editing ? (
                <span className="loading loading-spinner loading-xs" aria-hidden="true" />
              ) : (
                <Pencil size={16} />
              )}
              <span
                ref={editLabelRef}
                className={showEditLabel ? "" : "pointer-events-none absolute invisible"}
                aria-hidden={!showEditLabel}
              >
                {mediaLabels.edit}
              </span>
            </button>
          )}

          <button
            type="button"
            className={`btn btn-sm btn-ghost border border-white/15 ${showInfoPanel ? "bg-white text-black hover:bg-white" : "bg-zinc-900 text-white"}`}
            aria-label={t("photoGrid.toggleInfoAria")}
            aria-pressed={showInfoPanel}
            title={t("photoGrid.info")}
            onClick={(event) => {
              event.stopPropagation();
              onToggleInfoPanel();
            }}
          >
            <Info size={16} />
            <span className="hidden lg:inline">{t("photoGrid.info")}</span>
          </button>

          <details
            ref={moreMenuRef}
            className="dropdown dropdown-end"
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget) && moreMenuRef.current)
                moreMenuRef.current.open = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && moreMenuRef.current) {
                event.stopPropagation();
                moreMenuRef.current.open = false;
                moreMenuRef.current.querySelector("summary")?.focus();
              }
            }}
          >
            <summary
              className="btn btn-square btn-sm btn-ghost text-white hover:bg-white/10"
              aria-label={t("photoGrid.moreActionsAria")}
              aria-busy={isRemovingOriginal}
            >
              {isRemovingOriginal ? (
                <span className="loading loading-spinner loading-xs" aria-hidden="true" />
              ) : (
                <MoreHorizontal size={18} />
              )}
            </summary>
            <ul
              className="menu dropdown-content z-[10010] mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-1 text-base-content shadow-xl"
              onPointerDown={(event) => {
                // Safari does not focus buttons on click; preserve summary focus until the action runs.
                event.preventDefault();
              }}
            >
              {assetState.isFullResCached && (
                <li>
                  <button
                    type="button"
                    disabled={isRemovingOriginal || isDownloading}
                    onClick={() => void handleRemoveLocalOriginal()}
                  >
                    {isRemovingOriginal ? (
                      <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                    ) : (
                      <HardDrive size={16} />
                    )}
                    {t("photoGrid.removeLocalOriginal")}
                  </button>
                </li>
              )}
              {activeAsset.livePhotoVideoId && isPlayingLivePhoto && (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      if (moreMenuRef.current) moreMenuRef.current.open = false;
                      onSetIsPlayingLivePhoto(false);
                    }}
                  >
                    <CirclePlay size={16} />
                    {t("photoGrid.playLiveAgainAria")}
                  </button>
                </li>
              )}
              <li>
                <button
                  type="button"
                  onClick={() => {
                    if (moreMenuRef.current) moreMenuRef.current.open = false;
                    requestFixTime([activeAsset.id]);
                  }}
                >
                  <Clock size={14} /> {timeLabels("updateTime")}
                </button>
              </li>
            </ul>
          </details>
        </div>
      </div>

      {(localRemovalError || downloadError) && (
        <div role="alert" className="alert alert-error absolute bottom-28 z-[10020] max-w-lg">
          <span>
            {localRemovalError
              ? `${t("photoGrid.removeLocalOriginalFailed")}: ${localRemovalError}`
              : downloadError}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setLocalRemovalError(null);
              setDownloadError(null);
            }}
          >
            {t("photoGrid.backAria")}
          </button>
        </div>
      )}

      <div
        className={`pointer-events-none flex h-full w-full items-stretch gap-4 ${mac ? "pt-40 lg:pt-20" : "pt-28 lg:pt-16"}`}
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
            className="pointer-events-auto relative flex min-h-0 w-full flex-1 items-center justify-center px-12"
          >
            {editImport?.previewSrc ? (
              <img
                src={editImport.previewSrc}
                alt={mediaLabels.editPreview}
                className="max-h-full max-w-full object-contain"
                onError={() =>
                  console.error(
                    `[media:edit-import] optimistic preview unavailable original=${originalId}`,
                  )
                }
              />
            ) : isVideoAsset(activeAsset) ? (
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
                <div className="flex flex-col items-center gap-2 text-sm text-white/80">
                  <div className="flex items-center gap-2">
                    <span className="loading loading-spinner loading-sm" />
                    {t("photoGrid.loadingVideo")}
                  </div>
                  <p className="max-w-xs text-center text-xs text-white/60">
                    {t("photoGrid.loadingVideoHint")}
                  </p>
                  {assetState.videoDownloadProgress !== null ? (
                    <div className="h-1.5 w-48 overflow-hidden rounded-full bg-white/20">
                      <div
                        className="h-full bg-white/70 transition-all duration-300"
                        style={{ width: `${assetState.videoDownloadProgress}%` }}
                      />
                    </div>
                  ) : null}
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
            <EditImportPill originalId={originalId} />
          </div>

          <div className="pointer-events-auto mx-auto w-full max-w-5xl [&_svg]:text-white/80! [&_.fill-warning]:fill-white/80! [&_.fill-error]:fill-white/80!">
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
            downloadStatus={
              <AssetStatusBadge
                assetState={assetState}
                onDownloadClick={handleStatusBadgeDownload}
                downloadProgress={downloadProgress}
                shareProgress={shareProgress}
                className="w-full"
              />
            }
          />
        ) : null}
      </div>
    </div>
  );
}
