import { CloudOff, CloudSync, CloudDownload, CircleCheck, ImageDown, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AssetStateStatus } from "../../hooks/useAssetState";

export interface BadgeContent {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  isClickable: boolean;
  iconColor: string;
}

/**
 * Maps asset state to badge content (icon, text, clickability).
 * Determines which status to display based on online/offline state,
 * loading state, and cache status.
 *
 * Priority order:
 * 1. Offline + no preview cached → unavailable
 * 2. Online + preview loading → downloading preview
 * 3. Online + preview cached (no full-res) → preview saved locally
 * 4. Offline + preview cached → connect to server to download
 * 5. Full-res cached → full-resolution loaded
 */
export function getStatusBadgeContent(
  assetState: AssetStateStatus,
  t: (key: string) => string,
): BadgeContent | null {
  const {
    isOnline,
    isPreviewLoading,
    isFullResLoading,
    isPreviewCached,
    isFullResCached,
    mediaType,
  } = assetState;

  // 1. Full-resolution is cached locally
  if (isFullResCached) {
    return {
      icon: CircleCheck,
      title:
        mediaType === "video"
          ? t("photoGrid.assetStatus.videoSaved")
          : t("photoGrid.assetStatus.fullResLoaded"),
      subtitle: t("photoGrid.assetStatus.fullResLoadedSubtitle"),
      isClickable: true,
      iconColor: "text-success",
    };
  }

  // 2. Offline + no preview cached → image unavailable
  if (isOnline === false && !isPreviewCached) {
    return {
      icon: CloudOff,
      title: t("photoGrid.assetStatus.unavailable"),
      subtitle: t("photoGrid.assetStatus.unavailableSubtitle"),
      isClickable: false,
      iconColor: "text-error",
    };
  }

  // 3. Online + preview loading
  if (isOnline && isPreviewLoading) {
    if (mediaType === "video") {
      return {
        icon: CloudSync,
        title: t("photoGrid.assetStatus.downloadingVideo"),
        subtitle: t("photoGrid.assetStatus.downloadingVideoSubtitle"),
        isClickable: false,
        iconColor: "text-info",
      };
    }
    return {
      icon: CloudSync,
      title: t("photoGrid.assetStatus.downloadingPreview"),
      subtitle: t("photoGrid.assetStatus.downloadingPreviewSubtitle"),
      isClickable: false,
      iconColor: "text-info",
    };
  }

  // 4. Online + full-res loading (zoom > 100)
  if (isOnline && isFullResLoading) {
    return {
      icon: CloudSync,
      title: t("photoGrid.assetStatus.downloadingFullRes"),
      subtitle: t("photoGrid.assetStatus.downloadingFullResSubtitle"),
      isClickable: false,
      iconColor: "text-info",
    };
  }

  // 5. Offline + preview cached → can't download full-res
  if (isOnline === false && isPreviewCached) {
    return {
      icon: WifiOff,
      title: t("photoGrid.assetStatus.previewSaved"),
      subtitle: t("photoGrid.assetStatus.offlineCannotDownload"),
      isClickable: false,
      iconColor: "text-warning",
    };
  }

  // 6. Online + preview cached (no full-res) → download available
  if (isOnline && isPreviewCached && !isFullResCached) {
    return {
      icon: ImageDown,
      title: t("photoGrid.assetStatus.previewSaved"),
      subtitle: t("photoGrid.assetStatus.previewSavedSubtitle"),
      isClickable: true,
      iconColor: "text-info",
    };
  }

  // 7. Online video that isn't saved locally yet → offer to download the original.
  //    Videos don't have a preview-cache concept like images, so without this
  //    branch a loaded video would show no badge at all.
  if (mediaType === "video" && isOnline && !isFullResCached) {
    return {
      icon: CloudDownload,
      title: t("photoGrid.assetStatus.videoReady"),
      subtitle: t("photoGrid.assetStatus.videoReadySubtitle"),
      isClickable: true,
      iconColor: "text-error",
    };
  }

  // No status to show
  return null;
}
