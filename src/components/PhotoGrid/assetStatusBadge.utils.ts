import { CloudAlert, CloudSync, CloudDownload, Check } from "lucide-react";
import type { ComponentType } from "react";
import type { AssetStateStatus } from "../../hooks/useAssetState";

export interface BadgeContent {
  icon: ComponentType<any>;
  title: string;
  subtitle: string;
  isClickable: boolean;
  iconColor: string;
  /** Solid background color for the icon circle (icon itself is white). */
  circleColor: string;
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
      icon: Check,
      title: t("photoGrid.assetStatus.fullResLoaded"),
      subtitle: t("photoGrid.assetStatus.fullResLoadedSubtitle"),
      isClickable: true,
      iconColor: "text-success",
      circleColor: "bg-success",
    };
  }

  // 2. Offline + no preview cached → image unavailable
  if (isOnline === false && !isPreviewCached) {
    return {
      icon: CloudAlert,
      title: t("photoGrid.assetStatus.unavailable"),
      subtitle: t("photoGrid.assetStatus.unavailableSubtitle"),
      isClickable: false,
      iconColor: "text-warning",
      circleColor: "bg-warning",
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
        circleColor: "bg-info",
      };
    }
    return {
      icon: CloudSync,
      title: t("photoGrid.assetStatus.downloadingPreview"),
      subtitle: t("photoGrid.assetStatus.downloadingPreviewSubtitle"),
      isClickable: false,
      iconColor: "text-info",
      circleColor: "bg-info",
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
      circleColor: "bg-info",
    };
  }

  // 5. Offline + preview cached → can't download full-res
  if (isOnline === false && isPreviewCached) {
    return {
      icon: CloudDownload,
      title: t("photoGrid.assetStatus.previewSaved"),
      subtitle: t("photoGrid.assetStatus.offlineCannotDownload"),
      isClickable: false,
      iconColor: "text-warning",
      circleColor: "bg-warning",
    };
  }

  // 6. Online + preview cached (no full-res) → download available
  if (isOnline && isPreviewCached && !isFullResCached) {
    return {
      icon: CloudDownload,
      title: t("photoGrid.assetStatus.previewSaved"),
      subtitle: t("photoGrid.assetStatus.previewSavedSubtitle"),
      isClickable: true,
      iconColor: "text-success",
      circleColor: "bg-success",
    };
  }

  // No status to show
  return null;
}
