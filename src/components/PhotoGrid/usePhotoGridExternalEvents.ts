import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { getEditVersions } from "../../api/media";
import { ASSETS_TIME_SHIFTED_EVENT } from "../../api/time";
import type { AssetSummary } from "../../types";

export const OPEN_VERSION_EVENT = "media:open-version";

interface OpenVersionDetail {
  assetId: string;
  sourceAssetId?: string;
  asset?: AssetSummary;
  original?: AssetSummary;
}

interface VersionsChangedDetail {
  deletedAssetId: string;
  sourceAssetId: string;
  original: AssetSummary;
  remainingCount: number;
}

/**
 * Keeps stack selections separate from layout inputs: a version replaces the
 * image in its existing slot, never the timeline order, dimensions, or dates.
 */
export function usePhotoGridExternalEvents(
  displayAssets: AssetSummary[],
  activeIndex: number | null,
  openSlot: (index: number) => void,
) {
  const [versionAssetsBySlotId, setVersionAssetsBySlotId] = useState<Record<string, AssetSummary>>(
    {},
  );
  const [layoutRefreshNonce, setLayoutRefreshNonce] = useState(0);
  const lightboxAssets = useMemo(
    () => displayAssets.map((asset) => versionAssetsBySlotId[asset.id] ?? asset),
    [displayAssets, versionAssetsBySlotId],
  );
  const activeAsset = activeIndex === null ? null : lightboxAssets[activeIndex];
  const versions = useQuery({
    queryKey: ["edit-versions", activeAsset?.id],
    queryFn: () => getEditVersions(activeAsset!.id),
    enabled: !!activeAsset,
  });
  const knownVersions = useRef(new Map<string, { ids: Set<string>; updatedAt: number }>());
  const latest = useRef({ displayAssets, lightboxAssets, activeIndex, openSlot });
  latest.current = { displayAssets, lightboxAssets, activeIndex, openSlot };

  useEffect(() => {
    let disposed = false;
    let request = 0;
    const replaceVersion = (detail: OpenVersionDetail, asset: AssetSummary) => {
      const current = latest.current;
      if (current.activeIndex === null) return;
      const originalId = detail.original?.id ?? asset.stackOriginalId ?? asset.id;
      const index = current.displayAssets.findIndex(
        (slot, slotIndex) =>
          slot.id === detail.sourceAssetId ||
          current.lightboxAssets[slotIndex].id === detail.sourceAssetId ||
          slot.id === originalId ||
          slot.stackOriginalId === originalId ||
          current.lightboxAssets[slotIndex].stackOriginalId === originalId,
      );
      if (index < 0) {
        console.warn(
          `[PhotoGrid.versions] no timeline slot asset=${asset.id} original=${originalId}`,
        );
        return;
      }
      const slotId = current.displayAssets[index].id;
      console.info(`[PhotoGrid.versions] replace slot=${slotId} asset=${asset.id}`);
      setVersionAssetsBySlotId((previous) => ({
        ...previous,
        [slotId]: { ...asset, stackOriginalId: originalId },
      }));
      current.openSlot(index);
    };
    const onOpenVersion = (event: Event) => {
      const detail = (event as CustomEvent<OpenVersionDetail>).detail;
      if (!detail?.assetId) return;
      const token = ++request;
      const loadedAsset =
        detail.asset ??
        latest.current.lightboxAssets.find((asset) => asset.id === detail.assetId) ??
        latest.current.displayAssets.find((asset) => asset.id === detail.assetId);
      if (loadedAsset) {
        replaceVersion(detail, loadedAsset);
        return;
      }
      void getEditVersions(detail.assetId)
        .then((assets) => {
          if (disposed || token !== request) return;
          const asset = assets.find((item) => item.id === detail.assetId);
          if (asset) replaceVersion(detail, asset);
          else console.warn(`[PhotoGrid.versions] missing asset=${detail.assetId}`);
        })
        .catch((error) =>
          console.error(`[PhotoGrid.versions] lookup failed asset=${detail.assetId}`, error),
        );
    };
    const onVersionsChanged = (event: Event) => {
      const detail = (event as CustomEvent<VersionsChangedDetail>).detail;
      if (!detail?.original || !detail.deletedAssetId) return;
      ++request;
      const current = latest.current;
      setVersionAssetsBySlotId((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([slotId, asset]) => [
            slotId,
            asset.stackOriginalId === detail.original.id
              ? { ...asset, stackCount: detail.remainingCount }
              : asset,
          ]),
        ),
      );
      const index = current.lightboxAssets.findIndex((asset) => asset.id === detail.deletedAssetId);
      if (index >= 0) {
        replaceVersion(
          {
            assetId: detail.original.id,
            sourceAssetId: detail.sourceAssetId,
            original: detail.original,
          },
          { ...detail.original, stackCount: detail.remainingCount },
        );
      }
    };
    const onTimeShifted = () => setLayoutRefreshNonce((value) => value + 1);
    window.addEventListener(OPEN_VERSION_EVENT, onOpenVersion);
    window.addEventListener("media:versions-changed", onVersionsChanged);
    window.addEventListener(ASSETS_TIME_SHIFTED_EVENT, onTimeShifted);
    return () => {
      disposed = true;
      window.removeEventListener(OPEN_VERSION_EVENT, onOpenVersion);
      window.removeEventListener("media:versions-changed", onVersionsChanged);
      window.removeEventListener(ASSETS_TIME_SHIFTED_EVENT, onTimeShifted);
    };
  }, []);

  useEffect(() => {
    if (!versions.data || !activeAsset) return;
    // The local command returns edits newest-first and the protected original last.
    const original = versions.data[versions.data.length - 1];
    const originalId = original?.id ?? activeAsset.stackOriginalId ?? activeAsset.id;
    const previous = knownVersions.current.get(originalId);
    // Switching query keys can expose an older cached stack before it refetches.
    if (previous && versions.dataUpdatedAt < previous.updatedAt) return;
    knownVersions.current.set(originalId, {
      ids: new Set(versions.data.map((asset) => asset.id)),
      updatedAt: versions.dataUpdatedAt,
    });
    if (!original || !previous) return;
    const newEdit = versions.data.find(
      (asset) => asset.id !== original.id && !previous.ids.has(asset.id),
    );
    if (!newEdit) return;
    console.info(`[PhotoGrid.versions] new edit asset=${newEdit.id} original=${original.id}`);
    window.dispatchEvent(
      new CustomEvent(OPEN_VERSION_EVENT, {
        detail: { assetId: newEdit.id, sourceAssetId: activeAsset.id, asset: newEdit, original },
      }),
    );
  }, [activeAsset, versions.data, versions.dataUpdatedAt]);

  return { lightboxAssets, versionAssetsBySlotId, layoutRefreshNonce };
}
