import { useEffect, useRef, useState } from "react";
import { getEditVersions } from "../../api/media";
import { getCachedAssetDetails } from "../../api/tauri";
import { ASSETS_TIME_SHIFTED_EVENT } from "../../api/time";
import type { AssetCacheDetails, AssetSummary } from "../../types";

export const OPEN_VERSION_EVENT = "media:open-version";

function summaryFromDetails(details: AssetCacheDetails): AssetSummary {
  return {
    id: details.id,
    originalFileName: details.originalFileName,
    fileCreatedAt: details.fileCreatedAt,
    checksum: details.checksum,
    type: details.type,
    duration: details.duration,
    livePhotoVideoId: null,
    isFavorite: false,
    isArchived: false,
    visibility: null,
    rating: null,
    width: details.width,
    height: details.height,
    thumbhash: null,
  };
}

/** Resolves a version asset from the local cache, falling back to the stack's versions. */
async function resolveVersionAsset(assetId: string): Promise<AssetSummary | null> {
  const versions = await getEditVersions(assetId);
  const version = versions.find((asset) => asset.id === assetId);
  if (version) return version;
  const cached = await getCachedAssetDetails(assetId).catch((error) => {
    console.warn(`[PhotoGrid.openVersion] cache lookup failed asset=${assetId}`, error);
    return null;
  });
  if (cached) return summaryFromDetails(cached);
  return null;
}

/**
 * Handles window events that target the grid from outside:
 * - `media:open-version` opens a stack version in the lightbox, even when it
 *   is not part of the loaded page (it is appended as an extra lightbox asset).
 * - `immich:assets-time-shifted` bumps a nonce so full layouts are reloaded.
 */
export function usePhotoGridExternalEvents(
  displayAssets: AssetSummary[],
  openAsset: (assetId: string, assets: AssetSummary[]) => void,
) {
  const [extraLightboxAsset, setExtraLightboxAsset] = useState<AssetSummary | null>(null);
  const [layoutRefreshNonce, setLayoutRefreshNonce] = useState(0);
  const displayAssetsRef = useRef(displayAssets);
  displayAssetsRef.current = displayAssets;
  const openAssetRef = useRef(openAsset);
  openAssetRef.current = openAsset;

  useEffect(() => {
    let disposed = false;
    const onOpenVersion = (event: Event) => {
      const assetId = (event as CustomEvent<{ assetId?: string }>).detail?.assetId;
      if (!assetId) return;
      const current = displayAssetsRef.current;
      if (current.some((asset) => asset.id === assetId)) {
        console.info(`[PhotoGrid.openVersion] open loaded asset=${assetId}`);
        setExtraLightboxAsset(null);
        openAssetRef.current(assetId, current);
        return;
      }
      void resolveVersionAsset(assetId)
        .then((asset) => {
          if (disposed) return;
          if (!asset) {
            console.warn(`[PhotoGrid.openVersion] asset not found asset=${assetId}`);
            return;
          }
          console.info(`[PhotoGrid.openVersion] open extra asset=${assetId}`);
          setExtraLightboxAsset(asset);
          openAssetRef.current(assetId, [...displayAssetsRef.current, asset]);
        })
        .catch((error) => console.error(`[PhotoGrid.openVersion] failed asset=${assetId}`, error));
    };
    const onTimeShifted = () => setLayoutRefreshNonce((value) => value + 1);
    window.addEventListener(OPEN_VERSION_EVENT, onOpenVersion);
    window.addEventListener(ASSETS_TIME_SHIFTED_EVENT, onTimeShifted);
    return () => {
      disposed = true;
      window.removeEventListener(OPEN_VERSION_EVENT, onOpenVersion);
      window.removeEventListener(ASSETS_TIME_SHIFTED_EVENT, onTimeShifted);
    };
  }, []);

  return { extraLightboxAsset, setExtraLightboxAsset, layoutRefreshNonce };
}
