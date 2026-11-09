import { useRef, type Dispatch, type SetStateAction } from "react";
import { updateAssetFavorite } from "../../api/tauri";
import { toast } from "../../toasts/toast";
import type { AssetSummary } from "../../types";
import { favoriteResultToasts } from "../../utils/favoriteToasts";

type AssetOverrides = Record<string, Partial<AssetSummary>>;

interface UseSelectionFavoriteOptions {
  selectedAssetIds: ReadonlySet<string>;
  assetsById: ReadonlyMap<string, AssetSummary>;
  setAssetOverrides: Dispatch<SetStateAction<AssetOverrides>>;
}

const FAVORITE_BATCH_SIZE = 8;

/**
 * Returns a function that favorites the current selection, or removes the favorite when every
 * selected photo already has one. The change shows immediately and is rolled back per photo when
 * the update fails; offline updates are queued by the backend like every other asset mutation.
 */
export function useSelectionFavorite({
  selectedAssetIds,
  assetsById,
  setAssetOverrides,
}: UseSelectionFavoriteOptions): () => Promise<void> {
  const busyRef = useRef(false);

  return async () => {
    if (busyRef.current) {
      return;
    }
    const selected = [...selectedAssetIds]
      .map((assetId) => assetsById.get(assetId))
      .filter((asset): asset is AssetSummary => asset !== undefined);
    if (selected.length === 0) {
      return;
    }

    const makeFavorite = !selected.every((asset) => asset.isFavorite);
    const changing = selected.filter((asset) => asset.isFavorite !== makeFavorite);
    busyRef.current = true;
    console.info("[shortcuts] updating favorites for the selection", {
      selected: selected.length,
      changing: changing.length,
      favorite: makeFavorite,
    });

    setAssetOverrides((current) => {
      const next = { ...current };
      for (const asset of changing) {
        next[asset.id] = { ...next[asset.id], isFavorite: makeFavorite };
      }
      return next;
    });

    let failed = 0;
    try {
      for (let start = 0; start < changing.length; start += FAVORITE_BATCH_SIZE) {
        const batch = changing.slice(start, start + FAVORITE_BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((asset) => updateAssetFavorite(asset.id, makeFavorite)),
        );
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            return;
          }
          failed += 1;
          const asset = batch[index];
          console.error("[shortcuts] favorite update failed", {
            assetId: asset.id,
            error: result.reason,
          });
          setAssetOverrides((current) => ({
            ...current,
            [asset.id]: { ...current[asset.id], isFavorite: asset.isFavorite },
          }));
        });
      }
    } finally {
      busyRef.current = false;
      console.info("[shortcuts] favorite update for the selection finished", {
        requested: changing.length,
        failed,
      });
      for (const request of favoriteResultToasts(makeFavorite, changing.length, failed)) {
        toast.push(request);
      }
    }
  };
}
