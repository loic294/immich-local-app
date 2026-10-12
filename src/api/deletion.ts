import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary, Settings } from "../types";

export type DeleteBehavior = Settings["deleteBehavior"];
export const ASSET_DELETION_CHANGED_EVENT = "assets:deletion-changed";
function notify(asset: AssetSummary) {
  window.dispatchEvent(new CustomEvent(ASSET_DELETION_CHANGED_EVENT, { detail: asset }));
  return asset;
}
async function notifyDeleted(asset: AssetSummary) {
  if (asset.stackOriginalId && asset.stackOriginalId !== asset.id) {
    try {
      const versions = await invoke<AssetSummary[]>("get_edit_versions", {
        assetId: asset.stackOriginalId,
      });
      const original = versions.find((version) => version.id === asset.stackOriginalId);
      if (original)
        window.dispatchEvent(
          new CustomEvent("media:versions-changed", {
            detail: {
              deletedAssetId: asset.id,
              sourceAssetId: asset.id,
              original,
              remainingCount: versions.length,
            },
          }),
        );
    } catch (error) {
      console.warn("[assets.delete] could not refresh edited-version fallback", error);
    }
  }
  return notify(asset);
}
export const deleteAsset = async (assetId: string) =>
  notifyDeleted(await invoke<AssetSummary>("delete_asset", { assetId }));
export const restoreDeletedAsset = async (assetId: string, mode: DeleteBehavior) =>
  notify(await invoke<AssetSummary>("restore_deleted_asset", { assetId, mode }));
export const refreshDeletedAssets = (mode: DeleteBehavior) =>
  invoke<void>("refresh_deleted_assets", { mode });

async function applySelected(ids: string[], operation: (id: string) => Promise<AssetSummary>) {
  const errors: string[] = [];
  // Preserve the user's action order in the offline queue and finish partial batches.
  for (const id of ids) {
    try {
      await operation(id);
    } catch (error) {
      errors.push(`${id}: ${String(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

export const deleteAssets = (ids: string[]) => applySelected(ids, deleteAsset);
export const restoreDeletedAssets = (ids: string[], mode: DeleteBehavior) =>
  applySelected(ids, (id) => restoreDeletedAsset(id, mode));
