import { useEffect, useState } from "react";
import type { AssetSummary } from "../types";
import { getCachedAssetDetails } from "../api/tauri";
import { isVideoAsset } from "../components/PhotoGrid/photoGridUtils";
import { useConnection } from "./useConnection";

export type AssetStateStatus = {
  isOnline: boolean | null;
  isPreviewLoading: boolean;
  isFullResLoading: boolean;
  isPreviewCached: boolean;
  isFullResCached: boolean;
  videoDownloadProgress: number | null;
  fullResDownloadProgress: number | null;
  mediaType: "image" | "video";
};

interface UseAssetStateProps {
  activeAsset: AssetSummary | null;
  activeStillSrc: string | null;
  activeFullsizeStillSrc: string | null;
  zoom: number;
  isPlayingLivePhoto: boolean;
  activeSrc: string | null;
  isLoadingActiveMedia: boolean;
}

/**
 * Centralized asset state tracking for fullscreen viewers.
 * Combines online/offline status, loading states, and cache detection
 * to determine the current status of an asset (preview/full-resolution).
 *
 * Returns state object with `isOnline`, `isPreviewLoading`, `isFullResLoading`,
 * `isPreviewCached`, `isFullResCached`, `videoDownloadProgress`, and `mediaType`.
 */
export function useAssetState({
  activeAsset,
  activeStillSrc,
  activeFullsizeStillSrc,
  zoom,
  isPlayingLivePhoto,
  activeSrc,
  isLoadingActiveMedia,
}: UseAssetStateProps): AssetStateStatus {
  const { isOnline } = useConnection({ enabled: !!activeAsset });
  const [state, setState] = useState<AssetStateStatus>({
    isOnline: null,
    isPreviewLoading: false,
    isFullResLoading: false,
    isPreviewCached: false,
    isFullResCached: false,
    videoDownloadProgress: null,
    fullResDownloadProgress: null,
    mediaType: "image",
  });

  // Determine media type
  useEffect(() => {
    if (!activeAsset) {
      setState((prev) => ({
        ...prev,
        mediaType: "image",
      }));
      return;
    }

    const mediaType = isVideoAsset(activeAsset) ? "video" : "image";
    setState((prev) => ({
      ...prev,
      mediaType,
    }));
  }, [activeAsset]);

  // Track online/offline state
  useEffect(() => {
    setState((prev) => ({
      ...prev,
      isOnline,
    }));
  }, [isOnline]);

  // Determine preview loading state
  useEffect(() => {
    if (!activeAsset || isVideoAsset(activeAsset)) {
      setState((prev) => ({
        ...prev,
        isPreviewLoading: false,
      }));
      return;
    }

    // Preview is loading if we have an active asset but no thumbnail yet
    const isLoading = activeStillSrc === null && activeAsset !== null;
    setState((prev) => ({
      ...prev,
      isPreviewLoading: isLoading,
    }));
  }, [activeAsset, activeStillSrc]);

  // Determine full-resolution loading state
  useEffect(() => {
    if (!activeAsset || isVideoAsset(activeAsset) || activeAsset.livePhotoVideoId) {
      setState((prev) => ({
        ...prev,
        isFullResLoading: false,
      }));
      return;
    }

    // Full-res is loading only when zoomed in AND we don't have it cached yet
    const needsFullRes = zoom > 100;
    const isLoading = needsFullRes && !state.isFullResCached && activeFullsizeStillSrc === null;
    setState((prev) => ({
      ...prev,
      isFullResLoading: isLoading,
    }));
  }, [activeAsset, zoom, activeFullsizeStillSrc, state.isFullResCached]);

  // Query database for cache status
  useEffect(() => {
    if (!activeAsset) {
      setState((prev) => ({
        ...prev,
        isPreviewCached: false,
        isFullResCached: false,
      }));
      return;
    }

    const asset = activeAsset;
    let cancelled = false;

    async function checkCacheStatus() {
      try {
        const details = await getCachedAssetDetails(asset.id);
        const previewLocal = details?.previewLocal === true;
        const thumbnailLocal = details?.thumbnailLocal === true;
        const fullResolutionLocal = details?.fullResolutionLocal === true;

        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            isPreviewCached: activeStillSrc !== null || previewLocal || thumbnailLocal,
            // Full-res is cached if loaded in-view OR known as locally saved in DB.
            isFullResCached: activeFullsizeStillSrc !== null || fullResolutionLocal,
          }));
        }
      } catch (error) {
        console.log("[useAssetState] Failed to check cache status:", error);
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            isPreviewCached: activeStillSrc !== null,
            isFullResCached: activeFullsizeStillSrc !== null,
          }));
        }
      }
    }

    void checkCacheStatus();

    return () => {
      cancelled = true;
    };
  }, [activeAsset, activeStillSrc, activeFullsizeStillSrc]);

  // Track video download progress (placeholder for now)
  // This will be populated by actual video download tracking in the future
  useEffect(() => {
    if (!activeAsset || !isVideoAsset(activeAsset)) {
      setState((prev) => ({
        ...prev,
        videoDownloadProgress: null,
      }));
      return;
    }

    // If actively loading the video
    if (isLoadingActiveMedia && activeSrc === null) {
      // Will be set to actual progress value when integrated with video download tracking
      setState((prev) => ({
        ...prev,
        videoDownloadProgress: null, // Will be set to 0-100 when integrated
      }));
    } else if (activeSrc !== null) {
      // Video has loaded
      setState((prev) => ({
        ...prev,
        videoDownloadProgress: null,
      }));
    }
  }, [activeAsset, isLoadingActiveMedia, activeSrc]);

  // Track full-resolution image download progress during zoom
  useEffect(() => {
    // Full-res loading only applies to images (not videos), and only when zoom > 100
    const needsFullRes = activeAsset && !isVideoAsset(activeAsset) && zoom > 100;
    const isDownloading = needsFullRes && !state.isFullResCached && activeFullsizeStillSrc === null;

    if (!isDownloading) {
      setState((prev) => ({
        ...prev,
        fullResDownloadProgress: null,
      }));
      return;
    }

    // Animate progress from 10% to 90% while loading
    setState((prev) => ({
      ...prev,
      fullResDownloadProgress: 10,
    }));

    const interval = setInterval(() => {
      setState((prev) => {
        if (!prev.fullResDownloadProgress) return prev;
        const nextProgress = Math.min(prev.fullResDownloadProgress + Math.random() * 30, 90);
        return {
          ...prev,
          fullResDownloadProgress: nextProgress,
        };
      });
    }, 300);

    return () => clearInterval(interval);
  }, [activeAsset, zoom, activeFullsizeStillSrc, state.isFullResCached]);

  // When full-res successfully loads, show 100% and then clear
  useEffect(() => {
    if (!activeAsset) {
      return;
    }

    if (isVideoAsset(activeAsset) || activeFullsizeStillSrc === null) {
      return;
    }

    setState((prev) => ({
      ...prev,
      fullResDownloadProgress: 100,
    }));

    // Clear progress after a short delay
    const timer = setTimeout(() => {
      setState((prev) => ({
        ...prev,
        fullResDownloadProgress: null,
      }));
    }, 500);

    return () => clearTimeout(timer);
  }, [activeAsset, activeFullsizeStillSrc]);

  return state;
}
